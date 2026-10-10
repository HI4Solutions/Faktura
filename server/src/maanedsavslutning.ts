// Månedsavslutningen går av seg selv (0092_maanedsavslutning.sql). Når en måned er over (fra kl. 08
// den 1., etter morgenhentingen fra banken), bokfører workeren avskrivningene og periodiseringene som
// ikke er bokført til og med måneden (et bilag per måned i serie A og P, som når brukeren bokfører
// dem), lagrer sjekklisten for måneden (bankpostene, utgiftene, lønnen, avskrivningene og
// periodiseringene: det som er ført og det som gjenstår) og varsler eier, administrator og
// regnskapsføreren. Når alle organisasjonene er ferdige, sendes månedsrapportene til
// regnskapsførerne (rapportmodul.ts), så de får med det som ble bokført.
//
// Automatikken bokfører aldri lenger tilbake enn måneden før den gikk første gang
// (regnskap_oppsett.maaned_fra): avskrivninger eller periodiseringer fra før det som ikke er bokført,
// bokfører brukeren (Regnskap → Bilag), og til de er bokført, venter automatikken.
import { frist } from "./amelding.js";
import { avskrivningsforslag, hentAnlegg, hentRegnskapsoppsett, mnd, plussMnd, sisteDag } from "./anlegg.js";
import { kontoavstemming } from "./bankAvstemming.js";
import { alle, en, somSystem, type Db } from "./db.js";
import { maanedNavn } from "./lonnsberegning.js";
import { bokforPeriodiseringer, hentPeriodiseringer, manglerStart, periodiseringsforslag } from "./periodisering.js";
import type { Rapportdef } from "./rapportmodul.js";
import { bokforAvskrivninger } from "./regnskapRuter.js";
import { dato as visDato, kr } from "./regler.js";
import { leggIKo } from "./tjenester.js";

const logg = (severity: string, message: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ severity, message, ...data }));
const osloDato = (d: Date) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(d);
const osloTime = (d: Date) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Oslo", hour: "2-digit", hourCycle: "h23" }).format(d));
const antall = (n: number, en: string, flere: string) => `${n} ${n === 1 ? en : flere}`;
const liste = (x: string[]) => (x.length > 1 ? `${x.slice(0, -1).join(", ")} og ${x.at(-1)}` : (x[0] ?? ""));
const stor = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
// «september 2026», «mars–september 2026» eller «november 2025–januar 2026».
export function perioden(maaneder: string[]) {
  const [f, s] = [maaneder[0]!, maaneder.at(-1)!];
  if (f === s) return maanedNavn(`${f}-01`);
  return f.slice(0, 4) === s.slice(0, 4)
    ? `${maanedNavn(`${f}-01`).replace(/ \d{4}$/, "")}–${maanedNavn(`${s}-01`)}`
    : `${maanedNavn(`${f}-01`)}–${maanedNavn(`${s}-01`)}`;
}
export const forrigeMaaned = (iDag: string) => plussMnd(mnd(iDag), -1);

// ok: ført. venter: ikke ført, men bokføres når måneden er over (denne måneden).
export type Punkt = {
  nokkel: "bank" | "utgifter" | "lonn" | "avskrivninger" | "periodiseringer";
  navn: string;
  ok: boolean;
  venter?: boolean;
  tekst: string;
  lenke: string;
};
export const gjenstar = (p: Punkt) => !p.ok && !p.venter;

