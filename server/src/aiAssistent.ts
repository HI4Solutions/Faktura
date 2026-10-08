// AI-assistenten: en kommando med tekst (eller tale, som skrives ned og vises først, se
// aiTale.ts) fra hvor som helst i appen («send faktura
// til Kari for husleie oktober», «har Fjordline betalt?», «registrer betaling på faktura
// 1043», «send purring på alle forfalte»), og for personalmodulen («Kari er syk i dag»,
// «før 7,5 timer i dag», se aiPersonal.ts). Gemini finner ut hva brukeren vil og fyller ut
// feltene; her slås kunder og fakturaer opp, spørsmål besvares, og alt som endrer noe blir
// et forslag som brukeren bekrefter i appen. Forslagene utføres med de vanlige rutene i
// API-et, med brukerens tilgang og de samme kontrollene som ellers.
//
// Hva assistenten kan, følger brukeren: med tilgang til fakturaene (alle roller unntatt
// ansatt) fakturadelen, og med personalmodulen slått på personaldelen (for dem som ser de
// ansatte, og for den som selv er ansatt). Den ansatte (rollen ansatt) får bare personaldelen,
// uten kunder og fakturaer. Hver kombinasjon har sitt eget faste svarskjema.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { alle, en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { aiPaa, enLinje, generer, iDagOslo, medKvote, type Del, type Skjema } from "./ai.js";
import {
  datoOgSelger,
  fakturaRegler,
  hentGrunnlag,
  registertekst,
  tilUtkast,
  utkastSkjema,
  type AiLinje,
  type Grunnlag,
  type Kunde,
  type Utkast,
} from "./aiFaktura.js";
import { gammelApp, taleRute } from "./aiTale.js";
import { sammeNavn } from "./bank.js";
import { dato, iDag, kr, summer } from "./regler.js";
import {
  hentPersonal,
  personalFelt,
  PERSONAL_HANDLINGER,
  PERSONAL_SIDER,
  personalHandlingtekst,
  personalHjelp,
  personalRegister,
  personalRegler,
  personalVis,
  utforPersonal,
  visPersonal,
  type PersonalGrunnlag,
  type PersonalHandling,
  type PersonalKommando,
  type PForslag,
} from "./aiPersonal.js";

export const FAKTURA_HANDLINGER = ["ny_faktura", "send_utkast", "send_igjen", "sjekk_betaling", "registrer_betaling", "send_purring", "utestaende"] as const;
export const HANDLINGER = [...FAKTURA_HANDLINGER, "vis", "annet"] as const;
const FAKTURA_SIDER = ["faktura", "fakturaer", "utkast", "ubetalte", "ny_faktura", "innbetalinger", "kunder", "produkter", "gjentakende", "rapporter", "innstillinger", "oversikt"] as const;
export const SIDER = ["ingen", ...FAKTURA_SIDER] as const;
type FakturaHandling = (typeof FAKTURA_HANDLINGER)[number];
type Handling = FakturaHandling | PersonalHandling | "vis" | "annet";
type Side = (typeof SIDER)[number] | (typeof PERSONAL_SIDER)[number];

// Svaret fra modellen (personalfeltene bare når personaldelen er med).
export type AiKommando = Partial<PersonalKommando> & {
  handling: Handling;
  kunde: string | null;
  kunde_navn: string | null;
  betaler: string | null;
  fakturanumre: number[];
  alle_forfalte: boolean;
  belop: number | null;
  dato: string | null;
  send: boolean;
  side: Side;
  linjer: AiLinje[];
  fakturadato: string | null;
  forfallsdato: string | null;
  periode_fra: string | null;
  periode_til: string | null;
  deres_referanse: string | null;
  kommentar: string | null;
  svar: string | null;
  merknader: string[];
};

// Det appen får: hva assistenten sier, forslag som må bekreftes, lenker og en side å åpne.
export type Forslag =
  | { type: "ny_faktura"; tekst: string; knapp: string; send: boolean; gebyr: boolean; utkast: Utkast }
  | { type: "send_utkast"; tekst: string; knapp: string; faktura_id: string }
  | { type: "send_igjen"; tekst: string; knapp: string; faktura_id: string; fakturanummer: number }
  | { type: "betaling"; tekst: string; knapp: string; faktura_id: string; fakturanummer: number; belop: number; dato: string }
  | { type: "purring"; tekst: string; knapp: string; faktura_id: string; fakturanummer: number; purring: "paaminnelse" | "inkassovarsel" }
  | PForslag;
export type Lenke = { tekst: string; til: string };
export type AssistentSvar = {
  tekst: string;
  forslag: Forslag[];
  lenker: Lenke[];
  gaa_til: string | null; // siden som åpnes med en gang («åpne faktura 1043»)
  utkast: Utkast | null; // fakturautkastet, så det kan åpnes i skjemaet
};

const tekst = (beskrivelse: string, nullable = true): Skjema => ({ type: "STRING", nullable, description: beskrivelse });
const u = utkastSkjema.properties!;

const fakturaFoer: Record<string, Skjema> = {
  kunde: tekst("Id-en til kunden i kundelisten (K1, K2 …), eller null"),
  kunde_navn: tekst("Kunden slik brukeren sa det, eller null"),
  betaler: tekst("Navnet på den brukeren spør om har betalt, når det ikke er en kunde i listen, ellers null"),
  fakturanumre: { type: "ARRAY", items: { type: "INTEGER" }, description: "Fakturanumrene brukeren nevner, eller som samtalen viser til" },
  alle_forfalte: { type: "BOOLEAN", description: "true når brukeren vil purre alle forfalte fakturaer" },
  belop: { type: "NUMBER", nullable: true, description: "Beløp i kroner brukeren sier at er betalt, eller null" },
  dato: tekst("Betalingsdatoen brukeren sier (ÅÅÅÅ-MM-DD), eller null"),
  send: { type: "BOOLEAN", description: "ny_faktura: true når fakturaen skal sendes med en gang, false for et utkast" },
};
const fakturaEtter: Record<string, Skjema> = {
  linjer: u.linjer!,
  fakturadato: u.fakturadato!,
  forfallsdato: u.forfallsdato!,
  periode_fra: u.periode_fra!,
  periode_til: u.periode_til!,
  deres_referanse: u.deres_referanse!,
  kommentar: u.kommentar!,
};

