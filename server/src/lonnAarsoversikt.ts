// Årsoversikten (sammenstillingsoppgaven) til de ansatte (0075_lonn_aarsoversikt.sql):
// arbeidsgiveren skal innen 31. januar gi hver ansatt en oversikt over lønnen og trekket i året.
// Tallene er de godkjente lønnskjøringene med utbetaling i året: lønnen gruppert som i
// a-meldingen (lonnsarter.ts), forskuddstrekket, utgiftene og trekkene etter skatt, det som er
// utbetalt, feriepengegrunnlaget og pensjonen, og tallene fra et tidligere lønnssystem.
//
// Den ansatte ser sin egen (radtilgangen gir bare egne slipper fra godkjente kjøringer); de som
// ser lønnen (personal_les), ser alle og kan laste ned alle i én PDF. Eier og administrator kan
// varsle de ansatte, og den daglige jobben varsler dem med innlogging i januar (én gang per år).

import { Hono, type Context } from "hono";
import { z } from "zod";
import { alle, en, somBruker, somSystem, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { AMELDING_NAVN, lonnsart } from "./lonnsarter.js";
import { rund } from "./lonnsberegning.js";
import { lagAarsoversiktPdf, type PdfAarsoversikt } from "./aarsoversiktPdf.js";
import { hentLogo } from "./dokument.js";
import { leggIKo } from "./tjenester.js";

export type Aarsoversikt = {
  aar: number;
  ansatt_id: string;
  navn: string;
  ansattnummer: number;
  // Lønnen gruppert etter beskrivelsen i a-meldingen (lønnsarter uten beskrivelse for seg).
  inntekter: { kode: string; navn: string; belop: number }[];
  utgifter: { navn: string; belop: number }[];
  trekk: { navn: string; belop: number }[];
  sum: {
    brutto: number;
    trekkpliktig: number;
    skattetrekk: number;
    utgifter: number;
    trekk_etter_skatt: number;
    netto: number;
    feriepengegrunnlag: number;
    feriepenger_opptjent: number;
    otp: number;
  };
  maaneder: { periode: string; utbetalingsdato: string; brutto: number; skattetrekk: number; netto: number }[];
  tidligere: { trekkpliktig: number; forskuddstrekk: number; feriepengegrunnlag: number; feriepenger_utbetalt: number } | null;
};

const uuid = z.string().uuid();
const aarS = z.coerce.number().int().min(2000).max(2100);
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);
const osloIDag = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());
const logg = (severity: string, message: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ severity, message, ...data }));

// Den ansatte oversikten gjelder: den som er valgt (de som ser lønnen), ellers en selv.
async function hvem(db: Db, org: string, ansatt: string | undefined): Promise<string> {
  const meg = (await en<{ id: string | null }>(db, "select faktura.min_ansatt($1) as id", [org]))?.id ?? null;
  if (ansatt && ansatt !== meg) {
    await db.query("select faktura.krev($1, 'personal_les')", [org]);
    return uuid.parse(ansatt);
  }
  if (!meg) throw new ApiFeil(404, "Du er ikke registrert som ansatt");
  return meg;
}

// Årene den ansatte har lønn (godkjente kjøringer) eller tall fra et tidligere lønnssystem.
export async function aarsoversiktAar(db: Db, org: string, ansatt: string): Promise<number[]> {
  const r = await alle<{ aar: number }>(
    db,
    `select extract(year from s.utbetalingsdato)::int as aar from faktura.lonnsslipper s
      where s.org_id = $1 and s.ansatt_id = $2 and not faktura.lonn_utkast(s.kjoring_id)
     union
     select aar from faktura.lonn_inngaende where org_id = $1 and ansatt_id = $2
     order by 1 desc`,
    [org, ansatt],
  );
  return r.map((x) => x.aar);
}