// Sjekklisten for måneden (ÅÅÅÅ-MM): det som er ført, og det som gjenstår. Et punkt er bare med når
// organisasjonen brukte det i måneden eller før (bankposter, utgifter, lønn, anleggsmidler eller
// periodiseringer). Avskrivningene og periodiseringene for denne måneden venter til den er over.
export async function maanedsstatus(db: Db, org: string, maaned: string, iDag = osloDato(new Date())): Promise<Punkt[]> {
  const fra = `${maaned}-01`;
  const til = sisteDag(maaned);
  const o = await hentRegnskapsoppsett(db, org);
  const punkter: Punkt[] = [];
  // Det som bare mangler for denne måneden, bokføres når den er over.
  const venter = (mangler: string[]) => maaned >= mnd(iDag) && mangler.length === 1 && mangler[0] === maaned;
  const naar = o.maaned_auto ? "Bokføres av seg selv når måneden er over." : "Kan bokføres når måneden er over.";

  // Bankpostene til og med den siste dagen i måneden (fra startdatoen for banken).
  const bank = await en<{ x: boolean }>(
    db,
    "select exists (select 1 from faktura.bankposter where org_id = $1 and dato <= $2) and ($3::date is null or $3::date <= $2) as x",
    [org, til, o.bank_fra],
  );
  if (bank?.x) {
    const kontoer = await kontoavstemming(db, org, til);
    const apne = kontoer.reduce((n, k) => n + k.apne.antall, 0);
    const uten = kontoer.reduce((n, k) => n + k.uten_post.antall, 0);
    const deler = [
      apne ? `${antall(apne, "bankpost", "bankposter")} er ikke ført` : "",
      uten ? `${antall(uten, "bilag", "bilag")} på bankkontoen er ikke i banken` : "",
      ...kontoer.filter((k) => k.differanse !== null && k.differanse !== 0).map((k) => `differansen er ${kr(k.differanse!)} kr på ${k.navn ? `${k.navn} ` : ""}${k.vis}`),
    ].filter(Boolean);
    punkter.push({
      nokkel: "bank",
      navn: "Bankpostene",
      ok: !deler.length,
      tekst: deler.length
        ? `${stor(liste(deler))}.`
        : kontoer.some((k) => k.saldo !== null && !k.delt)
          ? "Alle bankpostene er ført, og saldoen i banken stemmer med regnskapet."
          : "Alle bankpostene er ført.",
      lenke: "/regnskap?fane=bank",
    });
  }

  // Utgiftene som ikke er bokført (kladdene med dato i måneden eller før, og de uten dato som er lagt inn før månedsslutt).
  const u = await en<{ alle: number; kladder: number }>(
    db,
    `select count(*)::int as alle,
            count(*) filter (where status = 'kladd')::int as kladder
       from faktura.utgifter where org_id = $1 and (dato <= $2 or (dato is null and opprettet < ($2::date + 1)::timestamp at time zone 'Europe/Oslo'))`,
    [org, til],
  );
  if (u && u.alle > 0)
    punkter.push({
      nokkel: "utgifter",
      navn: "Utgiftene",
      ok: u.kladder === 0,
      tekst: u.kladder ? `${antall(u.kladder, "utgift", "utgifter")} er ikke bokført.` : "Utgiftene er bokført.",
      lenke: "/regnskap?fane=utgifter",
    });

  // Lønnen med utbetaling i måneden: godkjent, bokført og levert i a-meldingen.
  const l = await en<{ utkast: number; godkjent: number; ikke_bokfort: number; levert: boolean }>(
    db,
    `select count(*) filter (where k.status = 'utkast')::int as utkast,
            count(*) filter (where k.status = 'godkjent')::int as godkjent,
            count(*) filter (where k.status = 'godkjent' and not exists (
              select 1 from faktura.bilag b where b.org_id = k.org_id and b.kilde = 'lonn' and b.kilde_id = k.id
                 and b.reverserer is null and b.reversert_av is null))::int as ikke_bokfort,
            exists (select 1 from faktura.ameldinger a where a.org_id = $1 and a.maaned = $2::date and a.status in ('levert', 'sendt', 'mottatt')) as levert
       from faktura.lonnskjoringer k where k.org_id = $1 and k.utbetalingsdato between $2 and $3`,
    [org, fra, til],
  );
  if (l && l.utkast + l.godkjent > 0) {
    const f = frist(maaned);
    const deler = [
      l.utkast ? (l.godkjent ? `${antall(l.utkast, "lønnskjøring", "lønnskjøringer")} er ikke godkjent` : "lønnskjøringen er ikke godkjent") : "",
      l.ikke_bokfort ? "lønnen er ikke bokført" : "",
      l.godkjent && !l.levert ? (iDag > f ? `a-meldingen er ikke levert (fristen var ${visDato(f)})` : `a-meldingen er ikke levert ennå (fristen er ${visDato(f)})`) : "",
    ].filter(Boolean);
    punkter.push({
      nokkel: "lonn",
      navn: "Lønnen",
      ok: !deler.length,
      tekst: deler.length ? `${stor(liste(deler))}.` : "Lønnen er godkjent og bokført, og a-meldingen er levert.",
      lenke: l.utkast || l.ikke_bokfort ? "/lonn" : "/lonn?fane=amelding",
    });
  }

  // Avskrivningene og periodiseringene som ikke er bokført til og med måneden.
  const { anlegg, hendelser } = await hentAnlegg(db, org);
  if (anlegg.some((a) => mnd(a.avskrives_fra) <= maaned)) {
    const mangler = avskrivningsforslag(anlegg, hendelser, maaned).map((m) => m.maaned);
    punkter.push({
      nokkel: "avskrivninger",
      navn: "Avskrivningene",
      ok: !mangler.length,
      ...(venter(mangler) ? { venter: true, tekst: naar } : { tekst: mangler.length ? `Avskrivningene for ${perioden(mangler)} er ikke bokført.` : "Avskrivningene er bokført." }),
      lenke: "/regnskap?fane=anlegg",
    });
  }
  const { periodiseringer, poster } = await hentPeriodiseringer(db, org);
  if (periodiseringer.some((p) => mnd(p.fra) <= maaned)) {
    const mangler = periodiseringsforslag(periodiseringer, poster, maaned).map((m) => m.maaned);
    const utenStart = periodiseringer.filter((p) => manglerStart(p, poster) && mnd(p.fra) <= maaned).length;
    const deler = [
      mangler.length ? `periodiseringene for ${perioden(mangler)} er ikke bokført` : "",
      utenStart ? `${antall(utenStart, "periodisering", "periodiseringer")} venter på at starten bokføres` : "",
    ].filter(Boolean);
    punkter.push({
      nokkel: "periodiseringer",
      navn: "Periodiseringene",
      ok: !deler.length,
      ...(!utenStart && venter(mangler) ? { venter: true, tekst: naar } : { tekst: deler.length ? `${stor(liste(deler))}.` : "Periodiseringene er bokført." }),
      lenke: "/regnskap?fane=periodiseringer",
    });
  }
  return punkter;
}