// Svarskjemaet for fakturaer, personal eller begge. Hver variant er en fast verdi, så det
// huskes riktig når Gemini avviser et skjema (ai.ts).
function lagSkjema(faktura: boolean, personal: boolean): Skjema {
  const handlinger = [...(faktura ? FAKTURA_HANDLINGER : []), ...(personal ? PERSONAL_HANDLINGER : []), "vis", "annet"];
  const sider = ["ingen", ...(faktura ? FAKTURA_SIDER : []), ...(personal ? PERSONAL_SIDER : [])];
  const properties: Record<string, Skjema> = {
    handling: { type: "STRING", enum: handlinger, description: "Hva brukeren vil" },
    ...(faktura ? fakturaFoer : {}),
    side: { type: "STRING", enum: sider, description: "vis: siden brukeren vil åpne, ellers ingen" },
    ...(faktura ? fakturaEtter : {}),
    ...(personal ? personalFelt : {}),
    svar: tekst("annet: et kort svar på norsk til brukeren, ellers null"),
    merknader: { type: "ARRAY", items: { type: "STRING" }, description: "Korte setninger om det brukeren bør sjekke" },
  };
  return { type: "OBJECT", properties, required: Object.keys(properties), propertyOrdering: Object.keys(properties) };
}
export const SKJEMAER = { faktura: lagSkjema(true, false), personal: lagSkjema(false, true), begge: lagSkjema(true, true) };
export const assistentSkjema = SKJEMAER.faktura;
export type Modus = keyof typeof SKJEMAER;
// Det assistenten har å gå på: registrene for fakturaer og for personal (null: ikke med).
export type AssistentGrunnlag = { g: Grunnlag | null; p: PersonalGrunnlag | null };
const modus = (gr: AssistentGrunnlag): Modus => (gr.g && gr.p ? "begge" : gr.p ? "personal" : "faktura");

export function assistentSystem(gr: AssistentGrunnlag, naa = new Date()): string {
  const { g, p } = gr;
  const { dato: idag, ukedag } = iDagOslo(naa);
  return [
    `Du er assistenten i HI4 Faktura${g && p ? ", for fakturaer og for personal (ansatte, vakter, fravær, timer og ferie)" : p ? " for personal: ansatte, vakter, fravær, timer og ferie" : ", et fakturaprogram"}. Brukeren gir en kommando eller stiller et spørsmål (skrevet eller sagt og skrevet ned). Finn ut hva brukeren vil, og fyll ut feltene. Svar bare med JSON etter skjemaet. Du utfører ingenting selv: appen slår opp, svarer og ber brukeren bekrefte alt som endrer noe.`,
    "",
    g ? datoOgSelger(g, naa) : `Dagens dato er ${idag} (${ukedag}).`,
    "",
    "handling (velg én):",
    ...(g
      ? [
          "- ny_faktura: lage eller sende en ny faktura («send faktura til Kari for husleie oktober», «lag en faktura til Fjordline på tre timer konsulent»). send er true når brukeren vil sende den med en gang («send», «fakturer»), false når brukeren vil lage et utkast («lag», «sett opp»).",
          "- send_utkast: sende et utkast som allerede er laget («send utkastet til Kari», «send fakturaen jeg laget til Fjordline»). Utkast har ikke fakturanummer.",
          "- send_igjen: sende en faktura som allerede er sendt, på nytt («send faktura 1043 igjen», «send 1043 på nytt»).",
          "- sjekk_betaling: spørsmål om betaling («har Kari betalt?», «har det kommet penger fra Fjordline?», «er faktura 1043 betalt?», «har det kommet noen betalinger?»).",
          "- registrer_betaling: registrere en betaling («registrer betaling på faktura 1043», «Kari har betalt 5000 kontant i går»). belop og dato bare når brukeren sier dem.",
          "- send_purring: sende purring eller betalingspåminnelse («send purring på 1043», «purr Kari»). «Send purring til alle som ikke har betalt» gir alle_forfalte = true.",
          "- utestaende: oversikt over det kundene skylder («hvem skylder oss penger?», «hvor mye er utestående?», «hvilke fakturaer har forfalt?»).",
        ]
      : []),
    ...(p ? personalHandlingtekst : []),
    `- vis: åpne noe i appen (${[g ? "«åpne faktura 1043» gir side faktura, «gå til innbetalinger», «vis utkastene» gir utkast, «vis ubetalte fakturaer» gir ubetalte" : "", p ? personalVis : ""].filter(Boolean).join("; ")}).`,
    `- annet: alt annet, også spørsmål om hva assistenten kan, og det den ikke kan gjøre (${[g ? "kreditere, slette, endre innstillinger eller kunder" : "", p ? "slette vakter eller fravær, endre de ansatte, lønnen eller den faste arbeidsplanen" : ""].filter(Boolean).join("; ")}). Skriv da et kort, vennlig svar på norsk i svar, gjerne med hvor i appen det gjøres.`,
    "",
    "Regler:",
    ...(g ? ["- fakturanumre: bare numre brukeren sier, eller som står i samtalen før («den», «den fakturaen»). Aldri gjett et nummer."] : []),
    "- Bruk samtalen før til å forstå «den», «henne», «samme kunde» og lignende.",
    "- Datoer som ÅÅÅÅ-MM-DD. Regn om «i går», «på fredag» og «om 14 dager» fra dagens dato.",
    "- Felt som ikke gjelder handlingen: null, tom liste, false, eller side ingen.",
    ...(p ? personalRegler : []),
    ...(g ? ["- For ny_faktura gjelder også reglene for fakturaer:", ...fakturaRegler] : []),
    "- merknader: korte setninger på norsk om noe du var usikker på. Tom liste når alt er klart.",
  ].join("\n");
}

export type Melding = { rolle: "bruker" | "assistent"; tekst: string };