export async function hentAarsoversikt(db: Db, org: string, ansatt: string, aar: number): Promise<Aarsoversikt> {
  const slipper = await alle<any>(
    db,
    `select s.navn, s.ansattnummer, to_char(s.periode, 'YYYY-MM-DD') as periode, to_char(s.utbetalingsdato, 'YYYY-MM-DD') as utbetalingsdato,
            s.brutto::float8 as brutto, s.trekkpliktig::float8 as trekkpliktig, s.skattetrekk::float8 as skattetrekk, s.utgifter::float8 as utgifter,
            s.trekk_etter_skatt::float8 as trekk_etter_skatt, s.netto::float8 as netto, s.feriepengegrunnlag::float8 as feriepengegrunnlag,
            s.feriepenger_opptjent::float8 as feriepenger_opptjent, s.otp::float8 as otp
       from faktura.lonnsslipper s
      where s.org_id = $1 and s.ansatt_id = $2 and extract(year from s.utbetalingsdato) = $3 and not faktura.lonn_utkast(s.kjoring_id)
      order by s.utbetalingsdato, s.periode`,
    [org, ansatt, aar],
  );
  const linjer = await alle<{ lonnsart: string; tekst: string; belop: number }>(
    db,
    `select l.lonnsart, l.tekst, sum(l.belop)::float8 as belop
       from faktura.lonnslinjer l join faktura.lonnsslipper s on s.id = l.slipp_id
      where s.org_id = $1 and s.ansatt_id = $2 and extract(year from s.utbetalingsdato) = $3 and not faktura.lonn_utkast(s.kjoring_id)
        and not l.fjernet
      group by l.lonnsart, l.tekst`,
    [org, ansatt, aar],
  );
  const inn = await en<any>(
    db,
    `select trekkpliktig::float8 as trekkpliktig, forskuddstrekk::float8 as forskuddstrekk, feriepengegrunnlag::float8 as feriepengegrunnlag,
            feriepenger_utbetalt::float8 as feriepenger_utbetalt
       from faktura.lonn_inngaende where org_id = $1 and ansatt_id = $2 and aar = $3`,
    [org, ansatt, aar],
  );
  const siste = slipper.at(-1);
  let navn = siste?.navn as string | undefined;
  let ansattnummer = siste?.ansattnummer as number | undefined;
  if (!siste) {
    if (!inn) throw new ApiFeil(404, `Fant ingen lønn i ${aar}`);
    const a = await en<{ navn: string; ansattnummer: number }>(
      db,
      "select fornavn || ' ' || etternavn as navn, ansattnummer from faktura.ansatte where org_id = $1 and id = $2",
      [org, ansatt],
    );
    navn = a?.navn ?? "";
    ansattnummer = a?.ansattnummer ?? 0;
  }

  // Lønnen etter beskrivelsen i a-meldingen; utgifter og trekk etter skatt med teksten på linjen.
  const inntekter = new Map<string, { kode: string; navn: string; belop: number }>();
  const utgifter = new Map<string, number>();
  const trekk = new Map<string, number>();
  for (const l of linjer) {
    const art = lonnsart(l.lonnsart);
    if (art.type === "utgift") utgifter.set(l.tekst, (utgifter.get(l.tekst) ?? 0) + l.belop);
    else if (art.type === "trekk") trekk.set(l.tekst, (trekk.get(l.tekst) ?? 0) + l.belop);
    else {
      const kode = art.amelding ?? art.kode;
      const x = inntekter.get(kode) ?? { kode, navn: (art.amelding && AMELDING_NAVN[art.amelding]) || art.navn, belop: 0 };
      x.belop += l.belop;
      inntekter.set(kode, x);
    }
  }
  const rekke = Object.keys(AMELDING_NAVN);
  const plass = (k: string) => (rekke.includes(k) ? rekke.indexOf(k) : rekke.length);
  const sum = (felt: string) => rund(slipper.reduce((x, s) => x + Number(s[felt] ?? 0), 0));
  const avrund = (m: Map<string, number>) =>
    [...m].map(([n, b]) => ({ navn: n, belop: rund(b) })).filter((x) => x.belop !== 0).sort((a, b) => a.navn.localeCompare(b.navn, "nb"));
  return {
    aar,
    ansatt_id: ansatt,
    navn: navn ?? "",
    ansattnummer: ansattnummer ?? 0,
    inntekter: [...inntekter.values()]
      .map((x) => ({ ...x, belop: rund(x.belop) }))
      .filter((x) => x.belop !== 0)
      .sort((a, b) => plass(a.kode) - plass(b.kode) || a.navn.localeCompare(b.navn, "nb")),
    utgifter: avrund(utgifter),
    trekk: avrund(trekk),
    sum: {
      brutto: sum("brutto"),
      trekkpliktig: sum("trekkpliktig"),
      skattetrekk: sum("skattetrekk"),
      utgifter: sum("utgifter"),
      trekk_etter_skatt: sum("trekk_etter_skatt"),
      netto: sum("netto"),
      feriepengegrunnlag: sum("feriepengegrunnlag"),
      feriepenger_opptjent: sum("feriepenger_opptjent"),
      otp: sum("otp"),
    },
    maaneder: slipper.map((s) => ({ periode: s.periode, utbetalingsdato: s.utbetalingsdato, brutto: s.brutto, skattetrekk: s.skattetrekk, netto: s.netto })),
    tidligere: inn
      ? {
          trekkpliktig: Number(inn.trekkpliktig),
          forskuddstrekk: Number(inn.forskuddstrekk),
          feriepengegrunnlag: Number(inn.feriepengegrunnlag),
          feriepenger_utbetalt: Number(inn.feriepenger_utbetalt),
        }
      : null,
  };
}