export type Avslutning = {
  maaned: string;
  bilag: { id: string; bilagsnummer: string; tekst: string; sum: number }[];
  sperret: string | null;
  punkter: Punkt[];
};

// Månedsavslutningen for måneden (som systemet): avskrivningene og periodiseringene til og med måneden
// bokføres når ingenting fra før maaned_fra mangler, og sjekklisten.
export async function avsluttMaaned(db: Db, org: string, maaned: string, iDag = osloDato(new Date())): Promise<Avslutning> {
  const o = await hentRegnskapsoppsett(db, org);
  let fra = o.maaned_fra ? mnd(o.maaned_fra) : null;
  if (!fra) {
    fra = maaned;
    await db.query(
      `insert into faktura.regnskap_oppsett (org_id, maaned_fra) values ($1, $2)
       on conflict (org_id) do update set maaned_fra = coalesce(faktura.regnskap_oppsett.maaned_fra, excluded.maaned_fra)`,
      [org, `${maaned}-01`],
    );
  }
  const { anlegg, hendelser } = await hentAnlegg(db, org);
  const { periodiseringer, poster } = await hentPeriodiseringer(db, org);
  const eldste = [avskrivningsforslag(anlegg, hendelser, maaned)[0]?.maaned, periodiseringsforslag(periodiseringer, poster, maaned)[0]?.maaned]
    .filter((m): m is string => !!m)
    .sort()[0];
  let sperret: string | null = null;
  const bilag: Avslutning["bilag"] = [];
  if (eldste && eldste < fra)
    sperret = `Avskrivningene eller periodiseringene for ${maanedNavn(`${eldste}-01`)} er ikke bokført. Bokfør dem under Regnskap → Bilag (månedsavslutningen); da går den av seg selv igjen.`;
  else if (eldste) bilag.push(...(await bokforAvskrivninger(db, org, maaned)), ...(await bokforPeriodiseringer(db, org, maaned)));
  return { maaned, bilag, sperret, punkter: await maanedsstatus(db, org, maaned, iDag) };
}