// Forespørselen til modellen: registrene, samtalen så langt og kommandoen (ruten under og
// «Test AI» på adminsiden).
export function assistentForesporsel(gr: AssistentGrunnlag, kommando: string, historikk: Melding[] = [], naa = new Date()): { system: string; deler: Del[]; skjema: Skjema } {
  const deler: Del[] = [];
  if (gr.g) deler.push({ text: registertekst(gr.g) });
  if (gr.p) deler.push({ text: personalRegister(gr.p) });
  if (historikk.length)
    deler.push({ text: `Samtalen så langt:\n${historikk.map((h) => `${h.rolle === "bruker" ? "Brukeren" : "Assistenten"}: ${enLinje(h.tekst, 600)}`).join("\n")}` });
  deler.push({ text: `Kommandoen:\n${kommando}` });
  return { system: assistentSystem(gr, naa), deler, skjema: SKJEMAER[modus(gr)] };
}

// ---------------------------------------------------------------------------
// Oppslag og svar
// ---------------------------------------------------------------------------

type Faktura = {
  id: string;
  fakturanummer: number | null;
  status: "utkast" | "utstedt" | "betalt" | "kreditert";
  kunde_id: string;
  kunde: string;
  kunde_epost: string | null;
  kunde_ehf: boolean | null;
  fakturadato: string | null;
  forfallsdato: string | null;
  opprettet: string;
  sum: number;
  betalt: number;
  utestaende: number;
  sist_betalt: string | null;
  har_paaminnelse: boolean;
  purrefrist: string | null;
};

const FAKTURA_SQL = `
  select f.id, f.fakturanummer, f.status, f.kunde_id, coalesce(f.kunde ->> 'navn', k.navn) as kunde, k.epost as kunde_epost, k.ehf as kunde_ehf,
         f.fakturadato, f.forfallsdato, to_char(f.opprettet at time zone 'Europe/Oslo', 'YYYY-MM-DD') as opprettet,
         coalesce(f.sum_inkl_mva, faktura.utkast_sum(f.id), 0) as sum,
         f.betalt_belop as betalt,
         coalesce(f.sum_inkl_mva, 0) - f.kreditert_belop - f.betalt_belop as utestaende,
         (select max(b.betalt_dato) from faktura.betalinger b where b.faktura_id = f.id and b.type = 'betaling') as sist_betalt,
         exists (select 1 from faktura.purringer p where p.faktura_id = f.id and p.type = 'paaminnelse') as har_paaminnelse,
         (select max(p.ny_frist) from faktura.purringer p where p.faktura_id = f.id) as purrefrist
    from faktura.fakturaer f join faktura.kunder k on k.id = f.kunde_id
   where f.org_id = $1 and f.type = 'faktura'`;

const hentFakturaer = (db: Db, orgId: string, vilkar: string, verdier: unknown[], rekkefolge = "f.forfallsdato nulls last, f.fakturanummer", grense = 30) =>
  alle<Faktura>(db, `${FAKTURA_SQL} ${vilkar} order by ${rekkefolge} limit ${grense}`, [orgId, ...verdier]);

type Rettigheter = { skriv: boolean; utsted: boolean; bokfor: boolean };
type Org = { kontonr: string | null; standard_forfall_dager: number; standard_gebyr: number };
type Kontekst = { db: Db; orgId: string; g: Grunnlag; kan: Rettigheter; org: Org; iDag: string };

const nr = (f: Faktura) => (f.fakturanummer ? `faktura ${f.fakturanummer}` : `utkastet til ${f.kunde}`);
const Nr = (f: Faktura) => (f.fakturanummer ? `Faktura ${f.fakturanummer}` : `Utkastet til ${f.kunde}`);
const flertall = (n: number, en: string, flere: string) => `${n} ${n === 1 ? en : flere}`;
const leggTilDager = (d: string, dager: number) => new Date(Date.parse(`${d}T12:00:00Z`) + dager * 86400_000).toISOString().slice(0, 10);
const ingenTilgang = (hva: string): Partial<AssistentSvar> => ({ tekst: `Du har ikke tilgang til å ${hva}.` });
const forfalt = (f: Faktura, iDag: string) => f.status === "utstedt" && Boolean(f.forfallsdato && f.forfallsdato < iDag);

function finnKunde(ai: AiKommando, g: Grunnlag): Kunde | null {
  const m = typeof ai.kunde === "string" ? ai.kunde.trim().toUpperCase().match(/^K(\d+)$/) : null;
  const k = m ? g.kunder[Number(m[1]) - 1] : undefined;
  if (k) return k;
  const navn = enLinje(ai.kunde_navn, 200);
  if (!navn) return null;
  const lik = g.kunder.filter((x) => x.navn.trim().toLowerCase() === navn.toLowerCase());
  const ligner = lik.length ? lik : g.kunder.filter((x) => sammeNavn(x.navn, navn));
  return ligner.length === 1 ? ligner[0] : null;
}

const numre = (ai: AiKommando) =>
  [...new Set((Array.isArray(ai.fakturanumre) ? ai.fakturanumre : []).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 1e9))].slice(0, 20);

// Fakturaene brukeren nevner med nummer, og numrene som ikke finnes.
async function medNummer(k: Kontekst, liste: number[]) {
  const funnet = liste.length ? await hentFakturaer(k.db, k.orgId, "and f.fakturanummer = any($2::bigint[])", [liste]) : [];
  const mangler = liste.filter((n) => !funnet.some((f) => Number(f.fakturanummer) === n));
  return { funnet, mangler: mangler.length ? `Fant ikke ${mangler.length === 1 ? "faktura" : "fakturaene"} ${mangler.join(", ")}.` : null };
}

const lenke = (f: Faktura): Lenke => ({ tekst: f.fakturanummer ? `Faktura ${f.fakturanummer}` : `Utkast til ${f.kunde}`, til: `/fakturaer/${f.id}` });

function betalingsstatus(f: Faktura, iDag: string): string {
  if (f.status === "utkast") return `${Nr(f)} er ikke sendt ennå.`;
  if (f.status === "kreditert") return `${Nr(f)} er kreditert.`;
  if (f.status === "betalt") return `${Nr(f)} (${kr(f.sum)} kr) er betalt${f.sist_betalt ? ` ${dato(f.sist_betalt)}` : ""}.`;
  const frist = forfalt(f, iDag) ? `forfalt ${dato(f.forfallsdato)}` : f.forfallsdato ? `forfall ${dato(f.forfallsdato)}` : "";
  if (f.betalt > 0) return `${Nr(f)}: ${kr(f.betalt)} av ${kr(f.sum)} kr er betalt, ${kr(f.utestaende)} kr gjenstår${frist ? ` (${frist})` : ""}.`;
  return `${Nr(f)} (${kr(f.utestaende)} kr) er ikke betalt${frist ? `, ${frist}` : ""}.`;
}