// De ansatte med lønn i året (godkjente kjøringer), til lederens liste.
async function ansatteIAaret(db: Db, org: string, aar: number) {
  return alle<{ ansatt_id: string; navn: string; ansattnummer: number; brutto: number; skattetrekk: number; netto: number; innlogging: boolean }>(
    db,
    `select s.ansatt_id, (array_agg(s.navn order by s.utbetalingsdato desc))[1] as navn,
            (array_agg(s.ansattnummer order by s.utbetalingsdato desc))[1] as ansattnummer,
            sum(s.brutto)::float8 as brutto, sum(s.skattetrekk)::float8 as skattetrekk, sum(s.netto)::float8 as netto,
            coalesce(bool_or(a.bruker_id is not null), false) as innlogging
       from faktura.lonnsslipper s
       join faktura.lonnskjoringer k on k.id = s.kjoring_id
       left join faktura.ansatte a on a.org_id = s.org_id and a.id = s.ansatt_id
      where s.org_id = $1 and k.status = 'godkjent' and extract(year from k.utbetalingsdato) = $2
      group by s.ansatt_id
      order by 3`,
    [org, aar],
  );
}

// Arbeidsgiveren og de ansattes adresse og fødselsdato til PDF-en (tilgangen er sjekket før).
async function pdfInfo(org: string, ansatte: string[]) {
  return somSystem(async (db) => ({
    org: (await en<any>(db, "select navn, orgnr, adresse, postnr, poststed, epost, telefon, farge, logo_sti from faktura.organisasjoner where id = $1", [org]))!,
    ansatte: await alle<{ id: string; adresse: string | null; postnr: string | null; poststed: string | null; fodselsdato: string | null }>(
      db,
      "select id, adresse, postnr, poststed, to_char(fodselsdato, 'YYYY-MM-DD') as fodselsdato from faktura.ansatte where org_id = $1 and id = any($2::uuid[])",
      [org, ansatte],
    ),
  }));
}

async function lagPdf(org: string, oversikter: Aarsoversikt[]) {
  const info = await pdfInfo(
    org,
    oversikter.map((o) => o.ansatt_id),
  );
  const medAdresse: PdfAarsoversikt[] = oversikter.map((o) => {
    const a = info.ansatte.find((x) => x.id === o.ansatt_id);
    return { ...o, ansatt: { adresse: a?.adresse, postnr: a?.postnr, poststed: a?.poststed, fodselsdato: a?.fodselsdato } };
  });
  return lagAarsoversiktPdf(medAdresse, info.org, await hentLogo(info.org.logo_sti));
}

// Varsel til de ansatte med innlogging om at årsoversikten er klar. Returnerer hvor mange som
// fikk det; varslet_av er null når den daglige jobben varsler.
async function varsle(db: Db, org: string, aar: number, varsletAv: string | null): Promise<number> {
  const mottakere = await alle<{ bruker_id: string }>(db, "select bruker_id from faktura.aarsoversikt_mottakere($1, $2)", [org, aar]);
  await db.query(
    `insert into faktura.lonn_aarsoversikt_varslet (org_id, aar, varslet, varslet_av, antall) values ($1, $2, now(), $3, $4)
     on conflict (org_id, aar) do update set varslet = now(), varslet_av = excluded.varslet_av, antall = excluded.antall`,
    [org, aar, varsletAv, mottakere.length],
  );
  if (mottakere.length)
    await leggIKo({
      type: "varsel",
      varsel: {
        hendelse: "lonn",
        org_id: org,
        bruker_ider: [...new Set(mottakere.map((m) => m.bruker_id))],
        tittel: `Årsoversikten for ${aar} er klar`,
        tekst: `Årsoversikten over lønn og skattetrekk i ${aar} er klar. Kontroller den mot skattemeldingen din.`,
        url: `/lonn?fane=mine&aar=${aar}`,
        tag: `lonn-aar-${aar}`,
      },
    });
  return mottakere.length;
}