// Teksten i varselet: det som ble bokført (eller hvorfor ikke), og det som gjenstår.
export function varseltekst(a: Avslutning) {
  const igjen = a.punkter.filter(gjenstar);
  return [
    a.bilag.length ? `Bokført: ${liste(a.bilag.map((b) => b.bilagsnummer))}.` : "",
    a.sperret ? "Avskrivningene og periodiseringene ble ikke bokført av seg selv: noe fra før er ikke bokført." : "",
    igjen.length ? `Gjenstår: ${igjen.map((p) => p.tekst.replace(/\.$/, "").replace(/^./, (c) => c.toLowerCase())).join("; ")}.` : "Alt er ført.",
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 400);
}

// Organisasjonene der månedsavslutningen feilet, med tidspunktet (prøves igjen etter en time).
const feilet = new Map<string, number>();

// Workeren (hvert minutt, fra kl. 08): månedsavslutningen for måneden som er over, for
// organisasjonene med funksjonen «Regnskap» og automatikken på som ikke har fått den. Høyst `maks` om
// gangen; ferdig når ingen gjenstår (da kan månedsrapportene sendes).
export async function avsluttMaanederForAlle(naa = new Date(), maks = 25, org: string | null = null): Promise<{ avsluttet: number; ferdig: boolean }> {
  if (osloTime(naa) < 8) return { avsluttet: 0, ferdig: false };
  const iDag = osloDato(naa);
  const maaned = forrigeMaaned(iDag);
  const igjen = (
    await somSystem((db) =>
      alle<{ id: string }>(
        db,
        `select o.id from faktura.organisasjoner o left join faktura.regnskap_oppsett r on r.org_id = o.id
          where o.slettet_at is null and ($2::uuid is null or o.id = $2) and faktura.har_funksjon(o.id, 'regnskap') and coalesce(r.maaned_auto, true)
            and not exists (select 1 from faktura.maanedsavslutninger m where m.org_id = o.id and m.maaned = $1::date)
          order by o.opprettet`,
        [`${maaned}-01`, org],
      ),
    )
  ).filter((x) => (feilet.get(x.id) ?? 0) < naa.getTime() - 3_600_000);
  let avsluttet = 0;
  for (const { id } of igjen.slice(0, maks)) {
    try {
      const a = await somSystem(async (db) => {
        // Én om gangen per organisasjon (to hjerteslag samtidig bokfører ikke det samme to ganger).
        await db.query("select pg_advisory_xact_lock(hashtext('maanedsavslutning:' || $1))", [id]);
        if (await en(db, "select 1 from faktura.maanedsavslutninger where org_id = $1 and maaned = $2::date", [id, `${maaned}-01`])) return null;
        const a = await avsluttMaaned(db, id, maaned, iDag);
        // Varsel når organisasjonen bruker noe av det månedsavslutningen ser på.
        const varsle = a.bilag.length > 0 || a.sperret !== null || a.punkter.length > 0;
        await db.query(
          `insert into faktura.maanedsavslutninger (org_id, maaned, bilag, punkter, sperret, varslet) values ($1, $2::date, $3::uuid[], $4::jsonb, $5, $6)`,
          [id, `${maaned}-01`, a.bilag.map((b) => b.id), JSON.stringify(a.punkter), a.sperret, varsle],
        );
        return varsle ? a : null;
      });
      avsluttet++;
      feilet.delete(id);
      if (a) {
        const mottakere = await somSystem((db) =>
          alle<{ bruker_id: string }>(db, "select bruker_id from faktura.medlemmer where org_id = $1 and rolle in ('eier', 'admin', 'regnskap')", [id]),
        );
        if (mottakere.length)
          await leggIKo({
            type: "varsel",
            varsel: {
              hendelse: "regnskap",
              org_id: id,
              bruker_ider: mottakere.map((m) => m.bruker_id),
              tittel: `Månedsavslutningen for ${maanedNavn(`${maaned}-01`)}`,
              tekst: varseltekst(a),
              url: "/regnskap?fane=bilag",
              tag: `maanedsavslutning-${maaned}`,
            },
          }).catch((e) => logg("WARNING", "Varselet om månedsavslutningen ble ikke lagt i kø", { org_id: id, feil: (e as Error).message }));
      }
    } catch (e) {
      feilet.set(id, naa.getTime());
      logg("ERROR", "Månedsavslutningen feilet", { org_id: id, maaned, feil: (e as Error).message });
    }
  }
  if (avsluttet) logg("INFO", "Månedsavslutninger", { maaned, avsluttet });
  return { avsluttet, ferdig: igjen.length <= maks && igjen.every((x) => !feilet.has(x.id)) };
}