// Kan fakturaen purres nå? Gir forslaget, eller grunnen til at det ikke går.
function purring(f: Faktura, iDag: string): Forslag | string {
  if (f.status !== "utstedt") return `${Nr(f)} er ${f.status === "betalt" ? "betalt" : f.status === "kreditert" ? "kreditert" : "ikke sendt ennå"}.`;
  if (!forfalt(f, iDag)) return `${Nr(f)} har ikke forfalt ennå${f.forfallsdato ? ` (forfall ${dato(f.forfallsdato)})` : ""}.`;
  if (f.purrefrist && f.purrefrist >= iDag) return `Fristen i forrige purring på ${nr(f)} er ${dato(f.purrefrist)}.`;
  if (!f.kunde_epost) return `${f.kunde} har ingen e-postadresse, så purringen på ${nr(f)} kan ikke sendes.`;
  const type = f.har_paaminnelse ? "inkassovarsel" : "paaminnelse";
  return {
    type: "purring",
    faktura_id: f.id,
    fakturanummer: Number(f.fakturanummer),
    purring: type,
    tekst: `${type === "paaminnelse" ? "Betalingspåminnelse" : "Inkassovarsel"} på faktura ${f.fakturanummer} til ${f.kunde}: ${kr(f.utestaende)} kr, forfalt ${dato(f.forfallsdato)}.`,
    knapp: type === "paaminnelse" ? "Send påminnelse" : "Send inkassovarsel",
  };
}

async function nyFaktura(k: Kontekst, ai: AiKommando): Promise<Partial<AssistentSvar>> {
  const utkast = tilUtkast(ai, k.g);
  if (!k.kan.skriv) return { ...ingenTilgang("lage fakturaer"), utkast: null };
  const kunde = utkast.kunde_id ? k.g.kunder.find((x) => x.id === utkast.kunde_id)! : null;
  const mangler: string[] = [];
  if (!kunde) mangler.push(utkast.kunde_navn ? `Fant ikke «${utkast.kunde_navn}» i kunderegisteret.` : "Hvem skal fakturaen til?");
  if (!utkast.linjer.length) mangler.push("Hva skal faktureres?");
  const utenPris = utkast.linjer.filter((l) => l.enhetspris == null).map((l) => `«${l.beskrivelse}»`);
  if (utenPris.length) mangler.push(`Prisen mangler for ${utenPris.join(" og ")}.`);
  if (mangler.length) return { tekst: `${mangler.join(" ")} Åpne skjemaet for å fylle ut resten.`, utkast };

  // Med fakturagebyret, som i skjemaet (det legges på når fakturaen lagres).
  const gebyr = Number(k.org.standard_gebyr) > 0;
  const gebyrLinje = gebyr ? [{ beskrivelse: "Fakturagebyr", antall: 1, enhetspris: Number(k.org.standard_gebyr), mva_sats: k.g.mva ? 25 : 0 }] : [];
  const sum = summer([...utkast.linjer.map((l) => ({ ...l, enhetspris: l.enhetspris! })), ...gebyrLinje]);
  const forfall = utkast.forfallsdato ?? leggTilDager(utkast.fakturadato ?? k.iDag, k.org.standard_forfall_dager);
  const linjer = utkast.linjer.map((l) => (l.antall === 1 ? l.beskrivelse : `${l.beskrivelse} (${String(l.antall).replace(".", ",")} ${l.enhet})`)).join(", ");
  const deler = [
    `Faktura til ${kunde!.navn}: ${linjer}. Å betale ${kr(sum.inkl)} kr${k.g.mva && sum.mva ? " inkl. mva" : ""}${gebyr ? ` og fakturagebyr på ${kr(Number(k.org.standard_gebyr))} kr` : ""}, forfall ${dato(forfall)}.`,
  ];
  if (utkast.periode_fra || utkast.periode_til) deler.push(`Periode ${dato(utkast.periode_fra)}–${dato(utkast.periode_til)}.`);
  if (utkast.deres_referanse) deler.push(`Deres ref.: ${utkast.deres_referanse}.`);
  const kanSende = ai.send === true && k.kan.utsted && Boolean(k.org.kontonr);
  if (ai.send && !k.kan.utsted) deler.push("Du har ikke tilgang til å sende fakturaer, men kan lagre den som utkast.");
  else if (ai.send && !k.org.kontonr) deler.push("Legg inn kontonummer under Innstillinger → Faktura før du sender fakturaer.");
  // Hvor fakturaen går: EHF når kunden kan ta imot det (og EHF er satt opp), ellers e-post.
  let hvor = "Lagres som utkast du kan sende senere.";
  if (kanSende) {
    const m = await en<{ epost: string | null; ehf: boolean | null; orgnr: string | null; ehf_paa: boolean }>(
      k.db,
      `select k.epost, k.ehf, k.orgnr,
              exists (select 1 from faktura.integrasjoner i where i.org_id = k.org_id and i.type = 'peppol' and i.status = 'aktiv')
                and faktura.har_funksjon(k.org_id, 'ehf') as ehf_paa
         from faktura.kunder k where k.id = $1`,
      [kunde!.id],
    );
    hvor =
      m?.ehf && m.orgnr && m.ehf_paa
        ? "Sendes som EHF."
        : m?.epost
          ? `Sendes på e-post til ${m.epost}.`
          : "Kunden har ingen e-postadresse, så fakturaen blir utstedt, men ikke sendt.";
  }
  deler.push(...utkast.merknader);
  return {
    tekst: deler.join(" "),
    forslag: [{ type: "ny_faktura", send: kanSende, gebyr, utkast, tekst: hvor, knapp: kanSende ? "Send faktura" : "Lagre utkast" }],
    utkast,
  };
}

