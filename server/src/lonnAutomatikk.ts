// Lønnen går av seg selv (0088_lonn_automatikk.sql). Hvert minutt regner workeren ut på nytt de
// utkastene der noe i grunnlaget er endret (timer, fravær, vakter, faste planer, tillegg, trekk,
// naturalytelser, reiser, timebanken, lønnsendringer, de ansatte, oppsettet og trekktabellene, eller
// en annen kjøring som er godkjent eller åpnet igjen). Hver morgen lager den den ordinære kjøringen
// for måneden (når organisasjonen har kjørt lønn i HI4 de siste tre månedene og ikke har slått det av
// under Innstillinger → Ansatte og timer), regner ut utkastene som ikke er regnet ut det siste døgnet,
// minner eier og administrator på en kjøring som ikke er godkjent tre dager før lønnsdagen, og
// rydder bort endringene alle utkastene har sett.
import { alle, en, somSystem } from "./db.js";
import { ApiFeil } from "./feil.js";
import { beregnKjoring, lagKjoring } from "./lonn.js";
import { maanedNavn } from "./lonnsberegning.js";
import { leggIKo } from "./tjenester.js";

const logg = (severity: string, message: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ severity, message, ...data }));
const osloIDag = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());
const visDato = (d: string) => d.split("-").reverse().join(".");

// Varsel til eier og administrator.
async function varsle(org: string, tittel: string, tekst: string, url: string, tag: string) {
  const mottakere = await somSystem((db) =>
    alle<{ bruker_id: string }>(db, "select bruker_id from faktura.medlemmer where org_id = $1 and rolle in ('eier', 'admin')", [org]),
  );
  if (mottakere.length)
    await leggIKo({ type: "varsel", varsel: { hendelse: "lonn", org_id: org, bruker_ider: mottakere.map((m) => m.bruker_id), tittel, tekst, url, tag } }).catch(
      () => undefined,
    );
}

// Kjøringene regnes ut hver i sin transaksjon (en feil stopper ikke de andre).
async function regnUt(ider: string[]): Promise<number> {
  let n = 0;
  for (const id of ider) {
    try {
      await somSystem((db) => beregnKjoring(db, id));
      n++;
    } catch (e) {
      logg("WARNING", "Lønnskjøringen ble ikke regnet ut på nytt", { kjoring: id, feil: (e as Error).message });
    }
  }
  return n;
}

// Hvert minutt: utkastene der noe er endret siden de ble regnet ut (de eldste først, høyst maks).
// org: bare én organisasjon (testene, som deler databasen).
export async function oppdaterLonnsutkast(maks = 25, org: string | null = null): Promise<number> {
  const ider = await somSystem((db) =>
    alle<{ id: string }>(
      db,
      `select id from faktura.lonnskjoringer
        where status = 'utkast' and ($2::uuid is null or org_id = $2) and faktura.har_funksjon(org_id, 'lonn') and faktura.lonn_utdatert(id)
        order by periode, opprettet limit $1`,
      [maks, org],
    ),
  );
  return regnUt(ider.map((k) => k.id));
}

