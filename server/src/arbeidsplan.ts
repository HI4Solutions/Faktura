// Fast arbeidsplan (0040_arbeidsplan.sql): hvilke ukedager den ansatte jobber, med klokkeslett
// eller som hel dag (en femtedel av arbeidstiden i full stilling), gjeldende fra en dato. Her
// lagres planene, og her regnes de faste dagene og ekstratimene ut, som bemanningskalenderen,
// vaktplanen, tavla, timelisten og rapporten over ekstratimer bygger på:
//
// - En fast dag er en dag i planen uten en vakt i vaktplanen (vakten gjelder da i stedet), og
//   aldri en helligdag (helligdager.ts): da har den ansatte fri, og timene den dagen er ekstra.
//   Har den ansatte gitt bort vakten eller den faste dagen i et vaktbytte (0060_vaktbytte.sql),
//   har de fri den dagen (arbeidsplan_fri), og den faste dagen kommer ikke tilbake.
// - Ekstratimer: med plan timene utover planen den dagen; uten plan timene utover avtalt
//   arbeidstid i uka (alle timene for tilkallingsvikarer). Vakter den ansatte er borte fra,
//   teller ikke. Ved et vaktbytte er timene i planen flyttet til dagen den ansatte fikk igjen,
//   så byttet ikke blir ekstratimer.
import { Hono, type Context } from "hono";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { z } from "zod";
import { alle, en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { uke } from "./arbeidstid.js";
import { csv } from "./rapporter.js";
import { rensTekst } from "./pdf.js";
import { dato as visDato } from "./regler.js";
import { helligdag } from "./helligdager.js";

const uuid = z.string().uuid();
// Som i ansatte.ts (som bruker denne modulen, så den kan ikke importeres herfra).
const datoS = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ugyldig dato");
const klokke = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Skriv klokkeslettet som TT:MM");
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const id = (c: Context) => uuid.parse(c.req.param("id"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);

export type PlanDag = { ukedag: number; fra: string | null; til: string | null; pause_min: number };
export type Plan = { id: string; ansatt_id: string; gjelder_fra: string; dager: PlanDag[] };
type Ansatt = {
  id: string;
  ansattnummer: number;
  navn: string;
  stilling: string | null;
  gruppe: string | null;
  ansatt_fra: string;
  ansatt_til: string | null;
  aktiv: boolean;
  ukentlig_arbeidstid: number;
  stillingsprosent: number;
  ansettelsestype: string;
  arbeidstaker: boolean; // false: med uten å være ansatt (rollen, 0056_roller.sql)
};
type Vakt = { ansatt_id: string; dato: string; fra: string; til: string; timer: number; borte: boolean };
export type Fast = { ansatt_id: string; dato: string; fra: string | null; til: string | null; pause_min: number; timer: number; fravaer: string | null };
// En fast dag den ansatte har fri (gitt bort i et vaktbytte), og dagen timene er flyttet til.
export type Fri = { ansatt_id: string; dato: string; byttet_til: string | null };
// Timer den ansatte har ført (levert eller godkjent): det de faktisk har jobbet den dagen. vakt_id:
// vakten de er ført fra.
export type Fort = {
  id: string;
  ansatt_id: string;
  dato: string;
  fra: string | null;
  til: string | null;
  pause_min: number;
  timer: number;
  status: "levert" | "godkjent";
  vakt_id: string | null;
};

const DAG = 86_400_000;
const leggTil = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * DAG).toISOString().slice(0, 10);
export const ukedag = (iso: string) => ((new Date(`${iso}T12:00:00Z`).getUTCDay() + 6) % 7) + 1; // 1 = mandag
const rund = (t: number) => Math.round(t * 100) / 100;
const min = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
// Timene mellom fra og til (over midnatt når til er før fra), minus pausen. Som i databasen.
function timerMellom(fra: string, til: string, pause: number) {
  let m = min(til) - min(fra);
  if (m <= 0) m += 24 * 60;
  return (m - pause) / 60;
}
// En dag i planen: klokkeslettene, eller en hel dag (en femtedel av arbeidstiden i full stilling).
export const dagTimer = (d: PlanDag, ukentlig: number) => rund(d.fra && d.til ? timerMellom(d.fra, d.til, d.pause_min) : Number(ukentlig) / 5);

// Planene per ansatt, eldste først.
export async function hentPlaner(db: Db, org: string, ansatt?: string | null): Promise<Map<string, Plan[]>> {
  const rader = await alle<{ id: string; ansatt_id: string; gjelder_fra: string; ukedag: number | null; fra: string | null; til: string | null; pause_min: number | null }>(
    db,
    `select p.id, p.ansatt_id, p.gjelder_fra, d.ukedag, to_char(d.fra, 'HH24:MI') as fra, to_char(d.til, 'HH24:MI') as til, d.pause_min
       from faktura.arbeidsplaner p
       left join faktura.arbeidsplan_dager d on d.org_id = p.org_id and d.plan_id = p.id
      where p.org_id = $1 and ($2::uuid is null or p.ansatt_id = $2)
      order by p.ansatt_id, p.gjelder_fra, d.ukedag`,
    [org, ansatt ?? null],
  );
  const ut = new Map<string, Plan[]>();
  for (const r of rader) {
    const liste = ut.get(r.ansatt_id) ?? [];
    let p = liste.at(-1);
    if (!p || p.id !== r.id) {
      p = { id: r.id, ansatt_id: r.ansatt_id, gjelder_fra: r.gjelder_fra, dager: [] };
      liste.push(p);
    }
    if (r.ukedag) p.dager.push({ ukedag: r.ukedag, fra: r.fra, til: r.til, pause_min: r.pause_min ?? 0 });
    ut.set(r.ansatt_id, liste);
  }
  return ut;
}

// Planen som gjelder en dag (den nyeste som har begynt). En plan uten dager betyr at den
// ansatte ikke har faste dager fra da (som uten plan).
export function planFor(planer: Plan[] | undefined, dato: string): Plan | null {
  let funnet: Plan | null = null;
  for (const p of planer ?? []) if (p.gjelder_fra <= dato) funnet = p;
  return funnet?.dager.length ? funnet : null;
}

// Ekstratimer per ansatt og dag («ansatt|dato» → timer), fra vaktene den ansatte går.
// De som ikke er ansatt (en rolle for f.eks. leger som er aksjonærer), har ingen ekstratimer.
export function beregnEkstra(
  ansatte: (Pick<Ansatt, "id" | "ukentlig_arbeidstid" | "stillingsprosent" | "ansettelsestype"> & { arbeidstaker?: boolean })[],
  planer: Map<string, Plan[]>,
  vakter: Vakt[],
  fri: Fri[] = [],
) {
  const ut = new Map<string, number>();
  const legg = (k: string, t: number) => t > 0.01 && ut.set(k, rund((ut.get(k) ?? 0) + t));
  for (const a of ansatte) {
    if (a.arbeidstaker === false) continue;
    const p = planer.get(a.id);
    const egne = vakter.filter((v) => v.ansatt_id === a.id && !v.borte).sort((x, y) => x.dato.localeCompare(y.dato) || x.fra.localeCompare(y.fra));
    const egenFri = fri.filter((f) => f.ansatt_id === a.id);
    // Timene i planen en dag (ingen på en helligdag, da gjelder ikke planen).
    const planTimer = (d: string) => {
      const dag = helligdag(d) ? undefined : planFor(p, d)?.dager.find((x) => x.ukedag === ukedag(d));
      return dag ? dagTimer(dag, a.ukentlig_arbeidstid) : 0;
    };
    // Med plan: timene utover planen den dagen.
    const perDag = new Map<string, number>();
    const utenPlan: Vakt[] = [];
    for (const v of egne) {
      if (planFor(p, v.dato)) perDag.set(v.dato, (perDag.get(v.dato) ?? 0) + Number(v.timer));
      else utenPlan.push(v);
    }
    for (const [d, t] of perDag) {
      // En dag med fri (byttet bort) har ingen timer i planen; dagene som er byttet hit, har sine.
      const plan = egenFri.some((f) => f.dato === d) ? 0 : planTimer(d);
      const flyttet = egenFri.filter((f) => f.byttet_til === d).reduce((sum, f) => sum + planTimer(f.dato), 0);
      legg(`${a.id}|${d}`, t - plan - flyttet);
    }
    // Uten plan: timene utover avtalt arbeidstid i uka, i rekkefølge.
    const grense = a.ansettelsestype === "tilkalling" ? 0 : (Number(a.ukentlig_arbeidstid) * Number(a.stillingsprosent)) / 100;
    const perUke = new Map<string, Vakt[]>();
    for (const v of utenPlan) perUke.set(uke(v.dato).fra, [...(perUke.get(uke(v.dato).fra) ?? []), v]);
    for (const liste of perUke.values()) {
      let sum = 0;
      for (const v of liste) {
        const t = Number(v.timer);
        legg(`${a.id}|${v.dato}`, Math.max(0, Math.min(t, sum + t - grense)));
        sum += t;
      }
    }
  }
  return ut;
}

// Faste dager og ekstratimer i perioden (hele uker lastes, så ukeregelen blir riktig i kantene).
// forte: med de førte timene (levert og godkjent; radtilgangen gir en ansatt bare sine egne). En dag
// med førte timer regnes da etter dem i stedet for vaktene (det den ansatte faktisk jobbet), så en
// ekstratime som er ført, er med i ekstratimene i vaktplanen, kalenderen og rapporten.
export async function beregnBemanning(db: Db, org: string, fra: string, til: string, ansatt?: string | null, valg: { forte?: boolean } = {}) {
  const ufra = uke(fra).fra;
  const util = uke(til).til;
  // Personene og fraværet fra planen (0063): de ansatte ser kollegaene, men ikke stillingen eller
  // typen fravær.
  const ansatte = await alle<Ansatt>(
    db,
    `select a.id, a.ansattnummer, a.fornavn || ' ' || a.etternavn as navn, a.stilling, g.navn as gruppe, a.ansatt_fra, a.ansatt_til, a.aktiv,
            a.ukentlig_arbeidstid, a.stillingsprosent, a.ansettelsestype, a.arbeidstaker
       from faktura.ansatte_plan a left join faktura.ansattgrupper g on g.org_id = a.org_id and g.id = a.gruppe_id
      where a.org_id = $1 and ($2::uuid is null or a.id = $2)`,
    [org, ansatt ?? null],
  );
  const planer = await hentPlaner(db, org, ansatt);
  const vakter = await alle<Vakt>(
    db,
    `select v.ansatt_id, v.dato, to_char(v.fra, 'HH24:MI') as fra, to_char(v.til, 'HH24:MI') as til, v.timer,
            exists (select 1 from faktura.fravaer_plan f where f.org_id = v.org_id and f.ansatt_id = v.ansatt_id and v.dato between f.fra and f.til) as borte
       from faktura.vakter v
      where v.org_id = $1 and v.dato between $2 and $3 and v.ansatt_id is not null and ($4::uuid is null or v.ansatt_id = $4)`,
    [org, ufra, util, ansatt ?? null],
  );
  const fravaer = await alle<{ ansatt_id: string; fra: string; til: string; type: string }>(
    db,
    // Typen bare for dem som ser den (0047_fravaer_skjult.sql); ellers «fravaer».
    "select ansatt_id, fra, til, type from faktura.fravaer_plan where org_id = $1 and til >= $2 and fra <= $3 and ($4::uuid is null or ansatt_id = $4)",
    [org, ufra, util, ansatt ?? null],
  );
  const borte = (a: string, d: string) => fravaer.find((f) => f.ansatt_id === a && f.fra <= d && f.til >= d)?.type ?? null;
  const harVakt = new Set(vakter.map((v) => `${v.ansatt_id}|${v.dato}`));
  // Faste dager gitt bort i et vaktbytte (og dagene timene er flyttet til, for ekstratimene).
  const fri = await alle<Fri>(
    db,
    "select ansatt_id, dato, byttet_til from faktura.arbeidsplan_fri where org_id = $1 and (dato between $2 and $3 or byttet_til between $2 and $3) and ($4::uuid is null or ansatt_id = $4)",
    [org, ufra, util, ansatt ?? null],
  );
  const harFri = new Set(fri.map((f) => `${f.ansatt_id}|${f.dato}`));
  const faste: Fast[] = [];
  for (const a of ansatte) {
    const p = planer.get(a.id);
    if (!p || !a.aktiv) continue;
    for (let d = ufra; d <= util; d = leggTil(d, 1)) {
      // Ingen fast dag på en helligdag (helligdager.ts).
      if (d < a.ansatt_fra || (a.ansatt_til && d > a.ansatt_til) || harVakt.has(`${a.id}|${d}`) || harFri.has(`${a.id}|${d}`) || helligdag(d)) continue;
      const dag = planFor(p, d)?.dager.find((x) => x.ukedag === ukedag(d));
      if (dag) faste.push({ ansatt_id: a.id, dato: d, fra: dag.fra, til: dag.til, pause_min: dag.pause_min, timer: dagTimer(dag, a.ukentlig_arbeidstid), fravaer: borte(a.id, d) });
    }
  }
  const forte = valg.forte
    ? await alle<Fort>(
        db,
        `select t.id, t.ansatt_id, t.dato, to_char(t.fra, 'HH24:MI') as fra, to_char(t.til, 'HH24:MI') as til, t.pause_min, t.timer, t.status, t.vakt_id
           from faktura.timeforinger t
          where t.org_id = $1 and t.dato between $2 and $3 and t.status in ('levert', 'godkjent') and ($4::uuid is null or t.ansatt_id = $4)
          order by t.dato, t.fra nulls last`,
        [org, ufra, util, ansatt ?? null],
      )
    : [];
  const fortDag = new Set(forte.map((f) => `${f.ansatt_id}|${f.dato}`));
  const faktiske: Vakt[] = forte.length
    ? [
        ...vakter.filter((v) => !fortDag.has(`${v.ansatt_id}|${v.dato}`)),
        ...forte.map((f) => ({ ansatt_id: f.ansatt_id, dato: f.dato, fra: f.fra ?? "", til: f.til ?? "", timer: Number(f.timer), borte: false })),
      ]
    : vakter;
  return { ansatte, planer, vakter, faste, fri, forte, ekstra: beregnEkstra(ansatte, planer, faktiske, fri), ufra, util };
}

// --- Rapporten over ekstratimer --------------------------------------------------------------

type Rapport = {
  fra: string;
  til: string;
  sum: number;
  ansatte: { ansatt_id: string; ansattnummer: number; navn: string; gruppe: string | null; stilling: string | null; stillingsprosent: number; timer: number; dager: { dato: string; timer: number; vakter: string }[] }[];
};

export async function ekstratimer(db: Db, org: string, fra: string, til: string): Promise<Rapport> {
  await db.query("select faktura.krev($1, 'personal_les')", [org]);
  const b = await beregnBemanning(db, org, fra, til, null, { forte: true });
  const ansatte = b.ansatte
    .map((a) => {
      const dager = [...b.ekstra.entries()]
        .filter(([k]) => k.startsWith(`${a.id}|`))
        .map(([k, timer]) => ({ dato: k.split("|")[1]!, timer }))
        .filter((d) => d.dato >= fra && d.dato <= til)
        .sort((x, y) => x.dato.localeCompare(y.dato))
        .map((d) => {
          // De førte timene den dagen (det som faktisk er jobbet), ellers vaktene.
          const forte = b.forte.filter((f) => f.ansatt_id === a.id && f.dato === d.dato);
          return {
            ...d,
            vakter: forte.length
              ? `Ført ${forte.map((f) => (f.fra ? `${f.fra}–${f.til}` : `${rund(Number(f.timer))} t`)).join(", ")}`
              : b.vakter
                  .filter((v) => v.ansatt_id === a.id && v.dato === d.dato && !v.borte)
                  .map((v) => `${v.fra}–${v.til}`)
                  .join(", "),
          };
        });
      return { ansatt_id: a.id, ansattnummer: a.ansattnummer, navn: a.navn, gruppe: a.gruppe, stilling: a.stilling, stillingsprosent: Number(a.stillingsprosent), timer: rund(dager.reduce((s, d) => s + d.timer, 0)), dager };
    })
    .filter((a) => a.timer > 0)
    .sort((x, y) => x.navn.localeCompare(y.navn, "nb"));
  return { fra, til, sum: rund(ansatte.reduce((s, a) => s + a.timer, 0)), ansatte };
}

const tall = (n: number) => n.toLocaleString("nb-NO", { maximumFractionDigits: 2 });

async function lagRapportPdf(r: Rapport, org: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Ekstratimer ${visDato(r.fra)}–${visDato(r.til)}`);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fet = await doc.embedFont(StandardFonts.HelveticaBold);
  const B = 595.28;
  const H = 841.89;
  const M = 50;
  let side: PDFPage = doc.addPage([B, H]);
  let y = H - M;
  const skriv = (t: string, x: number, f: PDFFont, s: number, farge = rgb(0.1, 0.12, 0.18), hoyre = false) => {
    const tekst = rensTekst(t, f);
    side.drawText(tekst, { x: hoyre ? x - f.widthOfTextAtSize(tekst, s) : x, y, size: s, font: f, color: farge });
  };
  const kolonner = { navn: M, gruppe: 230, dager: B - M - 90, timer: B - M };
  // Er det ikke plass til mer på siden, fortsetter tabellen på en ny side med overskriftene.
  const plass = (h: number) => {
    if (y - h >= M) return;
    side = doc.addPage([B, H]);
    y = H - M;
    hode();
  };
  const hode = () => {
    skriv("Ansatt", kolonner.navn, fet, 9, rgb(0.39, 0.45, 0.55));
    skriv("Gruppe / stilling", kolonner.gruppe, fet, 9, rgb(0.39, 0.45, 0.55));
    skriv("Dager", kolonner.dager, fet, 9, rgb(0.39, 0.45, 0.55), true);
    skriv("Ekstratimer", kolonner.timer, fet, 9, rgb(0.39, 0.45, 0.55), true);
    y -= 6;
    side.drawLine({ start: { x: M, y }, end: { x: B - M, y }, thickness: 0.6, color: rgb(0.8, 0.83, 0.88) });
    y -= 14;
  };

  skriv("Ekstratimer", M, fet, 18);
  y -= 20;
  skriv(`${org} · ${visDato(r.fra)}–${visDato(r.til)}`, M, font, 10.5, rgb(0.39, 0.45, 0.55));
  y -= 14;
  skriv("Timer utover den faste arbeidsplanen (eller utover avtalt arbeidstid i uka for dem uten plan).", M, font, 8.5, rgb(0.39, 0.45, 0.55));
  y -= 26;
  if (!r.ansatte.length) {
    skriv("Ingen ekstratimer i perioden.", M, font, 11);
  } else {
    hode();
    for (const a of r.ansatte) {
      // Datoene under navnet, brutt over flere linjer.
      const datoer = a.dager.map((d) => `${visDato(d.dato).slice(0, 5)} ${tall(d.timer)} t`);
      const linjer: string[] = [];
      let linje = "";
      for (const d of datoer) {
        const neste = linje ? `${linje}, ${d}` : d;
        if (font.widthOfTextAtSize(neste, 8.5) > B - 2 * M - 10) {
          linjer.push(linje);
          linje = d;
        } else linje = neste;
      }
      if (linje) linjer.push(linje);
      plass(18 + linjer.length * 11);
      skriv(a.navn, kolonner.navn, fet, 10.5);
      skriv([a.gruppe, a.stilling].filter(Boolean).join(" · ") || "–", kolonner.gruppe, font, 9.5, rgb(0.2, 0.25, 0.33));
      skriv(String(a.dager.length), kolonner.dager, font, 10.5, undefined, true);
      skriv(`${tall(a.timer)} t`, kolonner.timer, fet, 10.5, undefined, true);
      y -= 13;
      for (const l of linjer) {
        skriv(l, kolonner.navn + 10, font, 8.5, rgb(0.39, 0.45, 0.55));
        y -= 11;
      }
      y -= 6;
    }
    plass(30);
    side.drawLine({ start: { x: M, y: y + 6 }, end: { x: B - M, y: y + 6 }, thickness: 0.6, color: rgb(0.8, 0.83, 0.88) });
    y -= 8;
    skriv("Sum", kolonner.navn, fet, 11);
    skriv(`${tall(r.sum)} t`, kolonner.timer, fet, 11, undefined, true);
  }
  // Sidetall
  const sider = doc.getPages();
  sider.forEach((s, i) => {
    const t = `Side ${i + 1} av ${sider.length}`;
    s.drawText(t, { x: B - M - font.widthOfTextAtSize(t, 8), y: 28, size: 8, font, color: rgb(0.55, 0.6, 0.68) });
  });
  return doc.save();
}

// --- Rutene ----------------------------------------------------------------------------------

const planSkjema = z.object({
  gjelder_fra: datoS,
  dager: z
    .array(
      z.object({
        ukedag: z.number().int().min(1).max(7),
        fra: klokke.nullable().optional(),
        til: klokke.nullable().optional(),
        pause_min: z.number().int().min(0, "Pausen kan ikke være negativ").max(600, "Pausen kan være høyst 10 timer").optional(),
      }),
    )
    .max(7),
});

const periodeSkjema = z.object({ fra: datoS, til: datoS });
function sjekkPeriode(p: { fra: string; til: string }) {
  if (p.til < p.fra) throw new ApiFeil(400, "Slutten er før starten");
  if ((Date.parse(p.til) - Date.parse(p.fra)) / DAG > 366) throw new ApiFeil(400, "Velg en periode på høyst ett år");
}

export function arbeidsplanRuter() {
  const r = new Hono();

  // Planene til en ansatt (eldste først); den ansatte ser sine egne.
  r.get("/ansatte/:id/arbeidsplan", async (c) => c.json(await bruk(c, async (db) => (await hentPlaner(db, orgId(c), id(c))).get(id(c)) ?? [])));

  // Lagre planen som gjelder fra en dato (en plan som gjelder fra samme dato, byttes ut).
  r.put("/ansatte/:id/arbeidsplan", async (c) => {
    const b = planSkjema.parse(await c.req.json().catch(() => ({})));
    if (new Set(b.dager.map((d) => d.ukedag)).size !== b.dager.length) throw new ApiFeil(400, "Hver ukedag kan bare stå én gang");
    for (const d of b.dager) {
      if (!d.fra !== !d.til) throw new ApiFeil(400, "Skriv både fra og til, eller velg hel dag");
      if (d.fra && d.fra === d.til) throw new ApiFeil(400, "Fra og til kan ikke være like");
      if (!d.fra && d.pause_min) throw new ApiFeil(400, "Pause kan bare settes sammen med klokkeslett");
    }
    const planer = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      if (!(await en(db, "select 1 from faktura.ansatte where org_id = $1 and id = $2", [orgId(c), id(c)]))) throw new ApiFeil(404, "Fant ikke den ansatte");
      const plan =
        (await en<{ id: string }>(db, "select id from faktura.arbeidsplaner where org_id = $1 and ansatt_id = $2 and gjelder_fra = $3", [orgId(c), id(c), b.gjelder_fra])) ??
        (await en<{ id: string }>(db, "insert into faktura.arbeidsplaner (org_id, ansatt_id, gjelder_fra) values ($1, $2, $3) returning id", [orgId(c), id(c), b.gjelder_fra]));
      await db.query("delete from faktura.arbeidsplan_dager where org_id = $1 and plan_id = $2", [orgId(c), plan!.id]);
      for (const d of b.dager)
        await db.query("insert into faktura.arbeidsplan_dager (org_id, plan_id, ukedag, fra, til, pause_min) values ($1, $2, $3, $4, $5, $6)", [
          orgId(c),
          plan!.id,
          d.ukedag,
          d.fra ?? null,
          d.til ?? null,
          d.fra ? (d.pause_min ?? 0) : 0,
        ]);
      return (await hentPlaner(db, orgId(c), id(c))).get(id(c)) ?? [];
    });
    return c.json(planer);
  });

  r.delete("/ansatte/:id/arbeidsplan/:plan", async (c) => {
    await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      const res = await db.query("delete from faktura.arbeidsplaner where org_id = $1 and ansatt_id = $2 and id = $3", [orgId(c), id(c), uuid.parse(c.req.param("plan"))]);
      if (!res.rowCount) throw new ApiFeil(404, "Fant ikke planen");
    });
    return c.body(null, 204);
  });

  // Ekstratimer per ansatt i en periode: som JSON, CSV (for Excel) og PDF.
  r.get("/ekstratimer", async (c) => {
    const p = periodeSkjema.parse(c.req.query());
    sjekkPeriode(p);
    return c.json(await bruk(c, (db) => ekstratimer(db, orgId(c), p.fra, p.til)));
  });

  r.get("/ekstratimer.csv", async (c) => {
    const p = periodeSkjema.parse(c.req.query());
    sjekkPeriode(p);
    const rapport = await bruk(c, (db) => ekstratimer(db, orgId(c), p.fra, p.til));
    const tekst = csv(
      rapport.ansatte.map((a) => ({
        ...a,
        antall: a.dager.length,
        datoer: a.dager.map((d) => `${visDato(d.dato)} ${tall(d.timer)} t`).join(", "),
      })),
      [
        ["ansattnummer", "Ansattnr."],
        ["navn", "Navn"],
        ["gruppe", "Gruppe"],
        ["stilling", "Stilling"],
        ["stillingsprosent", "Stillingsprosent"],
        ["timer", "Ekstratimer"],
        ["antall", "Dager med ekstratimer"],
        ["datoer", "Datoer"],
      ],
    );
    return c.body(tekst, 200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="ekstratimer-${p.fra}-${p.til}.csv"` });
  });

  r.get("/ekstratimer.pdf", async (c) => {
    const p = periodeSkjema.parse(c.req.query());
    sjekkPeriode(p);
    const { rapport, navn } = await bruk(c, async (db) => ({
      rapport: await ekstratimer(db, orgId(c), p.fra, p.til),
      navn: (await en<{ navn: string }>(db, "select navn from faktura.organisasjoner where id = $1", [orgId(c)]))?.navn ?? "",
    }));
    const pdf = await lagRapportPdf(rapport, navn);
    return c.body(Buffer.from(pdf), 200, { "content-type": "application/pdf", "content-disposition": `attachment; filename="ekstratimer-${p.fra}-${p.til}.pdf"` });
  });

  return r;
}