async function sendUtkast(k: Kontekst, ai: AiKommando, kunde: Kunde | null): Promise<Partial<AssistentSvar>> {
  if (!k.kan.utsted) return ingenTilgang("sende fakturaer");
  if (!k.org.kontonr) return { tekst: "Legg inn kontonummer under Innstillinger → Faktura før du sender fakturaer." };
  const utkast = await hentFakturaer(k.db, k.orgId, `and f.status = 'utkast'${kunde ? " and f.kunde_id = $2" : ""}`, kunde ? [kunde.id] : [], "f.opprettet desc", 6);
  if (!utkast.length) return { tekst: kunde ? `Fant ingen utkast til ${kunde.navn}.` : "Fant ingen utkast." };
  const forslag: Forslag[] = utkast.slice(0, 5).map((f) => ({
    type: "send_utkast",
    faktura_id: f.id,
    tekst:
      `Utkast til ${f.kunde}: ${kr(f.sum)} kr${f.forfallsdato ? `, forfall ${dato(f.forfallsdato)}` : ""} (laget ${dato(f.opprettet)}).` +
      (!f.kunde_epost && !f.kunde_ehf ? " Kunden har ingen e-postadresse, så fakturaen blir utstedt, men ikke sendt." : ""),
    knapp: "Send faktura",
  }));
  return {
    tekst: utkast.length === 1 ? "Skal jeg sende utkastet?" : `Fant ${utkast.length > 5 ? "flere enn fem" : utkast.length} utkast${kunde ? ` til ${kunde.navn}` : ""}. Hvilket skal sendes?`,
    forslag,
    lenker: utkast.length > 5 ? [{ tekst: "Alle utkast", til: "/fakturaer?status=utkast" }] : utkast.slice(0, 3).map(lenke),
  };
}

async function sendIgjen(k: Kontekst, ai: AiKommando, kunde: Kunde | null): Promise<Partial<AssistentSvar>> {
  if (!k.kan.utsted) return ingenTilgang("sende fakturaer");
  const liste = numre(ai);
  const { funnet, mangler } = liste.length
    ? await medNummer(k, liste)
    : kunde
      ? { funnet: await hentFakturaer(k.db, k.orgId, "and f.kunde_id = $2 and f.status = 'utstedt'", [kunde.id], "f.fakturanummer desc", 5), mangler: null }
      : { funnet: [], mangler: "Hvilken faktura skal sendes på nytt? Si fakturanummeret." };
  const forslag: Forslag[] = funnet
    .filter((f) => f.status !== "utkast")
    .slice(0, 5)
    .map((f) => ({
      type: "send_igjen",
      faktura_id: f.id,
      fakturanummer: Number(f.fakturanummer),
      tekst: `Send faktura ${f.fakturanummer} til ${f.kunde} på nytt${f.kunde_epost ? ` (${f.kunde_epost})` : ""}.`,
      knapp: "Send på nytt",
    }));
  const deler = [mangler, ...funnet.filter((f) => f.status === "utkast").map((f) => `${Nr(f)} er ikke sendt ennå. Si «send utkastet» for å sende det.`)].filter(Boolean);
  if (!forslag.length && kunde && !liste.length) deler.push(`${kunde.navn} har ingen ubetalte fakturaer.`);
  return { tekst: deler.length ? deler.join(" ") : forslag.length === 1 ? "Skal jeg sende fakturaen på nytt?" : "Hvilken skal sendes på nytt?", forslag };
}

async function sjekkBetaling(k: Kontekst, ai: AiKommando, kunde: Kunde | null): Promise<Partial<AssistentSvar>> {
  const liste = numre(ai);
  const betaler = enLinje(ai.betaler, 120) || null;
  const navn = kunde?.navn ?? betaler;
  const deler: string[] = [];
  const lenker: Lenke[] = [];
  let fakturaer: Faktura[] = [];

  if (liste.length) {
    const r = await medNummer(k, liste);
    fakturaer = r.funnet;
    if (r.mangler) deler.push(r.mangler);
  } else if (kunde) {
    // Ubetalte, og de som er betalt de siste fire månedene.
    fakturaer = await hentFakturaer(
      k.db,
      k.orgId,
      "and f.kunde_id = $2 and (f.status = 'utstedt' or (f.status = 'betalt' and f.fakturadato >= faktura.i_dag() - 120))",
      [kunde.id],
      // De ubetalte først, den som forfalt først øverst; så de siste som er betalt.
      "(f.status = 'utstedt') desc, case when f.status = 'utstedt' then f.forfallsdato end nulls last, f.forfallsdato desc nulls last",
      12,
    );
    const apne = fakturaer.filter((f) => f.status === "utstedt");
    if (!fakturaer.length) deler.push(`${kunde.navn} har ingen fakturaer de siste månedene.`);
    else if (!apne.length) deler.push(`Ja, ${kunde.navn} har betalt alt.`);
    else
      deler.push(
        `${kunde.navn} har ${flertall(apne.length, "ubetalt faktura", "ubetalte fakturaer")} på til sammen ${kr(apne.reduce((s, f) => s + f.utestaende, 0))} kr.`,
      );
  } else if (!betaler) {
    // Ingen bestemt kunde: betalingene de siste sju dagene.
    const betalt = await alle<{ fakturanummer: number; kunde: string; belop: number; betalt_dato: string; id: string }>(
      k.db,
      `select f.id, f.fakturanummer, coalesce(f.kunde ->> 'navn', kk.navn) as kunde, b.belop, b.betalt_dato
         from faktura.betalinger b join faktura.fakturaer f on f.id = b.faktura_id join faktura.kunder kk on kk.id = f.kunde_id
        where b.org_id = $1 and b.type = 'betaling' and b.betalt_dato >= faktura.i_dag() - 7
        order by b.betalt_dato desc, b.opprettet desc limit 8`,
      [k.orgId],
    );
    deler.push(
      betalt.length
        ? `Siste sju dager er det registrert ${flertall(betalt.length, "betaling", "betalinger")}: ${betalt.map((b) => `faktura ${b.fakturanummer} fra ${b.kunde} (${kr(b.belop)} kr, ${dato(b.betalt_dato)})`).join(", ")}.`
        : "Det er ikke registrert noen betalinger de siste sju dagene.",
    );
    lenker.push(...betalt.slice(0, 3).map((b) => ({ tekst: `Faktura ${b.fakturanummer}`, til: `/fakturaer/${b.id}` })));
    const venter = await en<{ n: number }>(
      k.db,
      "select count(*)::int as n from faktura.banktransaksjoner where org_id = $1 and status in ('forslag', 'uavklart')",
      [k.orgId],
    );
    if (venter?.n) {
      deler.push(`${flertall(venter.n, "innbetaling", "innbetalinger")} fra banken er ikke registrert på en faktura ennå.`);
      lenker.push({ tekst: "Innbetalinger", til: "/innbetalinger" });
    }
  }

  // Med kunde: de ubetalte, og de to siste som er betalt.
  const vises = kunde && !liste.length
    ? [...fakturaer.filter((f) => f.status === "utstedt").slice(0, 6), ...fakturaer.filter((f) => f.status !== "utstedt").slice(0, 2)]
    : fakturaer.slice(0, 6);
  deler.push(...vises.map((f) => betalingsstatus(f, k.iDag)));
  lenker.push(...vises.slice(0, 4).map(lenke));

  // Innbetalinger fra banken som ikke er koblet til en faktura, fra betaleren eller kunden.
  const ukoblet = navn
    ? (
        await alle<{ dato: string; belop: number; betaler: string | null; melding: string | null }>(
          k.db,
          `select dato, belop, betaler, melding from faktura.banktransaksjoner
            where org_id = $1 and status in ('forslag', 'uavklart') and dato >= faktura.i_dag() - 90
            order by dato desc limit 300`,
          [k.orgId],
        )
      )
        .filter((t) => sammeNavn(t.betaler, navn))
        .slice(0, 4)
    : [];
  for (const t of ukoblet)
    deler.push(`Det har kommet ${kr(t.belop)} kr fra ${t.betaler} ${dato(t.dato)} som ikke er registrert på en faktura${t.melding ? ` («${enLinje(t.melding, 60)}»)` : ""}.`);
  if (ukoblet.length) lenker.push({ tekst: "Innbetalinger", til: "/innbetalinger" });
  if (betaler && !kunde && !liste.length && !ukoblet.length) deler.push(`Fant ingen innbetalinger fra ${betaler} som ikke er registrert, og ${betaler} er ikke en kunde.`);

  // Forfalte fakturaer kan purres herfra.
  const forslag: Forslag[] = k.kan.utsted
    ? fakturaer
        .filter((f) => forfalt(f, k.iDag))
        .map((f) => purring(f, k.iDag))
        .filter((p): p is Forslag => typeof p !== "string")
        .slice(0, 3)
    : [];
  return { tekst: deler.join(" ") || "Hvem eller hvilken faktura gjelder det?", forslag, lenker };
}