// Den daglige jobben: fra 10. januar varsles de ansatte om årsoversikten for året før, én gang
// (når ingen kjøring for året står som utkast, og senest 25. januar).
export async function varsleAarsoversikter(iDag = osloIDag()): Promise<number> {
  const [aar, mnd, dag] = iDag.split("-").map(Number) as [number, number, number];
  if (mnd !== 1 || dag < 10) return 0;
  const orger = await somSystem((db) => alle<{ org_id: string }>(db, "select org_id from faktura.aarsoversikt_klar($1, $2)", [aar - 1, iDag]));
  let antall = 0;
  for (const { org_id } of orger) {
    try {
      antall += await somSystem((db) => varsle(db, org_id, aar - 1, null));
    } catch (e) {
      logg("ERROR", "Varselet om årsoversikten ble ikke sendt", { org_id, feil: (e as Error).message });
    }
  }
  if (orger.length) logg("INFO", "Varslet om årsoversikten", { aar: aar - 1, organisasjoner: orger.length, ansatte: antall });
  return antall;
}

export function aarsoversiktRuter() {
  const r = new Hono();

  // Årene den ansatte har en årsoversikt (?ansatt= for de som ser lønnen; ellers en selv).
  r.get("/lonn/aarsoversikt", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        const a = await hvem(db, orgId(c), c.req.query("ansatt"));
        return { ansatt_id: a, aar: await aarsoversiktAar(db, orgId(c), a) };
      }),
    ),
  );

  // Lederen: de ansatte med lønn i året, og når de ble varslet.
  r.get("/lonn/aarsoversikt/:aar/ansatte", async (c) => {
    const aar = aarS.parse(c.req.param("aar"));
    return c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'personal_les')", [orgId(c)]);
        const varslet = await en<any>(
          db,
          `select v.varslet, v.antall, (select coalesce(b.navn, b.epost) from faktura.brukere b where b.id = v.varslet_av) as varslet_av
             from faktura.lonn_aarsoversikt_varslet v where v.org_id = $1 and v.aar = $2`,
          [orgId(c), aar],
        );
        const aarListe = await alle<{ aar: number }>(
          db,
          "select distinct extract(year from utbetalingsdato)::int as aar from faktura.lonnskjoringer where org_id = $1 and status = 'godkjent' order by 1 desc",
          [orgId(c)],
        );
        const utkast = await en<{ n: number }>(
          db,
          "select count(*)::int as n from faktura.lonnskjoringer where org_id = $1 and status = 'utkast' and extract(year from utbetalingsdato) = $2",
          [orgId(c), aar],
        );
        return { aar, aar_liste: aarListe.map((x) => x.aar), utkast: utkast?.n ?? 0, varslet: varslet ?? null, ansatte: await ansatteIAaret(db, orgId(c), aar) };
      }),
    );
  });

  r.get("/lonn/aarsoversikt/:aar", async (c) => {
    const aar = aarS.parse(c.req.param("aar"));
    return c.json(await bruk(c, async (db) => hentAarsoversikt(db, orgId(c), await hvem(db, orgId(c), c.req.query("ansatt")), aar)));
  });

  // Som PDF: én ansatt, eller alle med lønn i året (?ansatt=alle, de som ser lønnen).
  r.get("/lonn/aarsoversikt/:aar/pdf", async (c) => {
    const aar = aarS.parse(c.req.param("aar"));
    const alleAnsatte = c.req.query("ansatt") === "alle";
    const oversikter = await bruk(c, async (db) => {
      if (alleAnsatte) {
        await db.query("select faktura.krev($1, 'personal_les')", [orgId(c)]);
        const ansatte = await ansatteIAaret(db, orgId(c), aar);
        if (!ansatte.length) throw new ApiFeil(404, `Ingen lønn er godkjent med utbetaling i ${aar}`);
        const ut: Aarsoversikt[] = [];
        for (const a of ansatte) ut.push(await hentAarsoversikt(db, orgId(c), a.ansatt_id, aar));
        return ut;
      }
      return [await hentAarsoversikt(db, orgId(c), await hvem(db, orgId(c), c.req.query("ansatt")), aar)];
    });
    const pdf = await lagPdf(orgId(c), oversikter);
    const en1 = oversikter.length === 1 && !alleAnsatte ? oversikter[0]! : null;
    return c.body(Buffer.from(pdf), 200, {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${en1 ? `aarsoversikt-${aar}-${en1.ansattnummer}` : `aarsoversikter-${aar}`}.pdf"`,
    });
  });

  // Eier og administrator varsler de ansatte med innlogging (igjen) om årsoversikten.
  r.post("/lonn/aarsoversikt/:aar/varsle", async (c) => {
    const aar = aarS.parse(c.req.param("aar"));
    const antall = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      return varsle(db, orgId(c), aar, c.get("bruker").id);
    });
    return c.json({ antall });
  });

  return r;
}