// Avslutningen som har gått av seg selv for måneden (bilagene med nummer), eller null.
export async function hentAvslutning(db: Db, org: string, maaned: string) {
  return (
    (await en<{ tid: string; sperret: string | null; bilag: { id: string; bilagsnummer: string }[] }>(
      db,
      `select to_char(m.tid at time zone 'Europe/Oslo', 'YYYY-MM-DD"T"HH24:MI') as tid, m.sperret,
              coalesce((select json_agg(json_build_object('id', b.id, 'bilagsnummer', b.serie || '-' || b.aar || '-' || b.nummer) order by b.serie, b.nummer)
                          from faktura.bilag b where b.id = any(m.bilag)), '[]') as bilag
         from faktura.maanedsavslutninger m where m.org_id = $1 and m.maaned = $2::date`,
      [org, `${maaned}-01`],
    )) ?? null
  );
}

// --- Rapporten ------------------------------------------------------------------------------------

export const maanedsavslutningRapporter: Rapportdef[] = [
  {
    id: "regnskap.maanedsavslutning",
    modul: "regnskap",
    navn: "Månedsavslutning",
    beskrivelse:
      "Sjekklisten for hver måned i perioden: bankpostene (ført og avstemt mot saldoen i banken), utgiftene, lønnen (godkjent, bokført og levert i a-meldingen), avskrivningene og periodiseringene, med det som gjenstår. Månedsavslutningen går av seg selv når måneden er over.",
    funksjon: "regnskap",
    tilgang: "regnskap",
    parameter: "periode",
    maanedlig: true,
    hent: async (db, org, v) => {
      const iDag = osloDato(new Date());
      const maaneder: string[] = [];
      for (let m = mnd(v.fra); m <= mnd(v.til) && m <= mnd(iDag); m = plussMnd(m, 1)) maaneder.push(m);
      const rader: Record<string, unknown>[] = [];
      const merknad: string[] = [];
      for (const m of maaneder) {
        const punkter = await maanedsstatus(db, org, m, iDag);
        const a = await hentAvslutning(db, org, m);
        const igjen = punkter.filter(gjenstar).length;
        merknad.push(
          `${stor(maanedNavn(`${m}-01`))}: ${
            a ? `gikk av seg selv ${visDato(a.tid)}${a.bilag.length ? ` (bokført ${liste(a.bilag.map((b) => b.bilagsnummer))})` : ""}` : m < mnd(iDag) ? "ikke avsluttet av seg selv" : "måneden er ikke over"
          }${a?.sperret ? "; avskrivningene og periodiseringene ble ikke bokført (noe fra før mangler)" : ""}; ${igjen ? `${antall(igjen, "punkt gjenstår", "punkter gjenstår")}` : "alt er ført"}.`,
        );
        for (const p of punkter) rader.push({ maaned: maanedNavn(`${m}-01`), punkt: p.navn, status: p.ok ? "Ført" : p.venter ? "Venter" : "Gjenstår", tekst: p.tekst });
      }
      return {
        merknad: maaneder.length ? merknad.join(" ") : "Ingen måneder i perioden.",
        kolonner: [
          { nokkel: "maaned", navn: "Måned", type: "tekst" },
          { nokkel: "punkt", navn: "Punkt" },
          { nokkel: "status", navn: "Status" },
          { nokkel: "tekst", navn: "Hva" },
        ],
        rader,
      };
    },
  },
];