async function registrerBetaling(k: Kontekst, ai: AiKommando, kunde: Kunde | null): Promise<Partial<AssistentSvar>> {
  if (!k.kan.bokfor) return ingenTilgang("registrere betalinger");
  const liste = numre(ai);
  const deler: string[] = [];
  let kandidater: Faktura[] = [];
  if (liste.length) {
    const r = await medNummer(k, liste);
    if (r.mangler) deler.push(r.mangler);
    for (const f of r.funnet) if (f.status !== "utstedt") deler.push(betalingsstatus(f, k.iDag));
    kandidater = r.funnet.filter((f) => f.status === "utstedt");
  } else if (kunde) {
    kandidater = await hentFakturaer(k.db, k.orgId, "and f.kunde_id = $2 and f.status = 'utstedt'", [kunde.id], "f.forfallsdato nulls last, f.fakturanummer", 6);
    if (!kandidater.length) deler.push(`${kunde.navn} har ingen ubetalte fakturaer.`);
  } else deler.push("Hvilken faktura gjelder betalingen? Si fakturanummeret eller kunden.");

  const belop = typeof ai.belop === "number" && Number.isFinite(ai.belop) && ai.belop > 0 ? Math.round(ai.belop * 100) / 100 : null;
  // Samme beløp som det som gjenstår på én av fakturaene: da er det den.
  if (belop != null && kandidater.length > 1) {
    const lik = kandidater.filter((f) => Math.abs(f.utestaende - belop) < 0.005);
    if (lik.length === 1) kandidater = lik;
  }
  let betalt = /^\d{4}-\d{2}-\d{2}$/.test(ai.dato ?? "") ? ai.dato! : k.iDag;
  if (betalt > k.iDag) {
    deler.push(`Betalingsdatoen kan ikke være fram i tid, så jeg bruker i dag.`);
    betalt = k.iDag;
  }
  const forslag: Forslag[] = kandidater.slice(0, 5).map((f) => {
    const b = belop ?? f.utestaende;
    const rest = Math.round((f.utestaende - b) * 100) / 100;
    return {
      type: "betaling",
      faktura_id: f.id,
      fakturanummer: Number(f.fakturanummer),
      belop: b,
      dato: betalt,
      tekst:
        `Registrer ${kr(b)} kr betalt ${dato(betalt)} på faktura ${f.fakturanummer} (${f.kunde}).` +
        (rest > 0.004 ? ` Da gjenstår ${kr(rest)} kr.` : rest < -0.004 ? ` Det er mer enn de ${kr(f.utestaende)} kr som gjenstår.` : ""),
      knapp: "Registrer betaling",
    };
  });
  if (forslag.length > 1) deler.push(`${kunde?.navn ?? "Kunden"} har ${forslag.length} ubetalte fakturaer. Hvilken gjelder betalingen?`);
  else if (forslag.length === 1 && !deler.length) deler.push("Skal jeg registrere betalingen?");
  return { tekst: deler.join(" "), forslag, lenker: kandidater.slice(0, 3).map(lenke) };
}

