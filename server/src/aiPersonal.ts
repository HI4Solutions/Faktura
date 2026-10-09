// AI-assistenten for personalmodulen: fravær, vikarer, vakter, tavla, rullering, timer og ferie
// med tale eller tekst («Kari er syk i dag, Per tar vaktene», «sett Ola på kassa i formiddag»,
// «før 7,5 timer i dag», «hvor mange feriedager har jeg igjen?»). Modellen velger handling og
// fyller ut feltene (aiAssistent.ts); her slås de ansatte, vaktene og timene opp, spørsmål
// besvares, og alt som endrer noe blir forslag som brukeren bekrefter i appen, og som utføres
// med de vanlige rutene og brukerens tilgang. Eier og administrator kan gjøre alt for alle;
// regnskap kan spørre; den ansatte (også med en annen rolle) melder seg syk, tar ledige vakter,
// fører og leverer timene sine, søker om å overføre ferie og spør om sitt eget.
import { alle, en, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { enLinje, type Skjema } from "./ai.js";
import { beregnUke, uke } from "./arbeidstid.js";
import { beregnBemanning } from "./arbeidsplan.js";
import { regler } from "./ansatte.js";
import { FRAVAERTYPER, periode } from "./fravaer.js";
import { iFasen } from "./rullering.js";
import { egnePlasser, kjorRullering } from "./tavle.js";
import { sammeNavn } from "./bank.js";
import { helligdag } from "./helligdager.js";

export const PERSONAL_HANDLINGER = [
  "fravaer", "vikar", "ny_vakt", "publiser_vakter", "ta_vakt", "plasser", "rullering", "for_timer", "lever_timer", "godkjenn_timer",
  "overfor_ferie", "svar_overforing", "hvem_jobber", "vakter", "timer", "ferie",
] as const;
export const PERSONAL_SIDER = ["vaktplan", "tavle", "kalender", "fravaer", "mine_vakter", "ledige_vakter", "timer", "godkjenning", "ferie", "ansatte"] as const;
export type PersonalHandling = (typeof PERSONAL_HANDLINGER)[number];
export type PersonalSide = (typeof PERSONAL_SIDER)[number];
type Fravaerstype = keyof typeof FRAVAERTYPER;

// Feltene modellen fyller ut for personal.
export type PersonalKommando = {
  ansatt: string | null;
  vikar: string | null;
  fravaerstype: Fravaerstype | null;
  fra_dato: string | null;
  til_dato: string | null;
  datoer: string[];
  klokke_fra: string | null;
  klokke_til: string | null;
  pause_min: number | null;
  timer: number | null;
  oppgave: string | null;
  fase: string | null;
  dager: number | null;
  godkjent: boolean | null;
  notat: string | null;
};

// Forslagene appen viser og utfører med de vanlige rutene når brukeren bekrefter.
export type PForslag =
  | {
      type: "fravaer";
      tekst: string;
      knapp: string;
      ansatt_id: string | null; // null: brukeren selv
      fravaerstype: Fravaerstype;
      fra: string;
      til: string;
      notat: string | null;
      vikar_id: string | null; // vikaren for vaktene i perioden (og de faste dagene)
      faste: string[]; // faste arbeidsdager i perioden (uten vakt), som får vikar gjennom /vakter/fra-plan
    }
  | { type: "vikar"; tekst: string; knapp: string; vakt_id: string | null; fast: { ansatt_id: string; dato: string } | null; vikar_id: string }
  | { type: "ny_vakt"; tekst: string; knapp: string; ansatt_id: string | null; dato: string; fra: string; til: string; pause_min: number; oppgave: string | null; notat: string | null }
  | { type: "publiser"; tekst: string; knapp: string; fra: string; til: string }
  | { type: "ta_vakt"; tekst: string; knapp: string; vakt_id: string }
  | { type: "plassering"; tekst: string; knapp: string; plasser: { dato: string; fase_id: string; oppgave_id: string; ansatt_id: string }[] }
  | { type: "rullering"; tekst: string; knapp: string; fra: string; til: string }
  | {
      type: "timer";
      tekst: string;
      knapp: string;
      ansatt_id: string | null;
      dato: string;
      fra: string | null;
      til: string | null;
      pause_min: number;
      timer: number | null;
      beskrivelse: string | null;
      vakt_id: string | null;
    }
  | { type: "lever_timer"; tekst: string; knapp: string; ansatt_id: string | null; fra: string; til: string }
  | { type: "godkjenn_timer"; tekst: string; knapp: string; ider: string[]; godkjent: boolean; grunn: string | null }
  | { type: "overforing"; tekst: string; knapp: string; ansatt_id: string | null; dager: number; begrunnelse: string | null; godkjent: boolean }
  | { type: "svar_overforing"; tekst: string; knapp: string; id: string; godkjent: boolean; svar: string | null };

type Lenke = { tekst: string; til: string };
export type PSvar = { tekst?: string; forslag?: PForslag[]; lenker?: Lenke[]; gaa_til?: string | null };

// ---------------------------------------------------------------------------
// Grunnlaget: de ansatte (A1 …), fasene (F1 …) og oppgavene (O1 …) på tavla, og tilgangen
// ---------------------------------------------------------------------------

export type PAnsatt = { id: string; navn: string };
export type PersonalGrunnlag = {
  ansatte: PAnsatt[]; // alle aktive for dem som ser de ansatte, ellers bare brukeren selv
  meg: string | null; // brukerens egen ansattrad
  faser: { id: string; navn: string; fra: string | null; til: string | null }[];
  oppgaver: { id: string; navn: string }[];
  // personal: eier og administrator; se: også regnskap; plan: også de aktive ansatte (vaktplanen og
  // tavla, 0063_ansatte_ser_planen.sql).
  kan: { personal: boolean; se: boolean; ferie: boolean; plan: boolean };
  vaktplan: boolean; // funksjonen «Vaktplan og bemanning» (vakter, tavle, fravær og ferie)
  // Åpent i helgene (0064_helg.sql); stengt: perioder («hele neste uke») er mandag–fredag.
  helg: boolean;
};

// null: personalmodulen er ikke slått på, eller brukeren verken ser de ansatte eller er ansatt.
export async function hentPersonal(db: Db, org: string): Promise<PersonalGrunnlag | null> {
  const k = await en<{ personal: boolean; se: boolean; plan: boolean; aktiv: boolean; vaktplan: boolean; helg: boolean; meg: string | null }>(
    db,
    `select faktura.kan($1, 'personal') as personal, faktura.kan($1, 'personal_les') as se, faktura.kan($1, 'plan') as plan,
            coalesce((select l.aktiv from faktura.lonn_oppsett l where l.org_id = $1), false) and faktura.har_funksjon($1, 'ansatte') as aktiv,
            coalesce((select l.helg from faktura.lonn_oppsett l where l.org_id = $1), true) as helg,
            faktura.har_funksjon($1, 'vaktplan') as vaktplan, faktura.min_ansatt($1) as meg`,
    [org],
  );
  if (!k?.aktiv || (!k.se && !k.meg)) return null;
  const ansatte = await alle<PAnsatt>(
    db,
    `select a.id, a.fornavn || ' ' || a.etternavn as navn from faktura.ansatte a
      where a.org_id = $1 and (a.aktiv or a.id = $2) and ($3 or a.id = $2)
      order by a.id = $2 desc nulls last, a.fornavn, a.etternavn limit 500`,
    [org, k.meg, k.se],
  );
  const tavle = k.vaktplan && k.se;
  return {
    ansatte,
    meg: k.meg,
    faser: tavle
      ? await alle(db, "select id, navn, to_char(fra, 'HH24:MI') as fra, to_char(til, 'HH24:MI') as til from faktura.tavle_faser where org_id = $1 order by rekkefolge, opprettet", [org])
      : [],
    oppgaver: tavle ? await alle(db, "select id, navn from faktura.tavle_oppgaver where org_id = $1 order by rekkefolge, opprettet", [org]) : [],
    // Feriebanken ser eier, administrator og den ansatte selv (ikke regnskap).
    kan: { personal: k.personal, se: k.se, ferie: k.personal || !!k.meg, plan: k.plan },
    vaktplan: k.vaktplan,
    helg: k.helg,
  };
}

// Registrene modellen får se (korte id-er, så den bare kan velge blant dem).
export function personalRegister(p: PersonalGrunnlag): string {
  const deler = [
    `Ansatte (id: navn):\n${p.ansatte.map((a, i) => `A${i + 1}: ${enLinje(a.navn)}${a.id === p.meg ? " (deg)" : ""}`).join("\n") || "(ingen)"}`,
  ];
  if (!p.meg) deler.push("Brukeren er ikke selv registrert som ansatt.");
  if (!p.helg) deler.push("Stengt i helgene: «denne uka», «neste uke» og andre perioder gjelder mandag–fredag. Lørdag og søndag bare når brukeren sier dem.");
  if (p.faser.length) deler.push(`Fasene på tavla (id: navn):\n${p.faser.map((f, i) => `F${i + 1}: ${enLinje(f.navn, 40)}${f.fra ? ` ${f.fra}–${f.til}` : ""}`).join("\n")}`);
  if (p.oppgaver.length) deler.push(`Oppgavene på tavla (id: navn):\n${p.oppgaver.map((o, i) => `O${i + 1}: ${enLinje(o.navn, 40)}`).join("\n")}`);
  return deler.join("\n\n");
}

// ---------------------------------------------------------------------------
// Svarskjemaet og reglene for personal (settes sammen med fakturadelen i aiAssistent.ts)
// ---------------------------------------------------------------------------

const tekst = (beskrivelse: string): Skjema => ({ type: "STRING", nullable: true, description: beskrivelse });
export const personalFelt: Record<string, Skjema> = {
  ansatt: tekst("Den ansatte det gjelder: id-en fra listen (A1, A2 …), ellers navnet slik brukeren sa det. Brukeren selv er merket (deg). null når det ikke gjelder én ansatt"),
  vikar: tekst("fravaer og vikar: den som tar over vaktene (id-en fra listen eller navnet), ellers null"),
  fravaerstype: { type: "STRING", nullable: true, enum: ["syk", "sykt_barn", "ferie", "permisjon", "kurs", "annet"], description: "fravaer: hva slags fravær, ellers null" },
  fra_dato: tekst("Første dag (ÅÅÅÅ-MM-DD), eller null"),
  til_dato: tekst("Siste dag (ÅÅÅÅ-MM-DD), eller null"),
  datoer: { type: "ARRAY", items: { type: "STRING" }, description: "ny_vakt, plasser og for_timer: alle dagene det gjelder (ÅÅÅÅ-MM-DD)" },
  klokke_fra: tekst("Fra klokken (TT:MM), eller null"),
  klokke_til: tekst("Til klokken (TT:MM), eller null"),
  pause_min: { type: "INTEGER", nullable: true, description: "Pause i minutter når brukeren sier den, ellers null" },
  timer: { type: "NUMBER", nullable: true, description: "for_timer: antall timer når brukeren sier det uten klokkeslett, ellers null" },
  oppgave: tekst("Oppgaven: id-en på tavla (O1, O2 …) når den står der, ellers slik brukeren sa den, eller null"),
  fase: tekst("Fasen på tavla (F1, F2 …), eller null for hele dagen"),
  dager: { type: "NUMBER", nullable: true, description: "overfor_ferie: antall feriedager, ellers null" },
  godkjent: { type: "BOOLEAN", nullable: true, description: "godkjenn_timer og svar_overforing: true for å godkjenne, false for å avvise eller avslå, ellers null" },
  notat: tekst("Notat til fraværet, beskrivelse av timene, begrunnelse eller svar, eller null"),
};

export const personalHandlingtekst = [
  "- fravaer: registrere fravær («Kari er syk i dag», «jeg er syk», «Ola har ferie 1.–5. juli», «jeg har sykt barn i morgen»). fravaerstype, fra_dato og til_dato (samme dag når bare én dag er sagt). Sier brukeren hvem som tar vaktene («… og Per er vikar»), sett vikar.",
  "- vikar: sette inn en vikar for en ansatt som er borte («Per er vikar for Kari på fredag»). ansatt er den som er borte, vikar den som tar over, fra_dato og til_dato dagene.",
  "- ny_vakt: legge inn vakter («legg inn vakt for Kari fredag 08–16», «Ola jobber 9–17 mandag til onsdag», «lag en ledig vakt lørdag 10–18»). datoer (alle dagene), klokke_fra og klokke_til, pause_min og oppgave når de sies. En ledig vakt har ansatt null.",
  "- publiser_vakter: publisere vaktplanen så de ansatte ser den («publiser neste uke», «send ut vaktplanen»). fra_dato og til_dato (mandag til søndag for en uke).",
  "- ta_vakt: brukeren vil ta en ledig vakt («jeg tar den ledige vakten på lørdag»). fra_dato og til_dato.",
  "- plasser: sette en ansatt i en oppgave på tavla («sett Kari på kassa i dag», «Ola på lager etter lunsj»). oppgave, fase (null for hele dagen) og datoer.",
  "- rullering: fordele de som er på jobb på oppgavene på tavla av seg selv («lag rullering for neste uke», «fordel folk på tavla i morgen»). fra_dato og til_dato.",
  "- for_timer: føre timer («før 7,5 timer i dag», «jeg jobbet 8–16 i går med 30 minutter pause», «før timer for Kari fredag 9–15»). datoer, klokke_fra og klokke_til eller timer, pause_min, og notat for hva som ble gjort.",
  "- lever_timer: levere timene til godkjenning («lever timene for denne uka»). fra_dato og til_dato (mandag til søndag for en uke).",
  "- godkjenn_timer: godkjenne (godkjent true) eller avvise (godkjent false, grunnen i notat) leverte timer («godkjenn timene til Kari for forrige uke», «godkjenn alle leverte timer»).",
  "- overfor_ferie: søke om å overføre feriedager til neste år («jeg vil overføre 5 feriedager til neste år»). dager, og notat for begrunnelsen.",
  "- svar_overforing: godkjenne (godkjent true) eller avslå (false) en søknad om å overføre ferie («godkjenn ferieoverføringen til Kari»). notat for svaret.",
  "- hvem_jobber: spørsmål om hvem som er på jobb, borte eller syk, vakter som mangler vikar og ledige vakter («hvem jobber i dag?», «hvem er syke denne uka?»). fra_dato og til_dato.",
  "- vakter: spørsmål om vaktene til én ansatt eller brukeren selv («når jobber jeg neste gang?», «har Kari vakt i morgen?»). ansatt, fra_dato og til_dato.",
  "- timer: spørsmål om førte timer, overtid og timer som venter på godkjenning («hvor mange timer har jeg ført denne uka?», «hvem har ikke levert timer?»).",
  "- ferie: spørsmål om feriedager og ferie («hvor mange feriedager har jeg igjen?», «hvor mye ferie har Kari igjen?»).",
];
export const personalVis = "«åpne tavla» gir side tavle, «vis vaktplanen» vaktplan, «gå til timene» timer, «vis feriebanken» ferie, «timer til godkjenning» godkjenning";
export const personalRegler = [
  "- ansatt og vikar: id-en fra listen over ansatte (A1, A2 …); står personen ikke der, navnet slik brukeren sa det. «Jeg» og «meg» er den som er merket (deg).",
  "- oppgave og fase: id-en fra tavla (O1, F1 …) når den står der, ellers slik brukeren sa det.",
  "- Klokkeslett som TT:MM med 24 timer («halv ni» er 08:30, «kvart over sju» 07:15, «fire» om ettermiddagen 16:00).",
  "- «Denne uka», «neste uke» og «forrige uke» er mandag til søndag.",
];

// ---------------------------------------------------------------------------
// Hjelpere
// ---------------------------------------------------------------------------

export type PKontekst = { db: Db; orgId: string; p: PersonalGrunnlag; iDag: string };

const gyldig = (s: unknown): s is string => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const pluss = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const erHelg = (d: string) => [0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay());
const dagerMellom = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
const dagFormat = new Intl.DateTimeFormat("nb-NO", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const dag = (iso: string) => dagFormat.format(new Date(`${iso}T12:00:00Z`));
const timerTekst = (t: number) => `${Number(t).toLocaleString("nb-NO", { maximumFractionDigits: 2 })} t`;
const dagerTekst = (n: number) => `${String(n).replace(".", ",")} ${n === 1 ? "feriedag" : "feriedager"}`;
const flertall = (n: number, en: string, flere: string) => `${n} ${n === 1 ? en : flere}`;
const liste = (x: string[]) => (x.length < 2 ? (x[0] ?? "") : `${x.slice(0, -1).join(", ")} og ${x.at(-1)}`);
const forkort = (x: string[], maks = 8) => (x.length > maks ? [...x.slice(0, maks), `${x.length - maks} til`] : x);
const ingen = (hva: string): PSvar => ({ tekst: `Du har ikke tilgang til å ${hva}.` });
const UTEN_VAKTPLAN: PSvar = { tekst: "Vaktplan og bemanning er ikke slått på for organisasjonen." };
const typeTekst = (t: string | null) => (t && t in FRAVAERTYPER ? FRAVAERTYPER[t as Fravaerstype].toLowerCase() : "fravær");

// I dag, i morgen, i går, ellers datoen.
function naar(d: string, iDag: string) {
  if (d === iDag) return "i dag";
  if (d === pluss(iDag, 1)) return "i morgen";
  if (d === pluss(iDag, -1)) return "i går";
  return dag(d);
}
function naarPeriode(fra: string, til: string, iDag: string) {
  if (fra === til) return naar(fra, iDag);
  const u = uke(fra);
  if (u.fra === fra && u.til === til) return `uke ${u.uke} (${periode(fra, til)})`;
  return periode(fra, til);
}

// «8», «8:00», «08.30» → TT:MM.
export function klokke(s: unknown): string | null {
  const m = typeof s === "string" ? s.trim().match(/^(\d{1,2})(?:[:.](\d{2}))?$/) : null;
  if (!m) return null;
  const t = Number(m[1]);
  const mi = Number(m[2] ?? 0);
  return t < 24 && mi < 60 ? `${String(t).padStart(2, "0")}:${String(mi).padStart(2, "0")}` : null;
}
const minutt = (k: string) => Number(k.slice(0, 2)) * 60 + Number(k.slice(3, 5));
export const varighet = (fra: string, til: string, pause: number) => {
  let m = minutt(til) - minutt(fra);
  if (m <= 0) m += 1440;
  return Math.max(0, Math.round(((m - pause) / 60) * 100) / 100);
};

// Perioden i kommandoen (fra_dato–til_dato), med standard og et tak på antall dager.
function periodeFra(ai: Partial<PersonalKommando>, iDag: string, standard: [string, string], maks: number): [string, string] | string {
  const fra = gyldig(ai.fra_dato) ? ai.fra_dato : gyldig(ai.til_dato) ? ai.til_dato : standard[0];
  let til = gyldig(ai.til_dato) ? ai.til_dato : gyldig(ai.fra_dato) ? fra : standard[1];
  if (til < fra) til = fra;
  if (dagerMellom(fra, til) >= maks) return `Velg en periode på høyst ${maks} dager.`;
  return [fra, til];
}
// Dagene i kommandoen (datoer, ellers fra_dato–til_dato, ellers i dag). Med stengt helg er en
// periode mandag–fredag (en enkelt dag og datoene brukeren sa, gjelder likevel).
function dagerFra(ai: Partial<PersonalKommando>, iDag: string, maks: number, helg = true): string[] {
  const d = (Array.isArray(ai.datoer) ? ai.datoer : []).filter(gyldig);
  if (d.length) return [...new Set(d)].sort().slice(0, maks);
  const p = periodeFra(ai, iDag, [iDag, iDag], 62);
  if (typeof p === "string") return [iDag];
  const ut: string[] = [];
  for (let x = p[0]; x <= p[1] && ut.length < maks; x = pluss(x, 1)) if (helg || p[0] === p[1] || !erHelg(x)) ut.push(x);
  return ut.length ? ut : [p[0]];
}

const MEG = /^(jeg|meg|meg selv|deg|deg selv|selv)$/i;
// Den ansatte modellen viste til (A1 …, eller et navn som bare passer én).
export function finnAnsatt(p: PersonalGrunnlag, verdi: unknown): { a: PAnsatt | null; ukjent: string | null } {
  const t = enLinje(verdi, 120);
  if (!t) return { a: null, ukjent: null };
  if (MEG.test(t)) return { a: p.ansatte.find((x) => x.id === p.meg) ?? null, ukjent: p.meg ? null : "deg" };
  const m = t.toUpperCase().match(/^A(\d+)$/);
  if (m) {
    const a = p.ansatte[Number(m[1]) - 1];
    return a ? { a, ukjent: null } : { a: null, ukjent: t };
  }
  const n = t.toLowerCase();
  const treff = [
    p.ansatte.filter((x) => x.navn.toLowerCase() === n),
    p.ansatte.filter((x) => sammeNavn(x.navn, t)),
    n.includes(" ") ? [] : p.ansatte.filter((x) => x.navn.toLowerCase().split(/\s+/)[0] === n),
    n.includes(" ") ? [] : p.ansatte.filter((x) => x.navn.toLowerCase().split(/\s+/).at(-1) === n),
  ].find((x) => x.length === 1);
  return treff ? { a: treff[0]!, ukjent: null } : { a: null, ukjent: t };
}

// Den det gjelder: den som er nevnt, ellers brukeren selv.
function hvem(k: PKontekst, ai: Partial<PersonalKommando>): { a: PAnsatt | null; ukjent: string | null; selv: boolean } {
  const r = finnAnsatt(k.p, ai.ansatt);
  if (r.ukjent) return { a: null, ukjent: r.ukjent, selv: false };
  const a = r.a ?? k.p.ansatte.find((x) => x.id === k.p.meg) ?? null;
  return { a, ukjent: null, selv: !!a && a.id === k.p.meg };
}
// Fant ikke personen: for den som ser de ansatte, er navnet ukjent; ellers er det en annen ansatt.
const ukjentSvar = (k: PKontekst, navn: string, hva: string): PSvar =>
  navn === "deg" ? { tekst: "Du er ikke registrert som ansatt her." } : k.p.kan.se ? { tekst: `Fant ikke «${navn}» blant de ansatte.` } : ingen(hva);

function finnPaTavla<T extends { id: string; navn: string }>(liste: T[], prefiks: string, verdi: unknown): T | null {
  const t = enLinje(verdi, 80);
  if (!t) return null;
  const m = t.toUpperCase().match(new RegExp(`^${prefiks}(\\d+)$`));
  if (m) return liste[Number(m[1]) - 1] ?? null;
  const n = t.toLowerCase();
  const like = liste.filter((x) => x.navn.toLowerCase() === n);
  const ligner = like.length ? like : liste.filter((x) => x.navn.toLowerCase().includes(n) || n.includes(x.navn.toLowerCase()));
  return ligner.length === 1 ? ligner[0]! : null;
}

type VaktRad = {
  id: string;
  ansatt_id: string | null;
  navn: string | null;
  dato: string;
  fra: string;
  til: string;
  pause_min: number;
  timer: number;
  oppgave: string | null;
  publisert: boolean;
  vikar_for: string | null;
  har_vikar: boolean;
  fravaer: string | null;
};
const VAKTER = `
  select v.id, v.ansatt_id, a.fornavn || ' ' || a.etternavn as navn, v.dato, to_char(v.fra, 'HH24:MI') as fra, to_char(v.til, 'HH24:MI') as til,
         v.pause_min, v.timer, v.oppgave, v.publisert_at is not null as publisert, v.vikar_for,
         exists (select 1 from faktura.vakter x where x.org_id = v.org_id and x.vikar_for = v.id) as har_vikar,
         (select faktura.fravaer_type(f.org_id, f.ansatt_id, f.type) from faktura.fravaer f
           where f.org_id = v.org_id and f.ansatt_id = v.ansatt_id and v.dato between f.fra and f.til limit 1) as fravaer
    from faktura.vakter v left join faktura.ansatte a on a.org_id = v.org_id and a.id = v.ansatt_id`;
const vaktTekst = (v: Pick<VaktRad, "dato" | "fra" | "til" | "oppgave">, iDag?: string) => `${iDag ? naar(v.dato, iDag) : dag(v.dato)} ${v.fra}–${v.til}${v.oppgave ? ` (${v.oppgave})` : ""}`;

// ---------------------------------------------------------------------------
// Handlingene
// ---------------------------------------------------------------------------

async function fravaer(k: PKontekst, ai: Partial<PersonalKommando>): Promise<PSvar> {
  if (!k.p.vaktplan) return UTEN_VAKTPLAN;
  const h = hvem(k, ai);
  if (h.ukjent) return ukjentSvar(k, h.ukjent, "registrere fravær for andre");
  if (!h.a) return { tekst: "Hvem gjelder fraværet?" };
  if (!h.selv && !k.p.kan.personal) return ingen("registrere fravær for andre");
  const type: Fravaerstype = ai.fravaerstype && ai.fravaerstype in FRAVAERTYPER ? ai.fravaerstype : "annet";
  // Den ansatte melder selv sykdom (fra og med i går, som i databasen); resten registrerer lederen.
  if (h.selv && !k.p.kan.personal && type !== "syk" && type !== "sykt_barn")
    return { tekst: "Selv kan du melde sykdom og sykt barn. Ferie, permisjon og annet fravær registrerer lederen din." };
  const p = periodeFra(ai, k.iDag, [k.iDag, k.iDag], 366);
  if (typeof p === "string") return { tekst: p };
  const [fra, til] = p;
  if (h.selv && !k.p.kan.personal && fra < pluss(k.iDag, -1)) return { tekst: "Sykdom kan meldes fra og med i går. Snakk med lederen din om dagene før." };

  const vikar = finnAnsatt(k.p, ai.vikar);
  if (vikar.ukjent) return { tekst: `Fant ikke «${vikar.ukjent}» blant de ansatte.` };
  if (vikar.a && !k.p.kan.personal) return ingen("sette inn vikarer");
  if (vikar.a?.id === h.a.id) return { tekst: "Vikaren må være en annen enn den som er borte." };

  // Vaktene og de faste dagene i perioden som får vikar (eller står som «mangler vikar»).
  const vakter = (await alle<VaktRad>(k.db, `${VAKTER} where v.org_id = $1 and v.ansatt_id = $2 and v.dato between $3 and $4 order by v.dato, v.fra`, [k.orgId, h.a.id, fra, til])).filter(
    (v) => !v.har_vikar,
  );
  const faste = k.p.kan.personal ? (await beregnBemanning(k.db, k.orgId, fra, til, h.a.id)).faste.filter((f) => f.dato >= fra && f.dato <= til && !f.fravaer) : [];
  const navn = h.selv ? "deg" : h.a.navn;
  const deler = [`${FRAVAERTYPER[type]} for ${navn} ${naarPeriode(fra, til, k.iDag)}.`];
  const dager = [...vakter.map((v) => vaktTekst(v)), ...faste.map((f) => `${dag(f.dato)}${f.fra ? ` ${f.fra}–${f.til}` : ""}`)];
  if (dager.length) {
    deler.push(`${h.selv ? "Du" : h.a.navn} har ${flertall(dager.length, "vakt", "vakter")} i perioden: ${liste(forkort(dager, 6))}.`);
    deler.push(vikar.a ? `${vikar.a.navn} settes inn som vikar.` : h.selv ? "Lederen din får beskjed." : "De står som «mangler vikar» på tavla til en vikar er satt inn.");
  } else if (vikar.a) deler.push(`${h.a.navn} har ingen vakter i perioden, så det trengs ingen vikar.`);
  const egen = h.selv && (type === "syk" || type === "sykt_barn");
  return {
    tekst: deler.join(" "),
    forslag: [
      {
        type: "fravaer",
        ansatt_id: h.selv ? null : h.a.id,
        fravaerstype: type,
        fra,
        til,
        notat: enLinje(ai.notat, 500) || null,
        vikar_id: dager.length ? (vikar.a?.id ?? null) : null,
        faste: vikar.a ? faste.map((f) => f.dato) : [],
        tekst: `Registrer ${typeTekst(type)} for ${h.selv ? "deg" : h.a.navn} ${periode(fra, til)}${vikar.a && dager.length ? `, med ${vikar.a.navn} som vikar` : ""}.`,
        knapp: egen ? "Meld fravær" : "Registrer fravær",
      },
    ],
    lenker: k.p.kan.se ? [{ tekst: "Tavla", til: `/vakter?fane=tavle&dato=${fra}` }] : [],
  };
}

async function vikar(k: PKontekst, ai: Partial<PersonalKommando>): Promise<PSvar> {
  if (!k.p.vaktplan) return UTEN_VAKTPLAN;
  if (!k.p.kan.personal) return ingen("sette inn vikarer");
  const borte = finnAnsatt(k.p, ai.ansatt);
  const v = finnAnsatt(k.p, ai.vikar);
  if (borte.ukjent || v.ukjent) return { tekst: `Fant ikke «${borte.ukjent ?? v.ukjent}» blant de ansatte.` };
  if (!borte.a) return { tekst: "Hvem er borte? Si for eksempel «Per er vikar for Kari på fredag»." };
  if (!v.a) return { tekst: `Hvem skal være vikar for ${borte.a.navn}?` };
  if (v.a.id === borte.a.id) return { tekst: "Vikaren må være en annen enn den som er borte." };
  const p = periodeFra(ai, k.iDag, [k.iDag, k.iDag], 31);
  if (typeof p === "string") return { tekst: p };
  const [fra, til] = p;
  const vakter = (await alle<VaktRad>(k.db, `${VAKTER} where v.org_id = $1 and v.ansatt_id = $2 and v.dato between $3 and $4 order by v.dato, v.fra`, [k.orgId, borte.a.id, fra, til])).filter(
    (x) => !x.har_vikar,
  );
  const faste = (await beregnBemanning(k.db, k.orgId, fra, til, borte.a.id)).faste.filter((f) => f.dato >= fra && f.dato <= til);
  if (!vakter.length && !faste.length)
    return { tekst: `${borte.a.navn} har ingen vakter eller faste arbeidsdager uten vikar ${naarPeriode(fra, til, k.iDag)}.` };
  // Har vikaren selv vakt de dagene?
  const egne = await alle<VaktRad>(k.db, `${VAKTER} where v.org_id = $1 and v.ansatt_id = $2 and v.dato between $3 and $4 order by v.dato, v.fra`, [k.orgId, v.a.id, fra, til]);
  const forslag: PForslag[] = [
    ...vakter.map((x) => ({ type: "vikar" as const, vakt_id: x.id, fast: null, vikar_id: v.a!.id, tekst: `${v.a!.navn} tar vakten til ${borte.a!.navn} ${vaktTekst(x)}.`, knapp: "Sett inn vikar" })),
    ...faste.map((f) => ({
      type: "vikar" as const,
      vakt_id: null,
      fast: { ansatt_id: borte.a!.id, dato: f.dato },
      vikar_id: v.a!.id,
      tekst: `${v.a!.navn} tar den faste dagen til ${borte.a!.navn} ${dag(f.dato)}${f.fra ? ` ${f.fra}–${f.til}` : ""}.`,
      knapp: "Sett inn vikar",
    })),
  ].slice(0, 14);
  const deler = [forslag.length === 1 ? "Skal jeg sette inn vikaren?" : `${flertall(forslag.length, "vakt", "vakter")} kan få vikar.`];
  const kolliderer = egne.filter((e) => vakter.some((x) => x.dato === e.dato) || faste.some((f) => f.dato === e.dato));
  if (kolliderer.length) deler.push(`${v.a.navn} har selv vakt ${liste(kolliderer.map((e) => vaktTekst(e)))}.`);
  return { tekst: deler.join(" "), forslag, lenker: [{ tekst: "Tavla", til: `/vakter?fane=tavle&dato=${fra}` }] };
}

async function nyVakt(k: PKontekst, ai: Partial<PersonalKommando>): Promise<PSvar> {
  if (!k.p.vaktplan) return UTEN_VAKTPLAN;
  if (!k.p.kan.personal) return ingen("legge inn vakter");
  const a = finnAnsatt(k.p, ai.ansatt);
  if (a.ukjent) return { tekst: `Fant ikke «${a.ukjent}» blant de ansatte.` };
  const fra = klokke(ai.klokke_fra);
  const til = klokke(ai.klokke_til);
  if (!fra || !til) return { tekst: "Hvilket klokkeslett? Si for eksempel «08–16»." };
  const dager = dagerFra(ai, k.iDag, 14, k.p.helg);
  const pause = typeof ai.pause_min === "number" && ai.pause_min >= 0 && ai.pause_min <= 600 ? Math.round(ai.pause_min) : 0;
  const o = finnPaTavla(k.p.oppgaver, "O", ai.oppgave);
  const oppgave = o?.navn ?? (enLinje(ai.oppgave, 60) || null);
  const borte = a.a
    ? await alle<{ fra: string; til: string; type: string }>(
        k.db,
        "select fra, til, faktura.fravaer_type(org_id, ansatt_id, type) as type from faktura.fravaer where org_id = $1 and ansatt_id = $2 and til >= $3 and fra <= $4",
        [k.orgId, a.a.id, dager[0], dager.at(-1)],
      )
    : [];
  const finnes = a.a
    ? await alle<VaktRad>(k.db, `${VAKTER} where v.org_id = $1 and v.ansatt_id = $2 and v.dato = any($3::date[]) order by v.dato, v.fra`, [k.orgId, a.a.id, dager])
    : [];
  const hvemTekst = a.a ? a.a.navn : "ledig vakt";
  const t = varighet(fra, til, pause);
  const forslag: PForslag[] = dager.map((d) => ({
    type: "ny_vakt",
    ansatt_id: a.a?.id ?? null,
    dato: d,
    fra,
    til,
    pause_min: pause,
    oppgave,
    notat: enLinje(ai.notat, 500) || null,
    tekst: `${a.a ? `Vakt for ${a.a.navn}` : "Ledig vakt"} ${dag(d)} ${fra}–${til}${pause ? ` (${pause} min pause)` : ""}${oppgave ? `, ${oppgave}` : ""}: ${timerTekst(t)}.`,
    knapp: "Lag vakt",
  }));
  const deler = [forslag.length === 1 ? `Skal jeg legge inn vakten (${hvemTekst})?` : `${flertall(forslag.length, "vakt", "vakter")} for ${hvemTekst}.`];
  for (const f of borte) deler.push(`${a.a!.navn} er borte (${typeTekst(f.type)}) ${periode(f.fra, f.til)}.`);
  if (finnes.length) deler.push(`${a.a!.navn} har allerede vakt ${liste(finnes.map((v) => vaktTekst(v)))}.`);
  deler.push("Vaktene er utkast til de publiseres.");
  return { tekst: deler.join(" "), forslag, lenker: [{ tekst: `Vaktplanen uke ${uke(dager[0]!).uke}`, til: `/vakter?uke=${uke(dager[0]!).fra}` }] };
}

async function publiser(k: PKontekst, ai: Partial<PersonalKommando>): Promise<PSvar> {
  if (!k.p.vaktplan) return UTEN_VAKTPLAN;
  if (!k.p.kan.personal) return ingen("publisere vaktplanen");
  let fra: string;
  let til: string;
  if (gyldig(ai.fra_dato) || gyldig(ai.til_dato)) {
    const p = periodeFra(ai, k.iDag, [k.iDag, k.iDag], 93);
    if (typeof p === "string") return { tekst: p };
    [fra, til] = p;
  } else {
    // Uten dato: uka med den første upubliserte vakten fra i dag.
    const forste = await en<{ dato: string }>(
      k.db,
      "select min(dato)::text as dato from faktura.vakter where org_id = $1 and publisert_at is null and dato >= $2",
      [k.orgId, k.iDag],
    );
    if (!forste?.dato) return { tekst: "Det er ingen upubliserte vakter fra i dag og framover." };
    ({ fra, til } = uke(forste.dato));
  }
  const s = await en<{ antall: number; ansatte: number; ledige: number }>(
    k.db,
    `select count(*)::int as antall, count(distinct ansatt_id)::int as ansatte, (count(*) filter (where ansatt_id is null))::int as ledige
       from faktura.vakter where org_id = $1 and publisert_at is null and dato between $2 and $3`,
    [k.orgId, fra, til],
  );
  if (!s?.antall) return { tekst: `Det er ingen upubliserte vakter ${naarPeriode(fra, til, k.iDag)}.` };
  const deler = [`Publiser ${flertall(s.antall, "vakt", "vakter")} ${naarPeriode(fra, til, k.iDag)}.`];
  if (s.ansatte) deler.push(`${flertall(s.ansatte, "ansatt", "ansatte")} får varsel.`);
  if (s.ledige) deler.push(`${flertall(s.ledige, "ledig vakt blir synlig", "ledige vakter blir synlige")} for alle.`);
  return {
    tekst: "Skal jeg publisere vaktplanen?",
    forslag: [{ type: "publiser", fra, til, tekst: deler.join(" "), knapp: "Publiser" }],
    lenker: [{ tekst: `Vaktplanen uke ${uke(fra).uke}`, til: `/vakter?uke=${uke(fra).fra}` }],
  };
}

async function taVakt(k: PKontekst, ai: Partial<PersonalKommando>): Promise<PSvar> {
  if (!k.p.vaktplan) return UTEN_VAKTPLAN;
  if (!k.p.meg) return { tekst: "Bare ansatte kan ta ledige vakter, og du er ikke registrert som ansatt her." };
  const p = periodeFra(ai, k.iDag, [k.iDag, pluss(k.iDag, 55)], 93);
  if (typeof p === "string") return { tekst: p };
  const [fra, til] = p;
  const ledige = await alle<VaktRad>(
    k.db,
    `${VAKTER} where v.org_id = $1 and v.ansatt_id is null and v.publisert_at is not null and v.dato between $2 and $3 and v.dato >= $4 order by v.dato, v.fra limit 6`,
    [k.orgId, fra, til, k.iDag],
  );
  if (!ledige.length) return { tekst: `Det er ingen ledige vakter ${naarPeriode(fra, til, k.iDag)}.`, lenker: [{ tekst: "Ledige vakter", til: "/vakter?fane=ledige" }] };
  return {
    tekst: ledige.length === 1 ? "Vil du ta vakten?" : `Det er ${flertall(ledige.length, "ledig vakt", "ledige vakter")}. Hvilken vil du ta?`,
    forslag: ledige.slice(0, 5).map((v) => ({ type: "ta_vakt", vakt_id: v.id, tekst: `Ledig vakt ${vaktTekst(v, k.iDag)}: ${timerTekst(v.timer)}.`, knapp: "Ta vakten" })),
    lenker: [{ tekst: "Ledige vakter", til: "/vakter?fane=ledige" }],
  };
}

async function plasser(k: PKontekst, ai: Partial<PersonalKommando>): Promise<PSvar> {
  if (!k.p.vaktplan) return UTEN_VAKTPLAN;
  if (!k.p.kan.personal) return ingen("plassere ansatte på tavla");
  if (!k.p.faser.length || !k.p.oppgaver.length) return { tekst: "Sett opp fasene og oppgavene på tavla først.", lenker: [{ tekst: "Tavla", til: "/vakter?fane=tavle" }] };
  const a = finnAnsatt(k.p, ai.ansatt);
  if (a.ukjent) return { tekst: `Fant ikke «${a.ukjent}» blant de ansatte.` };
  if (!a.a) return { tekst: "Hvem skal plasseres?" };
  // En rolle som ikke er med på tavla (f.eks. legene, 0057_rolle_tavle.sql).
  const utenfor = await en<{ rolle: string }>(
    k.db,
    "select g.navn as rolle from faktura.ansatte a join faktura.ansattgrupper g on g.org_id = a.org_id and g.id = a.gruppe_id where a.org_id = $1 and a.id = $2 and not g.tavle",
    [k.orgId, a.a.id],
  );
  if (utenfor) return { tekst: `${a.a.navn} er ikke med på tavla (rollen ${utenfor.rolle}).` };
  const o = finnPaTavla(k.p.oppgaver, "O", ai.oppgave);
  if (!o) return { tekst: `${enLinje(ai.oppgave, 60) ? `Fant ikke oppgaven «${enLinje(ai.oppgave, 60)}» på tavla.` : "Hvilken oppgave?"} Oppgavene er ${liste(k.p.oppgaver.map((x) => x.navn))}.` };
  const fase = ai.fase ? finnPaTavla(k.p.faser, "F", ai.fase) : null;
  if (ai.fase && !fase) return { tekst: `Fant ikke fasen «${enLinje(ai.fase, 40)}». Fasene er ${liste(k.p.faser.map((x) => x.navn))}.` };
  const dager = dagerFra(ai, k.iDag, 7, k.p.helg);
  // Når den ansatte er på jobb (vakter og faste dager), og hvilke faser det dekker.
  const b = await beregnBemanning(k.db, k.orgId, dager[0]!, dager.at(-1)!, a.a.id);
  const plasser: { dato: string; fase_id: string; oppgave_id: string; ansatt_id: string }[] = [];
  const ikke: string[] = [];
  for (const d of dager) {
    const tider = [
      ...b.vakter.filter((v) => v.dato === d && !v.borte).map((v) => ({ fra: v.fra, til: v.til })),
      ...b.faste.filter((f) => f.dato === d && !f.fravaer).map((f) => ({ fra: f.fra, til: f.til })),
    ];
    const faser = (fase ? [fase] : k.p.faser).filter((f) => tider.some((t) => iFasen(t, f)));
    if (!faser.length) ikke.push(dag(d));
    for (const f of faser) plasser.push({ dato: d, fase_id: f.id, oppgave_id: o.id, ansatt_id: a.a.id });
  }
  const deler: string[] = [];
  if (ikke.length) deler.push(`${a.a.navn} er ikke på jobb ${fase ? `i ${fase.navn.toLowerCase()} ` : ""}${liste(ikke)}.`);
  if (!plasser.length) return { tekst: deler.join(" ") || `${a.a.navn} er ikke på jobb da.` };
  const fasenavn = [...new Set(plasser.map((x) => k.p.faser.find((f) => f.id === x.fase_id)!.navn.toLowerCase()))];
  const dagene = [...new Set(plasser.map((x) => x.dato))];
  return {
    tekst: deler.join(" ") || "Skal jeg plassere den ansatte?",
    forslag: [
      {
        type: "plassering",
        plasser,
        tekst: `${a.a.navn} på ${o.navn} ${dagene.length === 1 ? naar(dagene[0]!, k.iDag) : liste(dagene.map(dag))} (${liste(fasenavn)}).`,
        knapp: "Plasser",
      },
    ],
    lenker: [{ tekst: "Tavla", til: `/vakter?fane=tavle&dato=${dagene[0]}` }],
  };
}

async function rullering(k: PKontekst, ai: Partial<PersonalKommando>): Promise<PSvar> {
  if (!k.p.vaktplan) return UTEN_VAKTPLAN;
  if (!k.p.kan.personal) return ingen("fordele de ansatte på tavla");
  const p = periodeFra(ai, k.iDag, [k.iDag, k.iDag], 31);
  if (typeof p === "string") return { tekst: p };
  const [fra, til] = p;
  let r: Awaited<ReturnType<typeof kjorRullering>>;
  try {
    r = await kjorRullering(k.db, k.orgId, { fra, til });
  } catch (e) {
    if (e instanceof ApiFeil) return { tekst: e.message, lenker: [{ tekst: "Tavla", til: `/vakter?fane=tavle&dato=${fra}` }] };
    throw e;
  }
  const lenker = [{ tekst: "Tavla", til: `/vakter?fane=tavle&dato=${fra}` }];
  if (!r.plasser) return { tekst: `Ingen er på jobb ${naarPeriode(fra, til, k.iDag)} som rulleringen kan fordele.`, lenker };
  const deler = [
    `Rulleringen fordeler ${flertall(r.ansatte.length, "ansatt", "ansatte")} på ${flertall(r.plasser, "plass", "plasser")} ${naarPeriode(fra, til, k.iDag)}, så alle får gjøre alt etter tur.`,
    r.endret ? `${flertall(r.endret, "plass blir", "plasser blir")} annerledes enn nå.` : "Det blir som det står nå.",
  ];
  const mangler = r.dager.flatMap((d) =>
    d.mangler.map((m) => `${r.oppgaver.find((o) => o.id === m.oppgave_id)?.navn ?? "?"} ${dag(d.dato)} ${(r.faser.find((f) => f.id === m.fase_id)?.navn ?? "").toLowerCase()} (${m.antall})`),
  );
  if (mangler.length) deler.push(`Ikke nok folk: ${liste(forkort(mangler, 4))}.`);
  deler.push("Plasser som er satt for hånd, står.");
  return { tekst: deler.join(" "), forslag: [{ type: "rullering", fra, til, tekst: `Lagre rulleringen ${naarPeriode(fra, til, k.iDag)}.`, knapp: "Lagre rulleringen" }], lenker };
}

async function forTimer(k: PKontekst, ai: Partial<PersonalKommando>): Promise<PSvar> {
  const h = hvem(k, ai);
  if (h.ukjent) return ukjentSvar(k, h.ukjent, "føre timer for andre");
  if (!h.a) return { tekst: "Du er ikke registrert som ansatt her. Si hvem timene skal føres på." };
  if (!h.selv && !k.p.kan.personal) return ingen("føre timer for andre");
  const dager = dagerFra(ai, k.iDag, 14, k.p.helg);
  if (dager.some((d) => d > k.iDag)) return { tekst: "Timer kan bare føres for dager som har vært (eller i dag)." };
  const fra = klokke(ai.klokke_fra);
  const til = klokke(ai.klokke_til);
  const timer = typeof ai.timer === "number" && ai.timer > 0 && ai.timer <= 24 ? Math.round(ai.timer * 100) / 100 : null;
  const pause = typeof ai.pause_min === "number" && ai.pause_min >= 0 && ai.pause_min <= 600 ? Math.round(ai.pause_min) : null;
  const beskrivelse = enLinje(ai.notat, 500) || null;
  // Uten tid: vakten eller den faste arbeidsdagen.
  const vakter = k.p.vaktplan
    ? await alle<VaktRad>(k.db, `${VAKTER} where v.org_id = $1 and v.ansatt_id = $2 and v.dato = any($3::date[]) and v.publisert_at is not null order by v.dato, v.fra`, [
        k.orgId,
        h.a.id,
        dager,
      ])
    : [];
  const faste = k.p.vaktplan ? (await beregnBemanning(k.db, k.orgId, dager[0]!, dager.at(-1)!, h.a.id)).faste : [];
  const fort = await alle<{ dato: string; timer: number }>(
    k.db,
    "select dato, sum(timer)::float as timer from faktura.timeforinger where org_id = $1 and ansatt_id = $2 and dato = any($3::date[]) group by dato",
    [k.orgId, h.a.id, dager],
  );
  const forslag: PForslag[] = [];
  const uten: string[] = [];
  for (const d of dager) {
    const v = vakter.find((x) => x.dato === d);
    const f = faste.find((x) => x.dato === d && !x.fravaer);
    let rad: { fra: string | null; til: string | null; pause: number; timer: number | null; vakt: string | null; kilde: string } | null = null;
    if (fra && til) rad = { fra, til, pause: pause ?? 0, timer: null, vakt: null, kilde: "" };
    else if (timer) rad = { fra: null, til: null, pause: 0, timer, vakt: null, kilde: "" };
    else if (v) rad = { fra: v.fra, til: v.til, pause: v.pause_min, timer: null, vakt: v.id, kilde: " fra vakten" };
    else if (f?.fra && f.til) rad = { fra: f.fra, til: f.til, pause: f.pause_min, timer: null, vakt: null, kilde: " fra den faste arbeidsdagen" };
    else if (f) rad = { fra: null, til: null, pause: 0, timer: f.timer, vakt: null, kilde: " fra den faste arbeidsdagen" };
    if (!rad) {
      uten.push(dag(d));
      continue;
    }
    const sum = rad.fra && rad.til ? varighet(rad.fra, rad.til, rad.pause) : rad.timer!;
    forslag.push({
      type: "timer",
      ansatt_id: h.selv ? null : h.a.id,
      dato: d,
      fra: rad.fra,
      til: rad.til,
      pause_min: rad.pause,
      timer: rad.timer,
      beskrivelse,
      vakt_id: rad.vakt,
      tekst: `${timerTekst(sum)} ${naar(d, k.iDag)}${rad.fra ? ` (${rad.fra}–${rad.til}${rad.pause ? `, ${rad.pause} min pause` : ""})` : ""}${rad.kilde}${h.selv ? "" : ` for ${h.a.navn}`}${beskrivelse ? `: ${beskrivelse}` : ""}.`,
      knapp: "Før timene",
    });
  }
  const deler: string[] = [];
  if (uten.length) deler.push(`Hvor mange timer ${liste(uten)}? Si klokkeslett («8–16») eller antall timer.`);
  for (const f of fort.filter((x) => forslag.some((y) => y.type === "timer" && y.dato === x.dato)))
    deler.push(`${h.selv ? "Du" : h.a.navn} har allerede ført ${timerTekst(f.timer)} ${naar(f.dato, k.iDag)}.`);
  if (forslag.length && !deler.length) deler.push(forslag.length === 1 ? "Skal jeg føre timene?" : `${flertall(forslag.length, "dag", "dager")} med timer.`);
  const u = uke(dager[0]!).fra;
  return { tekst: deler.join(" "), forslag, lenker: [{ tekst: "Timer", til: h.selv ? `/timer?fane=mine&uke=${u}` : `/timer?fane=alle&ansatt=${h.a.id}&uke=${u}` }] };
}

async function leverTimer(k: PKontekst, ai: Partial<PersonalKommando>): Promise<PSvar> {
  const h = hvem(k, ai);
  if (h.ukjent) return ukjentSvar(k, h.ukjent, "levere timer for andre");
  if (!h.a) return { tekst: "Du er ikke registrert som ansatt her." };
  if (!h.selv && !k.p.kan.personal) return ingen("levere timer for andre");
  const u = uke(k.iDag);
  const p = periodeFra(ai, k.iDag, [u.fra, u.til], 93);
  if (typeof p === "string") return { tekst: p };
  const [fra, til] = p;
  const s = await en<{ antall: number; timer: number }>(
    k.db,
    "select count(*)::int as antall, coalesce(sum(timer), 0)::float as timer from faktura.timeforinger where org_id = $1 and ansatt_id = $2 and dato between $3 and $4 and status in ('utkast', 'avvist')",
    [k.orgId, h.a.id, fra, til],
  );
  if (!s?.antall) return { tekst: `${h.selv ? "Du har" : `${h.a.navn} har`} ingen timer å levere ${naarPeriode(fra, til, k.iDag)}.` };
  return {
    tekst: "Skal jeg levere timene?",
    forslag: [
      {
        type: "lever_timer",
        ansatt_id: h.selv ? null : h.a.id,
        fra,
        til,
        tekst: `Lever ${flertall(s.antall, "føring", "føringer")} (${timerTekst(s.timer)}) ${naarPeriode(fra, til, k.iDag)}${h.selv ? "" : ` for ${h.a.navn}`}. De som godkjenner, får beskjed.`,
        knapp: "Lever timene",
      },
    ],
  };
}

async function godkjennTimer(k: PKontekst, ai: Partial<PersonalKommando>): Promise<PSvar> {
  if (!k.p.kan.personal) return ingen("godkjenne timer");
  const a = finnAnsatt(k.p, ai.ansatt);
  if (a.ukjent) return { tekst: `Fant ikke «${a.ukjent}» blant de ansatte.` };
  const p = gyldig(ai.fra_dato) || gyldig(ai.til_dato) ? periodeFra(ai, k.iDag, [k.iDag, k.iDag], 366) : ([pluss(k.iDag, -366), pluss(k.iDag, 62)] as [string, string]);
  if (typeof p === "string") return { tekst: p };
  const rader = await alle<{ id: string; ansatt_id: string; navn: string; dato: string; timer: number }>(
    k.db,
    `select t.id, t.ansatt_id, a.fornavn || ' ' || a.etternavn as navn, t.dato, t.timer
       from faktura.timeforinger t join faktura.ansatte a on a.org_id = t.org_id and a.id = t.ansatt_id
      where t.org_id = $1 and t.status = 'levert' and t.dato between $2 and $3 and ($4::uuid is null or t.ansatt_id = $4)
      order by t.dato, a.fornavn`,
    [k.orgId, p[0], p[1], a.a?.id ?? null],
  );
  if (!rader.length) return { tekst: `Ingen timer venter på godkjenning${a.a ? ` fra ${a.a.navn}` : ""}.`, lenker: [{ tekst: "Til godkjenning", til: "/timer?fane=godkjenning" }] };
  const godkjent = ai.godkjent !== false;
  const grunn = enLinje(ai.notat, 500) || null;
  // Én per ansatt og uke.
  const grupper = new Map<string, { navn: string; uke: number; ider: string[]; timer: number }>();
  for (const r of rader) {
    const u = uke(r.dato);
    const g = grupper.get(`${r.ansatt_id}:${u.fra}`) ?? { navn: r.navn, uke: u.uke, ider: [], timer: 0 };
    g.ider.push(r.id);
    g.timer = Math.round((g.timer + Number(r.timer)) * 100) / 100;
    grupper.set(`${r.ansatt_id}:${u.fra}`, g);
  }
  const forslag: PForslag[] = [...grupper.values()].slice(0, 20).map((g) => ({
    type: "godkjenn_timer",
    ider: g.ider,
    godkjent,
    grunn,
    tekst: `${g.navn}, uke ${g.uke}: ${flertall(g.ider.length, "føring", "føringer")}, ${timerTekst(g.timer)}.${!godkjent && grunn ? ` Grunn: ${grunn}` : ""}`,
    knapp: godkjent ? "Godkjenn" : "Avvis",
  }));
  const deler = [forslag.length === 1 ? `Skal jeg ${godkjent ? "godkjenne" : "avvise"} timene?` : `${flertall(forslag.length, "uke venter", "uker venter")} på godkjenning.`];
  if (!godkjent && !grunn) deler.push("Si gjerne hvorfor, så den ansatte vet hva som skal rettes.");
  return { tekst: deler.join(" "), forslag, lenker: [{ tekst: "Til godkjenning", til: "/timer?fane=godkjenning" }] };
}

const iAar = (iDag: string) => Number(iDag.slice(0, 4));

async function overforFerie(k: PKontekst, ai: Partial<PersonalKommando>): Promise<PSvar> {
  if (!k.p.vaktplan) return UTEN_VAKTPLAN;
  const h = hvem(k, ai);
  if (h.ukjent) return ukjentSvar(k, h.ukjent, "overføre ferie for andre");
  if (!h.a) return { tekst: "Hvem gjelder det?" };
  if (!h.selv && !k.p.kan.personal) return ingen("overføre ferie for andre");
  const dager = typeof ai.dager === "number" && ai.dager > 0 ? Math.round(ai.dager * 2) / 2 : null;
  if (!dager) return { tekst: "Hvor mange feriedager skal overføres til neste år?" };
  const aar = iAar(k.iDag);
  const s = await en<{ igjen: number; venter: number }>(k.db, "select igjen::float as igjen, venter::float as venter from faktura.feriebank($1, $2) where ansatt_id = $3", [
    k.orgId,
    aar,
    h.a.id,
  ]);
  if (!s) return { tekst: `Fant ikke feriebanken for ${h.selv ? "deg" : h.a.navn} i ${aar}.` };
  const ledig = Math.round((s.igjen - s.venter) * 10) / 10;
  if (dager > ledig)
    return { tekst: `${h.selv ? "Du har" : `${h.a.navn} har`} ${dagerTekst(ledig)} igjen i ${aar} som kan overføres${s.venter ? ` (${dagerTekst(s.venter)} venter allerede på svar)` : ""}.`, lenker: [{ tekst: "Ferie", til: `/ferie?aar=${aar}` }] };
  const direkte = !h.selv && k.p.kan.personal;
  const begrunnelse = enLinje(ai.notat, 500) || null;
  return {
    tekst: direkte ? "Skal jeg overføre feriedagene?" : "Skal jeg sende søknaden? Lederen din får beskjed.",
    forslag: [
      {
        type: "overforing",
        ansatt_id: h.selv ? null : h.a.id,
        dager,
        begrunnelse,
        godkjent: direkte,
        tekst: `${direkte ? `Overfør ${dagerTekst(dager)} for ${h.a.navn}` : `Søk om å overføre ${dagerTekst(dager)}`} fra ${aar} til ${aar + 1}${begrunnelse ? ` («${begrunnelse}»)` : ""}.`,
        knapp: direkte ? "Overfør" : "Send søknaden",
      },
    ],
    lenker: [{ tekst: "Ferie", til: `/ferie?aar=${aar}` }],
  };
}

async function svarOverforing(k: PKontekst, ai: Partial<PersonalKommando>): Promise<PSvar> {
  if (!k.p.vaktplan) return UTEN_VAKTPLAN;
  if (!k.p.kan.personal) return ingen("svare på søknader om å overføre ferie");
  const a = finnAnsatt(k.p, ai.ansatt);
  if (a.ukjent) return { tekst: `Fant ikke «${a.ukjent}» blant de ansatte.` };
  const soknader = await alle<{ id: string; navn: string; fra_aar: number; dager: number; begrunnelse: string | null }>(
    k.db,
    `select o.id, a.fornavn || ' ' || a.etternavn as navn, o.fra_aar, o.dager::float as dager, o.begrunnelse
       from faktura.ferie_overforinger o join faktura.ansatte a on a.org_id = o.org_id and a.id = o.ansatt_id
      where o.org_id = $1 and o.status = 'venter' and ($2::uuid is null or o.ansatt_id = $2) order by o.opprettet limit 5`,
    [k.orgId, a.a?.id ?? null],
  );
  if (!soknader.length) return { tekst: `Ingen søknader om å overføre ferie venter på svar${a.a ? ` fra ${a.a.navn}` : ""}.` };
  const godkjent = ai.godkjent !== false;
  const svar = enLinje(ai.notat, 500) || null;
  return {
    tekst: soknader.length === 1 ? `Skal jeg ${godkjent ? "godkjenne" : "avslå"} søknaden?` : `${soknader.length} søknader venter på svar.`,
    forslag: soknader.map((o) => ({
      type: "svar_overforing",
      id: o.id,
      godkjent,
      svar,
      tekst: `${o.navn} søker om å overføre ${dagerTekst(o.dager)} fra ${o.fra_aar} til ${o.fra_aar + 1}${o.begrunnelse ? ` («${enLinje(o.begrunnelse, 120)}»)` : ""}.`,
      knapp: godkjent ? "Godkjenn" : "Avslå",
    })),
    lenker: [{ tekst: "Ferie", til: "/ferie" }],
  };
}

// --- Spørsmål ---------------------------------------------------------------------

async function hvemJobber(k: PKontekst, ai: Partial<PersonalKommando>): Promise<PSvar> {
  if (!k.p.vaktplan) return UTEN_VAKTPLAN;
  if (!k.p.kan.se) return vakter(k, { ...ai, ansatt: null });
  const p = periodeFra(ai, k.iDag, [k.iDag, k.iDag], 7);
  if (typeof p === "string") return { tekst: p };
  const [fra, til] = p;
  const vakter_ = await alle<VaktRad>(k.db, `${VAKTER} where v.org_id = $1 and v.dato between $2 and $3 order by v.dato, v.fra, a.fornavn`, [k.orgId, fra, til]);
  const b = await beregnBemanning(k.db, k.orgId, fra, til);
  const navn = new Map(b.ansatte.map((a) => [a.id, a.navn]));
  const fravaer = await alle<{ navn: string; type: string; fra: string; til: string }>(
    k.db,
    `select a.fornavn || ' ' || a.etternavn as navn, faktura.fravaer_type(f.org_id, f.ansatt_id, f.type) as type, f.fra, f.til
       from faktura.fravaer f join faktura.ansatte a on a.org_id = f.org_id and a.id = f.ansatt_id
      where f.org_id = $1 and f.til >= $2 and f.fra <= $3 order by a.fornavn`,
    [k.orgId, fra, til],
  );
  // Rollene i bemanningskalenderen (f.eks. leger og sekretærer, også de som ikke er ansatt):
  // hvor mange i hver som er på jobb, mot behovet (som ikke regnes på helligdager).
  const grupper = await alle<{ navn: string; behov: number | null; ansatte: string[] }>(
    k.db,
    `select g.navn, g.behov, coalesce(array_agg(a.id::text) filter (where a.id is not null), '{}') as ansatte
       from faktura.ansattgrupper g left join faktura.ansatte a on a.org_id = g.org_id and a.gruppe_id = g.id
      where g.org_id = $1 group by g.id order by g.rekkefolge, g.opprettet`,
    [k.orgId],
  );
  const dagTekster: string[] = [];
  const enDag = fra === til;
  for (let d = fra; d <= til; d = pluss(d, 1)) {
    const ider = new Set([
      ...vakter_.filter((v) => v.dato === d && v.ansatt_id && !v.fravaer).map((v) => v.ansatt_id!),
      ...b.faste.filter((f) => f.dato === d && !f.fravaer).map((f) => f.ansatt_id),
    ]);
    const iGruppene = grupper.map((g) => {
      const n = g.ansatte.filter((a) => ider.has(a)).length;
      const behov = g.behov != null && !helligdag(d) ? g.behov : null;
      return { navn: g.navn, n, behov };
    });
    const paJobb = [
      ...vakter_.filter((v) => v.dato === d && v.ansatt_id && !v.fravaer).map((v) => `${v.navn} ${v.fra}–${v.til}${v.oppgave ? ` (${v.oppgave})` : ""}${v.publisert ? "" : " (utkast)"}`),
      ...b.faste.filter((f) => f.dato === d && !f.fravaer).map((f) => `${navn.get(f.ansatt_id) ?? "?"}${f.fra ? ` ${f.fra}–${f.til}` : ""}`),
    ];
    const borte = fravaer.filter((f) => f.fra <= d && f.til >= d).map((f) => `${f.navn} (${typeTekst(f.type)})`);
    const mangler = vakter_.filter((v) => v.dato === d && v.fravaer && !v.har_vikar).map((v) => `${v.navn} ${v.fra}–${v.til}`);
    const ledige = vakter_.filter((v) => v.dato === d && !v.ansatt_id && v.publisert).map((v) => `${v.fra}–${v.til}${v.oppgave ? ` (${v.oppgave})` : ""}`);
    if (enDag) {
      const deler = [paJobb.length ? `${naar(d, k.iDag).replace(/^./, (c) => c.toUpperCase())} er ${paJobb.length} på jobb: ${liste(forkort(paJobb, 10))}.` : `Ingen er satt opp på jobb ${naar(d, k.iDag)}.`];
      if (borte.length) deler.push(`Borte: ${liste(borte)}.`);
      if (mangler.length) deler.push(`${flertall(mangler.length, "vakt mangler", "vakter mangler")} vikar: ${liste(mangler)}.`);
      if (ledige.length) deler.push(`${flertall(ledige.length, "ledig vakt", "ledige vakter")}: ${liste(ledige)}.`);
      if (iGruppene.length)
        deler.push(
          `Bemanningen: ${iGruppene.map((g) => `${g.navn} ${g.n}${g.behov != null ? ` av ${g.behov}${g.n < g.behov ? ` (mangler ${g.behov - g.n})` : ""}` : ""}`).join(", ")}.`,
        );
      dagTekster.push(deler.join(" "));
    } else {
      // Stengt i helgene: lørdag og søndag bare når noen er satt opp da.
      if (!k.p.helg && erHelg(d) && !paJobb.length && !mangler.length && !ledige.length) continue;
      const deler = [`${dag(d)}: ${paJobb.length} på jobb`];
      if (borte.length) deler.push(`borte ${liste(borte)}`);
      if (mangler.length) deler.push(`${mangler.length} mangler vikar`);
      if (ledige.length) deler.push(`${ledige.length} ledig${ledige.length === 1 ? "" : "e"}`);
      for (const g of iGruppene) deler.push(`${g.navn} ${g.n}${g.behov != null ? `/${g.behov}` : ""}`);
      dagTekster.push(deler.join(", "));
    }
  }
  return {
    tekst: enDag ? dagTekster.join(" ") : dagTekster.length ? `${dagTekster.join(". ")}.` : "Dere har stengt i helgene, og ingen er satt opp da.",
    lenker: [
      { tekst: "Tavla", til: `/vakter?fane=tavle&dato=${fra}` },
      { tekst: "Vaktplanen", til: `/vakter?uke=${uke(fra).fra}` },
    ],
  };
}

async function vakter(k: PKontekst, ai: Partial<PersonalKommando>): Promise<PSvar> {
  if (!k.p.vaktplan) return UTEN_VAKTPLAN;
  const h = hvem(k, ai);
  if (h.ukjent) return ukjentSvar(k, h.ukjent, "se vaktene til andre");
  if (!h.a) return { tekst: "Hvem sine vakter? Du er ikke registrert som ansatt her." };
  if (!h.selv && !k.p.kan.se) return ingen("se vaktene til andre");
  const p = periodeFra(ai, k.iDag, [k.iDag, pluss(k.iDag, 13)], 62);
  if (typeof p === "string") return { tekst: p };
  const [fra, til] = p;
  const egne = (await alle<VaktRad>(k.db, `${VAKTER} where v.org_id = $1 and v.ansatt_id = $2 and v.dato between $3 and $4 order by v.dato, v.fra`, [k.orgId, h.a.id, fra, til])).filter(
    (v) => v.publisert || k.p.kan.se,
  );
  const faste = (await beregnBemanning(k.db, k.orgId, fra, til, h.a.id)).faste.filter((f) => f.dato >= fra && f.dato <= til);
  // Plassene på tavla, også de som kommer av den faste oppgaven (0059_tavle_fast_oppgave.sql).
  const plasser = await egnePlasser(k.db, k.orgId, h.a.id, fra, til);
  const tavle = (d: string) => {
    const x = plasser.filter((y) => y.dato === d).map((y) => `${y.oppgave}${plasser.filter((z) => z.dato === d).length > 1 ? ` ${y.fase.toLowerCase()}` : ""}`);
    return x.length ? ` – ${liste(x)}` : "";
  };
  const linjer = [
    ...egne.map((v) => ({ dato: v.dato, t: `${vaktTekst(v, k.iDag)}${v.fravaer ? ` (borte: ${typeTekst(v.fravaer)})` : ""}${v.publisert ? "" : " (utkast)"}${tavle(v.dato)}` })),
    ...faste.map((f) => ({ dato: f.dato, t: `${naar(f.dato, k.iDag)}${f.fra ? ` ${f.fra}–${f.til}` : ""}${f.fravaer ? ` (borte: ${typeTekst(f.fravaer)})` : ""}${tavle(f.dato)}` })),
  ].sort((x, y) => x.dato.localeCompare(y.dato));
  const hvemTekst = h.selv ? "Du" : h.a.navn;
  const deler = [
    linjer.length
      ? `${hvemTekst} har ${flertall(linjer.length, "vakt", "vakter")} ${naarPeriode(fra, til, k.iDag)}: ${liste(forkort(linjer.map((l) => l.t), 10))}.`
      : `${hvemTekst} har ingen vakter ${naarPeriode(fra, til, k.iDag)}.`,
  ];
  if (h.selv) {
    const ledige = await en<{ n: number }>(
      k.db,
      "select count(*)::int as n from faktura.vakter where org_id = $1 and ansatt_id is null and publisert_at is not null and dato between $2 and $3",
      [k.orgId, k.iDag, pluss(k.iDag, 55)],
    );
    if (ledige?.n) deler.push(`Det er ${flertall(ledige.n, "ledig vakt", "ledige vakter")} du kan ta.`);
  }
  return {
    tekst: deler.join(" "),
    lenker: h.selv ? [{ tekst: "Mine vakter", til: "/vakter?fane=mine" }] : [{ tekst: "Vaktplanen", til: `/vakter?uke=${uke(fra).fra}` }],
  };
}

async function timerSporsmal(k: PKontekst, ai: Partial<PersonalKommando>): Promise<PSvar> {
  const r = finnAnsatt(k.p, ai.ansatt);
  if (r.ukjent) return ukjentSvar(k, r.ukjent, "se timene til andre");
  // Uten bestemt ansatt ser den som ser de ansatte, det som venter og det som ikke er levert.
  if (!r.a && k.p.kan.se) return oversiktTimer(k);
  const a = r.a ?? k.p.ansatte.find((x) => x.id === k.p.meg) ?? null;
  if (!a) return { tekst: "Du er ikke registrert som ansatt her." };
  if (a.id !== k.p.meg && !k.p.kan.se) return ingen("se timene til andre");
  const u = uke(k.iDag);
  const p = periodeFra(ai, k.iDag, [u.fra, u.til], 93);
  if (typeof p === "string") return { tekst: p };
  const [fra, til] = p;
  const foringer = await alle<{ dato: string; timer: number; overtid_prosent: number | null; uten_overtid: boolean; status: string }>(
    k.db,
    "select dato, timer, overtid_prosent, uten_overtid, status from faktura.timeforinger where org_id = $1 and ansatt_id = $2 and dato between $3 and $4",
    [k.orgId, a.id, uke(fra).fra, uke(til).til],
  );
  const iPerioden = foringer.filter((f) => f.dato >= fra && f.dato <= til);
  const selv = a.id === k.p.meg;
  if (!iPerioden.length) return { tekst: `${selv ? "Du har" : `${a.navn} har`} ikke ført noen timer ${naarPeriode(fra, til, k.iDag)}.` };
  const sum = Math.round(iPerioden.reduce((s, f) => s + Number(f.timer), 0) * 100) / 100;
  const perStatus = ["utkast", "avvist", "levert", "godkjent"]
    .map((s) => [s, Math.round(iPerioden.filter((f) => f.status === s).reduce((x, f) => x + Number(f.timer), 0) * 100) / 100] as const)
    .filter(([, t]) => t > 0)
    .map(([s, t]) => `${timerTekst(t)} ${s === "utkast" ? "ikke levert" : s}`);
  const deler = [`${selv ? "Du har" : `${a.navn} har`} ført ${timerTekst(sum)} ${naarPeriode(fra, til, k.iDag)}: ${liste(perStatus)}.`];
  // Overtiden, uke for uke (som i timelista).
  const r_ = await regler(k.db, k.orgId);
  const avtalt = await en<{ avtalt: number }>(k.db, "select ukentlig_arbeidstid * stillingsprosent / 100 as avtalt from faktura.ansatte where org_id = $1 and id = $2", [k.orgId, a.id]);
  const uker = new Map<string, typeof foringer>();
  for (const f of foringer) uker.set(uke(f.dato).fra, [...(uker.get(uke(f.dato).fra) ?? []), f]);
  let overtid = 0;
  for (const rader of uker.values()) overtid += beregnUke(rader, r_, avtalt?.avtalt).overtid.reduce((s, o) => s + o.timer, 0);
  if (overtid > 0.004) deler.push(`Av det er ${timerTekst(Math.round(overtid * 100) / 100)} overtid${uker.size > 1 || fra !== uke(fra).fra ? " (regnet for hele uker)" : ""}.`);
  if (selv && perStatus.some((x) => x.endsWith("ikke levert") || x.endsWith("avvist"))) deler.push("Si «lever timene» når uka er ferdig.");
  return { tekst: deler.join(" "), lenker: [{ tekst: "Timer", til: selv ? `/timer?fane=mine&uke=${uke(fra).fra}` : `/timer?fane=alle&ansatt=${a.id}&uke=${uke(fra).fra}` }] };
}

// Lederens oversikt: ukene som venter på godkjenning, og det som ikke er levert for forrige uke.
async function oversiktTimer(k: PKontekst): Promise<PSvar> {
  if (!k.p.kan.se) return { tekst: "Du er ikke registrert som ansatt her." };
  const forrige = uke(pluss(k.iDag, -7));
  const venter = await alle<{ navn: string; uke: string; timer: number }>(
    k.db,
    `select a.fornavn || ' ' || a.etternavn as navn, date_trunc('week', t.dato)::date::text as uke, sum(t.timer)::float as timer
       from faktura.timeforinger t join faktura.ansatte a on a.org_id = t.org_id and a.id = t.ansatt_id
      where t.org_id = $1 and t.status = 'levert' and t.dato >= $2 group by 1, 2 order by 2, 1 limit 30`,
    [k.orgId, pluss(k.iDag, -366)],
  );
  const ikkeLevert = await alle<{ navn: string }>(
    k.db,
    `select distinct a.fornavn || ' ' || a.etternavn as navn from faktura.timeforinger t join faktura.ansatte a on a.org_id = t.org_id and a.id = t.ansatt_id
      where t.org_id = $1 and t.status in ('utkast', 'avvist') and t.dato between $2 and $3 order by 1`,
    [k.orgId, forrige.fra, forrige.til],
  );
  const deler = [
    venter.length
      ? `Til godkjenning: ${liste(forkort(venter.map((v) => `${v.navn} uke ${uke(v.uke).uke} (${timerTekst(v.timer)})`), 8))}.`
      : "Ingen timer venter på godkjenning.",
  ];
  if (ikkeLevert.length) deler.push(`Ikke levert for uke ${forrige.uke}: ${liste(ikkeLevert.map((x) => x.navn))}.`);
  if (venter.length && k.p.kan.personal) deler.push("Si «godkjenn alle leverte timer» for å godkjenne dem.");
  return { tekst: deler.join(" "), lenker: [{ tekst: "Til godkjenning", til: "/timer?fane=godkjenning" }] };
}

async function ferie(k: PKontekst, ai: Partial<PersonalKommando>): Promise<PSvar> {
  if (!k.p.vaktplan) return UTEN_VAKTPLAN;
  if (!k.p.kan.ferie) return { tekst: "Feriebanken ser bare eier, administrator og den ansatte selv." };
  const aar = gyldig(ai.fra_dato) ? Number(ai.fra_dato.slice(0, 4)) : iAar(k.iDag);
  const r = finnAnsatt(k.p, ai.ansatt);
  if (r.ukjent) return ukjentSvar(k, r.ukjent, "se feriebanken til andre");
  const lenker = [{ tekst: "Ferie", til: `/ferie?aar=${aar}` }];
  type Saldo = { ansatt_id: string; navn: string; rett: number; overfort_inn: number; overfort_ut: number; avviklet: number; planlagt: number; igjen: number; venter: number };
  const bank = await alle<Saldo>(
    k.db,
    `select ansatt_id, navn, rett::float as rett, overfort_inn::float as overfort_inn, overfort_ut::float as overfort_ut, avviklet::float as avviklet,
            planlagt::float as planlagt, igjen::float as igjen, venter::float as venter
       from faktura.feriebank($1, $2) where aktiv`,
    [k.orgId, aar],
  );
  const a = r.a ?? (k.p.kan.personal && !ai.ansatt ? null : (k.p.ansatte.find((x) => x.id === k.p.meg) ?? null));
  if (a) {
    const s = bank.find((x) => x.ansatt_id === a.id);
    if (!s) return a.id === k.p.meg || k.p.kan.personal ? { tekst: `Fant ikke feriebanken for ${a.id === k.p.meg ? "deg" : a.navn} i ${aar}.`, lenker } : ingen("se feriebanken til andre");
    const selv = a.id === k.p.meg;
    const deler = [
      `${selv ? "Du har" : `${a.navn} har`} ${dagerTekst(Math.round(s.igjen * 10) / 10)} igjen i ${aar}, av ${dagerTekst(s.rett + s.overfort_inn - s.overfort_ut)}: ${dagerTekst(s.avviklet)} avviklet${s.planlagt ? ` og ${dagerTekst(s.planlagt)} planlagt` : ""}.`,
    ];
    if (s.overfort_inn) deler.push(`${dagerTekst(s.overfort_inn)} er overført fra ${aar - 1}.`);
    if (s.venter) deler.push(`En søknad om å overføre ${dagerTekst(s.venter)} venter på svar.`);
    return { tekst: deler.join(" "), lenker };
  }
  // Lederen uten bestemt ansatt: de med mest igjen.
  if (!bank.length) return { tekst: `Feriebanken for ${aar} er tom.`, lenker };
  const topp = [...bank].sort((x, y) => y.igjen - x.igjen).slice(0, 8);
  const venter = bank.filter((x) => x.venter > 0).length;
  return {
    tekst: `Feriedager igjen i ${aar}: ${liste(topp.map((s) => `${s.navn} ${String(Math.round(s.igjen * 10) / 10).replace(".", ",")}`))}.${venter ? ` ${flertall(venter, "søknad om overføring venter", "søknader om overføring venter")} på svar.` : ""}`,
    lenker,
  };
}

// ---------------------------------------------------------------------------
// Sider og hjelp
// ---------------------------------------------------------------------------

// Vaktplanen og tavla ser også de ansatte (plan); kalenderen er måneden i vaktplanen.
const PSIDER: Record<PersonalSide, [string, string, "se" | "plan" | "personal" | "meg" | "alle"]> = {
  vaktplan: ["/vakter?fane=plan", "vaktplanen", "plan"],
  tavle: ["/vakter?fane=tavle", "tavla", "plan"],
  kalender: ["/vakter?fane=plan&visning=maaned", "vaktplanen for måneden", "plan"],
  fravaer: ["/vakter?fane=fravaer", "fraværet", "se"],
  mine_vakter: ["/vakter?fane=mine", "vaktene dine", "meg"],
  ledige_vakter: ["/vakter?fane=ledige", "de ledige vaktene", "meg"],
  timer: ["/timer", "timene", "alle"],
  godkjenning: ["/timer?fane=godkjenning", "timene til godkjenning", "personal"],
  ferie: ["/ferie", "feriebanken", "alle"],
  ansatte: ["/ansatte", "de ansatte", "se"],
};
export function visPersonal(p: PersonalGrunnlag, side: string): PSvar | null {
  const s = PSIDER[side as PersonalSide];
  if (!s) return null;
  const [til, navn, krav] = s;
  const ok = krav === "alle" || (krav === "se" && p.kan.se) || (krav === "plan" && p.kan.plan) || (krav === "personal" && p.kan.personal) || (krav === "meg" && !!p.meg);
  if (!ok) return { tekst: `Du har ikke tilgang til ${navn}.` };
  if (til.startsWith("/vakter") || til === "/ferie") if (!p.vaktplan) return UTEN_VAKTPLAN;
  return { tekst: `Åpner ${navn}.`, gaa_til: til };
}

export function personalHjelp(p: PersonalGrunnlag): string {
  if (p.kan.personal)
    return "For personal kan jeg registrere fravær og sette inn vikarer, legge inn og publisere vakter, plassere folk på tavla og lage rullering, føre og godkjenne timer, og svare på hvem som jobber, timer og ferie. Si for eksempel «Kari er syk i dag, Per tar vaktene» eller «Hvem jobber i morgen?».";
  if (p.kan.se) return "For personal kan jeg svare på hvem som jobber og er borte, vakter og timer. Si for eksempel «Hvem jobber i dag?» eller «Hvor mange timer har Kari ført denne uka?».";
  return "Jeg kan melde deg syk, finne ledige vakter du kan ta, føre og levere timene dine, søke om å overføre ferie og svare på vaktene, timene og feriedagene dine. Si for eksempel «Jeg er syk i dag» eller «Før 7,5 timer i dag».";
}

// Gjør svaret fra modellen om til det appen viser.
export async function utforPersonal(k: PKontekst, handling: PersonalHandling, ai: Partial<PersonalKommando>): Promise<PSvar> {
  switch (handling) {
    case "fravaer":
      return fravaer(k, ai);
    case "vikar":
      return vikar(k, ai);
    case "ny_vakt":
      return nyVakt(k, ai);
    case "publiser_vakter":
      return publiser(k, ai);
    case "ta_vakt":
      return taVakt(k, ai);
    case "plasser":
      return plasser(k, ai);
    case "rullering":
      return rullering(k, ai);
    case "for_timer":
      return forTimer(k, ai);
    case "lever_timer":
      return leverTimer(k, ai);
    case "godkjenn_timer":
      return godkjennTimer(k, ai);
    case "overfor_ferie":
      return overforFerie(k, ai);
    case "svar_overforing":
      return svarOverforing(k, ai);
    case "hvem_jobber":
      return hvemJobber(k, ai);
    case "vakter":
      return vakter(k, ai);
    case "timer":
      return timerSporsmal(k, ai);
    case "ferie":
      return ferie(k, ai);
  }
}