// Hver morgen (iDag: datoen i norsk tid; org: bare én organisasjon, i testene).
export async function lonnHverMorgen(iDag = osloIDag(), org: string | null = null) {
  const periode = `${iDag.slice(0, 7)}-01`;

  // Den ordinære kjøringen for måneden: organisasjonene med lønn som har kjørt lønn i HI4 de siste tre
  // månedene (ikke de som har sluttet med det), har ansatte i arbeid og ikke har slått det av.
  const nye = await somSystem((db) =>
    alle<{ id: string }>(
      db,
      `select o.id from faktura.organisasjoner o join faktura.lonn_oppsett l on l.org_id = o.id
        where l.aktiv and l.auto_kjoring and ($2::uuid is null or o.id = $2) and faktura.har_funksjon(o.id, 'lonn')
          and exists (select 1 from faktura.lonnskjoringer k
                       where k.org_id = o.id and k.type = 'ordinar' and k.periode < $1::date and k.periode >= $1::date - interval '3 months')
          and not exists (select 1 from faktura.lonnskjoringer k where k.org_id = o.id and k.type = 'ordinar' and k.periode = $1::date)
          and exists (select 1 from faktura.ansatte a where a.org_id = o.id and a.arbeidstaker and a.aktiv)`,
      [periode, org],
    ),
  );
  let laget = 0;
  for (const o of nye) {
    try {
      const k = (await somSystem(async (db) => {
        const id = await lagKjoring(db, o.id, { periode: periode.slice(0, 7), automatisk: true });
        return en<{ id: string; periode: string; utbetalingsdato: string }>(
          db,
          "select id, to_char(periode, 'YYYY-MM-DD') as periode, to_char(utbetalingsdato, 'YYYY-MM-DD') as utbetalingsdato from faktura.lonnskjoringer where id = $1",
          [id],
        );
      }))!;
      laget++;
      await varsle(
        o.id,
        `Lønnen for ${maanedNavn(k.periode)} er klar som utkast`,
        `Lønnskjøringen holdes oppdatert med timer, fravær og endringer til den er godkjent. Lønnen utbetales ${visDato(k.utbetalingsdato)}.`,
        `/lonn?kjoring=${k.id}`,
        `lonn-auto-${k.id}`,
      );
    } catch (e) {
      // Laget i appen samtidig: ingenting å gjøre.
      if ((e instanceof ApiFeil && e.status === 409) || (e as { code?: string }).code === "23505") continue;
      logg("ERROR", "Lønnskjøringen for måneden ble ikke laget", { org: o.id, feil: (e as Error).message });
    }
  }

  // Utkastene som ikke er regnet ut det siste døgnet (i tilfelle en endring ikke ble fanget opp).
  const gamle = await somSystem((db) =>
    alle<{ id: string }>(
      db,
      `select k.id from faktura.lonnskjoringer k left join faktura.lonnskjoring_beregning b on b.kjoring_id = k.id
        where k.status = 'utkast' and ($1::uuid is null or k.org_id = $1) and faktura.har_funksjon(k.org_id, 'lonn')
          and (b.beregnet is null or b.beregnet < now() - interval '20 hours')
        order by k.periode, k.opprettet`,
      [org],
    ),
  );
  const regnet = await regnUt(gamle.map((k) => k.id));

  // Påminnelsen: den ordinære kjøringen er ikke godkjent fra tre dager før lønnsdagen (én gang).
  const paaminn = await somSystem((db) =>
    alle<{ id: string; org_id: string; periode: string; utbetalingsdato: string; levert: number }>(
      db,
      `update faktura.lonnskjoring_beregning b set paaminnet = now()
         from faktura.lonnskjoringer k
        where k.id = b.kjoring_id and k.status = 'utkast' and k.type = 'ordinar' and b.paaminnet is null and ($2::uuid is null or k.org_id = $2)
          and $1::date between k.utbetalingsdato - 3 and k.utbetalingsdato and faktura.har_funksjon(k.org_id, 'lonn')
       returning k.id, k.org_id, to_char(k.periode, 'YYYY-MM-DD') as periode, to_char(k.utbetalingsdato, 'YYYY-MM-DD') as utbetalingsdato,
                 (select count(*)::int from faktura.timeforinger t
                   where t.org_id = k.org_id and t.status = 'levert' and t.lonnskjoring_id is null
                     and t.dato <= (k.periode + interval '1 month' - interval '1 day')::date) as levert`,
      [iDag, org],
    ),
  );
  for (const k of paaminn)
    await varsle(
      k.org_id,
      `Lønnen for ${maanedNavn(k.periode)} er ikke godkjent`,
      `Lønnen skal utbetales ${visDato(k.utbetalingsdato)}. Se over og godkjenn lønnskjøringen, og last opp betalingsfila i nettbanken.${
        k.levert ? ` ${k.levert} ${k.levert === 1 ? "timeføring venter" : "timeføringer venter"} på godkjenning.` : ""
      }`,
      `/lonn?kjoring=${k.id}`,
      `lonn-paaminnelse-${k.id}`,
    );

  const ryddet = Number((await somSystem((db) => en<{ n: number }>(db, "select faktura.rydd_lonn_endringer() as n")))?.n ?? 0);
  logg("INFO", "Lønnen hver morgen", { laget, regnet, paaminnet: paaminn.length, ryddet });
  return { laget, regnet, paaminnet: paaminn.length, ryddet };
}