async function sendPurring(k: Kontekst, ai: AiKommando, kunde: Kunde | null): Promise<Partial<AssistentSvar>> {
  if (!k.kan.utsted) return ingenTilgang("sende purringer");
  const liste = numre(ai);
  const deler: string[] = [];
  let fakturaer: Faktura[] = [];
  if (liste.length) {
    const r = await medNummer(k, liste);
    if (r.mangler) deler.push(r.mangler);
    fakturaer = r.funnet;
  } else if (kunde || ai.alle_forfalte) {
    fakturaer = await hentFakturaer(
      k.db,
      k.orgId,
      `and f.status = 'utstedt' and f.forfallsdato < faktura.i_dag()${kunde ? " and f.kunde_id = $2" : ""}`,
      kunde ? [kunde.id] : [],
      "f.forfallsdato, f.fakturanummer",
      30,
    );
    if (!fakturaer.length) deler.push(kunde ? `${kunde.navn} har ingen forfalte fakturaer.` : "Ingen fakturaer har forfalt.");
  } else deler.push("Hvilken faktura skal purres? Si fakturanummeret, kunden, eller «alle forfalte».");

  const vurdert = fakturaer.map((f) => purring(f, k.iDag));
  const forslag = vurdert.filter((p): p is Forslag => typeof p !== "string").slice(0, 20);
  deler.push(...vurdert.filter((p): p is string => typeof p === "string").slice(0, 5));
  if (forslag.length === 1) deler.unshift("Skal jeg sende purringen?");
  else if (forslag.length > 1) deler.unshift(`${forslag.length} fakturaer kan purres.`);
  return { tekst: deler.join(" "), forslag, lenker: fakturaer.slice(0, 3).map(lenke) };
}

async function utestaende(k: Kontekst): Promise<Partial<AssistentSvar>> {
  const s = await en<{ sum: number; antall: number; forfalt: number; antall_forfalt: number }>(
    k.db,
    `select coalesce(sum(u), 0) as sum, count(*)::int as antall, coalesce(sum(u) filter (where forfall < faktura.i_dag()), 0) as forfalt,
            (count(*) filter (where forfall < faktura.i_dag()))::int as antall_forfalt
       from (select f.sum_inkl_mva - f.kreditert_belop - f.betalt_belop as u, f.forfallsdato as forfall
               from faktura.fakturaer f where f.org_id = $1 and f.type = 'faktura' and f.status = 'utstedt') x`,
    [k.orgId],
  );
  if (!s?.antall) return { tekst: "Ingen fakturaer er ubetalt.", lenker: [] };
  const topp = await alle<{ kunde: string; sum: number }>(
    k.db,
    `select coalesce(f.kunde ->> 'navn', kk.navn) as kunde, sum(f.sum_inkl_mva - f.kreditert_belop - f.betalt_belop) as sum
       from faktura.fakturaer f join faktura.kunder kk on kk.id = f.kunde_id
      where f.org_id = $1 and f.type = 'faktura' and f.status = 'utstedt'
      group by 1 order by 2 desc limit 5`,
    [k.orgId],
  );
  const deler = [`Utestående er ${kr(s.sum)} kr på ${flertall(s.antall, "faktura", "fakturaer")}.`];
  deler.push(s.antall_forfalt ? `${kr(s.forfalt)} kr har forfalt (${flertall(s.antall_forfalt, "faktura", "fakturaer")}).` : "Ingenting har forfalt.");
  deler.push(`Mest: ${topp.map((t) => `${t.kunde} ${kr(t.sum)} kr`).join(", ")}.`);
  if (s.antall_forfalt && k.kan.utsted) deler.push("Si «send purring på alle forfalte» for å purre dem.");
  return { tekst: deler.join(" "), lenker: [{ tekst: "Ubetalte fakturaer", til: "/fakturaer?status=utstedt" }, { tekst: "Reskontro", til: "/rapporter" }] };
}

const SIDEADRESSER: Record<Exclude<(typeof SIDER)[number], "ingen" | "faktura">, [string, string]> = {
  fakturaer: ["/fakturaer", "fakturaene"],
  utkast: ["/fakturaer?status=utkast", "utkastene"],
  ubetalte: ["/fakturaer?status=utstedt", "de ubetalte fakturaene"],
  ny_faktura: ["/fakturaer/ny", "en ny faktura"],
  innbetalinger: ["/innbetalinger", "innbetalingene"],
  kunder: ["/kunder", "kundene"],
  produkter: ["/produkter", "produktene"],
  gjentakende: ["/gjentakende", "de gjentakende fakturaene"],
  rapporter: ["/rapporter", "rapportene"],
  innstillinger: ["/innstillinger", "innstillingene"],
  oversikt: ["/", "oversikten"],
};

async function vis(k: Kontekst, ai: AiKommando, kunde: Kunde | null): Promise<Partial<AssistentSvar>> {
  const liste = numre(ai);
  if (liste.length) {
    const { funnet, mangler } = await medNummer(k, liste.slice(0, 1));
    if (!funnet.length) return { tekst: mangler ?? "Fant ikke fakturaen." };
    return { tekst: `Åpner faktura ${funnet[0].fakturanummer} til ${funnet[0].kunde}.`, gaa_til: `/fakturaer/${funnet[0].id}` };
  }
  const side = SIDEADRESSER[ai.side as keyof typeof SIDEADRESSER];
  if (side) return { tekst: `Åpner ${side[1]}.`, gaa_til: side[0] };
  if (kunde) return sjekkBetaling(k, { ...ai, fakturanumre: [] }, kunde);
  return { tekst: "Hva vil du åpne? Si for eksempel «åpne faktura 1043» eller «gå til innbetalinger»." };
}

export const HJELP =
  "Jeg kan lage og sende fakturaer, sende utkast, sjekke om noen har betalt, registrere betalinger, sende purringer og vise hva som er utestående. Si for eksempel «Send faktura til Kari Hansen for husleie oktober» eller «Har Fjordline betalt?».";

// Fakturadelen.
async function utforFaktura(k: Kontekst, handling: FakturaHandling, ai: AiKommando): Promise<Partial<AssistentSvar>> {
  const kunde = finnKunde(ai, k.g);
  // En kunde som ikke finnes, sies tydelig (unntatt for nye fakturaer, som kan åpnes i skjemaet).
  const ukjent = !kunde && enLinje(ai.kunde_navn, 200) && handling !== "ny_faktura" && !numre(ai).length;
  if (ukjent && handling !== "sjekk_betaling") return { tekst: `Fant ikke «${enLinje(ai.kunde_navn, 200)}» i kunderegisteret.` };
  if (handling === "ny_faktura") return nyFaktura(k, ai);
  if (handling === "send_utkast") return sendUtkast(k, ai, kunde);
  if (handling === "send_igjen") return sendIgjen(k, ai, kunde);
  if (handling === "sjekk_betaling") return sjekkBetaling(k, ukjent ? { ...ai, betaler: ai.betaler ?? ai.kunde_navn } : ai, kunde);
  if (handling === "registrer_betaling") return registrerBetaling(k, ai, kunde);
  if (handling === "send_purring") return sendPurring(k, ai, kunde);
  return kunde ? sjekkBetaling(k, ai, kunde) : utestaende(k);
}

// Alt assistenten har for brukeren: fakturadelen (f) og personaldelen (p), null når de ikke er med.
export type Felles = { db: Db; orgId: string; iDag: string; f: { g: Grunnlag; kan: Rettigheter; org: Org } | null; p: PersonalGrunnlag | null };
const hjelp = (s: Felles) => [s.f ? HJELP : "", s.p ? personalHjelp(s.p) : ""].filter(Boolean).join(" ");
const erFaktura = (h: string): h is FakturaHandling => (FAKTURA_HANDLINGER as readonly string[]).includes(h);
const erPersonal = (h: string): h is PersonalHandling => (PERSONAL_HANDLINGER as readonly string[]).includes(h);

// Gjør svaret fra modellen om til det appen viser.
export async function utfor(s: Felles, ai: AiKommando): Promise<AssistentSvar> {
  const k: Kontekst | null = s.f ? { db: s.db, orgId: s.orgId, iDag: s.iDag, ...s.f } : null;
  const h = typeof ai.handling === "string" ? ai.handling : "annet";
  let r: Partial<AssistentSvar>;
  if (k && erFaktura(h)) r = await utforFaktura(k, h, ai);
  else if (s.p && erPersonal(h)) r = await utforPersonal({ db: s.db, orgId: s.orgId, p: s.p, iDag: s.iDag }, h, ai);
  else if (h === "vis") {
    const side = s.p && ai.side && ai.side !== "ingen" ? visPersonal(s.p, ai.side) : null;
    r = side ?? (k ? await vis(k, ai, finnKunde(ai, k.g)) : { tekst: "Hva vil du åpne? Si for eksempel «åpne tavla» eller «gå til timene»." });
  } else r = { tekst: enLinje(ai.svar, 600) || hjelp(s) };
  return { tekst: r.tekst || hjelp(s), forslag: r.forslag ?? [], lenker: (r.lenker ?? []).slice(0, 5), gaa_til: r.gaa_til ?? null, utkast: r.utkast ?? null };
}

// ---------------------------------------------------------------------------
// Rutene
// ---------------------------------------------------------------------------

const kroppSkjema = z.object({
  tekst: z.string({ error: "Si eller skriv hva du vil gjøre" }).trim().min(2, "Si eller skriv hva du vil gjøre").max(2000, "Kommandoen kan være høyst 2000 tegn"),
  historikk: z
    .array(z.object({ rolle: z.enum(["bruker", "assistent"]), tekst: z.string().max(4000) }))
    .max(12)
    .optional(),
});

const orgId = (c: Context) => z.string().uuid().parse(c.req.param("org"));

// Fakturadelen er med for dem som har tilgang til fakturaene (ikke i regnskapsbyråets egen
// organisasjon, som ikke fakturerer i appen); personaldelen når personalmodulen er slått på.
async function hvaBrukerenHar(db: Db, org: string) {
  await db.query("select faktura.krev($1, 'medlem')", [org]);
  const o = (await en<{ les: boolean; type: string; ai_aktiv: boolean }>(db, "select faktura.kan(id, 'les') as les, type, ai_aktiv from faktura.organisasjoner where id = $1", [org]))!;
  return { faktura: o.les && o.type !== "regnskapsbyraa", ai_aktiv: o.ai_aktiv, p: await hentPersonal(db, org) };
}

export function assistentRuter() {
  const r = new Hono();

  // Hva assistenten kan for brukeren (appen viser knappen og eksemplene etter det).
  r.get("/ai/assistent/status", async (c) => {
    const h = await somBruker(c.get("bruker").id, (db) => hvaBrukerenHar(db, orgId(c)));
    return c.json({
      tilgjengelig: aiPaa() && h.ai_aktiv && (h.faktura || !!h.p),
      faktura: h.faktura,
      personal: h.p ? { leder: h.p.kan.personal, se: h.p.kan.se, ansatt: !!h.p.meg, vaktplan: h.p.vaktplan, tavle: h.p.oppgaver.length > 0 } : null,
    });
  });

  r.post("/ai/assistent", async (c) => {
    if (!aiPaa()) throw new ApiFeil(503, "AI er ikke satt opp");
    const kropp = await c.req.json().catch(() => ({}));
    if (kropp?.lyd) throw gammelApp();
    const b = kroppSkjema.parse(kropp);

    const kjor = <X>(fn: (db: Db) => Promise<X>) => somBruker<X>(c.get("bruker").id, fn);
    const { f, p } = await kjor(async (db) => {
      const h = await hvaBrukerenHar(db, orgId(c));
      if (!h.faktura && !h.p) throw new ApiFeil(403, "Ingen tilgang");
      const f = h.faktura
        ? {
            g: await hentGrunnlag(db, orgId(c)),
            kan: (await en<Rettigheter>(db, "select faktura.kan($1, 'skriv') as skriv, faktura.kan($1, 'utsted') as utsted, faktura.kan($1, 'bokfor') as bokfor", [orgId(c)]))!,
            org: (await en<Org>(db, "select kontonr, standard_forfall_dager, standard_gebyr from faktura.organisasjoner where id = $1", [orgId(c)]))!,
          }
        : null;
      return { f, p: h.p };
    });
    const svar = await medKvote(kjor, orgId(c), "assistent", () =>
      generer<AiKommando>(assistentForesporsel({ g: f?.g ?? null, p }, b.tekst, (b.historikk ?? []).slice(-8))),
    );
    const resultat = await kjor((db) => utfor({ db, orgId: orgId(c), iDag: iDag(), f, p }, svar.data));
    return c.json(resultat satisfies AssistentSvar);
  });

  // Tale til tekst: teksten vises i appen, og brukeren sender den som en kommando.
  r.post("/ai/assistent/tale", taleRute("assistent"));

  return r;
}
