// Ansatte og timer (0035_ansatte_og_timer.sql): ansattregisteret, den ansattes egen
// innlogging, timeføring med levering og godkjenning, og overtiden etter grensene i
// oppsettet (arbeidsmiljøloven: over 9 timer per dag og 40 per uke, minst 40 % tillegg).
//
// Tilgangen avgjøres i databasen (kan og RLS): personal (eier, admin) styrer ansatte og
// godkjenner timer, personal_les (også regnskap) ser alt, og den ansatte (rollen ansatt) ser
// og fører bare sitt eget. Fødselsnummeret krypteres her; bare workeren kan lese det.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { config } from "./config.js";
import { alle, en, somBruker, somSystem, type Db } from "./db.js";
import { ApiFeil, tilHttp } from "./feil.js";
import { fnrGyldig, fodselsdato } from "./fnr.js";
import { ansattFeil, ansattFinnes, ansattnokler, ansattOppslag, planlegg } from "./importer.js";
import { krypter } from "./kryptering.js";
import { AML, beregnUke, uke, type Regler, type Ukesum } from "./arbeidstid.js";
import { dato as visDato, iDag, kontonrGyldig, orgnrGyldig } from "./regler.js";
import { leggIKo } from "./tjenester.js";
import { beregnBemanning } from "./arbeidsplan.js";
import { kortFraTrekk, type Trekk } from "./skattekort.js";

const uuid = z.string().uuid();
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const id = (c: Context) => uuid.parse(c.req.param("id"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);

// --- Skjemaer -----------------------------------------------------------------

// Tomme felt blir null (feltet fjernes).
export const valgfri = <T extends z.ZodTypeAny>(s: T) => z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), s.nullish());
export const tekst = (maks: number, navn: string) => z.string().trim().max(maks, `${navn} kan ha høyst ${maks} tegn`);
export const datoS = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ugyldig dato");
export const klokke = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Skriv klokkeslettet som TT:MM");
const siffer = (navn: string, antall: number, sjekk?: (s: string) => boolean, melding?: string) =>
  z
    .string()
    .transform((v) => v.replace(/[\s.]/g, ""))
    .pipe(z.string().regex(new RegExp(`^\\d{${antall}}$`), `${navn} må ha ${antall} siffer`))
    .refine((v) => !sjekk || sjekk(v), melding ?? `Ugyldig ${navn.toLowerCase()}`);

// Hele og halve feriedager.
const feriedager = z
  .number()
  .min(0, "Feriedagene kan ikke være negative")
  .max(60, "Høyst 60 feriedager i året")
  .refine((n) => Number.isInteger(n * 2), "Skriv hele eller halve dager");

// Faste tillegg på lønnen (0052_faste_tillegg.sql): per måned eller per time, eventuelt for en
// periode. Med id: et tillegg som finnes (endres); uten: et nytt.
const tilleggSkjema = z
  .object({
    id: uuid.optional(),
    navn: z.string({ error: "Skriv hva tillegget heter" }).trim().min(1, "Skriv hva tillegget heter").max(100, "Navnet på tillegget kan ha høyst 100 tegn"),
    belop: z.number({ error: "Skriv beløpet for tillegget" }).gt(0, "Beløpet for tillegget må være over 0").max(10_000_000, "Beløpet for tillegget er for stort"),
    per: z.enum(["maaned", "time"], { error: "Velg om tillegget er per måned eller per time" }).optional(),
    fra: valgfri(datoS),
    til: valgfri(datoS),
  })
  .refine((t) => !t.fra || !t.til || t.til >= t.fra, "Tillegget slutter før det begynner");
type Tillegg = z.infer<typeof tilleggSkjema>;

const ansattSkjema = z.object({
  fornavn: z.string({ error: "Skriv fornavnet" }).trim().min(1, "Skriv fornavnet").max(100, "Fornavnet kan ha høyst 100 tegn"),
  etternavn: z.string({ error: "Skriv etternavnet" }).trim().min(1, "Skriv etternavnet").max(100, "Etternavnet kan ha høyst 100 tegn"),
  // Forkortelsen der plassen er trang (0061_forkortelser.sql; tom: lages av initialene).
  forkortelse: valgfri(
    z
      .string()
      .trim()
      .max(6, "Forkortelsen kan ha høyst 6 tegn")
      .regex(/^[\p{L}\p{N}-]+$/u, "Forkortelsen kan bare ha bokstaver, tall og bindestrek"),
  ),
  epost: valgfri(tekst(254, "E-postadressen").regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, "Ugyldig e-postadresse")),
  telefon: valgfri(tekst(30, "Telefonnummeret")),
  adresse: valgfri(tekst(200, "Adressen")),
  postnr: valgfri(z.string().trim().regex(/^\d{4}$/, "Postnummeret må ha fire siffer")),
  poststed: valgfri(tekst(100, "Poststedet")),
  fodselsdato: valgfri(datoS),
  // Bare til skriving: lagres kryptert og vises aldri igjen (null: fjernes).
  fnr: valgfri(siffer("Fødselsnummeret", 11, fnrGyldig, "Fødselsnummeret er ikke gyldig (sjekk sifrene)")),
  kontonr: valgfri(siffer("Kontonummeret", 11, kontonrGyldig, "Kontonummeret er ikke gyldig (sjekk sifrene)")),
  stilling: valgfri(tekst(100, "Stillingen")),
  stillingsprosent: z.number({ error: "Skriv stillingsprosenten" }).gt(0, "Stillingsprosenten må være over 0").max(100, "Stillingsprosenten kan være høyst 100").optional(),
  ukentlig_arbeidstid: z.number().gt(0, "Arbeidstiden må være over 0").max(60, "Arbeidstiden kan være høyst 60 timer i uka").optional(),
  ansatt_fra: datoS.optional(),
  ansatt_til: valgfri(datoS),
  ansettelsestype: z.enum(["fast", "midlertidig", "tilkalling"]).optional(),
  lonnstype: z.enum(["maaned", "time"]).optional(),
  maanedslonn: valgfri(z.number().min(0, "Lønnen kan ikke være negativ").max(10_000_000)),
  timelonn: valgfri(z.number().min(0, "Lønnen kan ikke være negativ").max(100_000)),
  aktiv: z.boolean().optional(),
  notat: valgfri(tekst(2000, "Notatet")),
  // Rollen (f.eks. lege eller sekretær; 0039_bemanning.sql og 0056_roller.sql). Om personen er
  // ansatt, følger rollen. rolle: navnet i stedet for id-en (en ny rolle lages om den ikke finnes).
  gruppe_id: uuid.nullable().optional(),
  rolle: valgfri(tekst(40, "Rollen")),
  // Kunden personen er hentet inn fra (f.eks. en lege kontoret fakturerer; 0058; null: koblingen fjernes).
  kunde_id: uuid.nullable().optional(),
  bursdag_varsel: z.boolean().optional(), // varsle de andre på bursdagen (0045_bursdager.sql)
  // Feriedager per år for denne ansatte (null: organisasjonens, regnet om etter arbeidsdagene; 0050_feriebank.sql).
  ferie_dager: valgfri(feriedager),
  // Alle de faste tilleggene (de som ikke er med, fjernes). Uten: tilleggene endres ikke.
  tillegg: z.array(tilleggSkjema).max(20, "Høyst 20 faste tillegg").optional(),
  // Skattekortet (0065_lonn.sql): tabelltrekk (tabellnummeret, og prosentsatsen som brukes i
  // ekstra kjøringer), prosenttrekk eller frikort (beløpet), og året det gjelder. Uten
  // skattekort trekkes det 50 %.
  skattekort: valgfri(z.enum(["tabell", "prosent", "frikort"], { error: "Velg tabelltrekk, prosenttrekk eller frikort" })),
  skatt_tabell: valgfri(z.number().int("Tabellnummeret har fire siffer").min(1000, "Tabellnummeret har fire siffer").max(9999, "Tabellnummeret har fire siffer")),
  skatt_prosent: valgfri(z.number().min(0, "Prosentsatsen kan ikke være negativ").max(100, "Prosentsatsen kan være høyst 100")),
  skatt_frikort: valgfri(z.number().min(0, "Frikortbeløpet kan ikke være negativt").max(100_000_000, "Frikortbeløpet er for stort")),
  skattekort_aar: valgfri(z.number().int().min(2000, "Ugyldig år").max(2100, "Ugyldig år")),
  // Biarbeidsgiver: den ansatte har hovedarbeidsgiveren et annet sted, og trekket for lønn fra
  // biarbeidsgiver brukes (0068; skattekortet fra Skatteetaten regnes om).
  biarbeidsgiver: z.boolean().optional(),
  // A-meldingen (0077_amelding.sql): yrkeskoden (7 siffer, SSBs yrkeskoder), typen arbeidsforhold,
  // arbeidstidsordningen og årsaken til sluttdatoen.
  yrkeskode: valgfri(siffer("Yrkeskoden", 7)),
  arbeidsforhold_type: z.enum(["ordinaertArbeidsforhold", "maritimtArbeidsforhold", "frilanserOppdragstakerHonorarPersonerMm"]).optional(),
  // Frilansere, oppdragstakere og styremedlemmer (0096): honoraret er honorar for oppdrag eller
  // styrehonorar (og godtgjørelse for verv).
  honorar_art: z.enum(["honorar", "styrehonorar"]).optional(),
  arbeidstidsordning: z
    .enum(["ikkeSkift", "andreSkift", "skift365", "doegnkontinuerligSkiftOgTurnus355", "helkontinuerligSkiftOgAndreOrdninger336", "offshore336"])
    .optional(),
  aarsak_sluttdato: valgfri(
    z.enum([
      "arbeidstakerHarSagtOppSelv",
      "arbeidsgiverHarSagtOppArbeidstaker",
      "kontraktEngasjementEllerVikariatErUtloept",
      "byttetLoenssystemEllerRegnskapsfoerer",
      "endringIOrganisasjonsstrukturEllerByttetJobbInternt",
      "arbeidsforholdetSkulleAldriVaertRapportert",
    ]),
  ),
});

const oppsettSkjema = z.object({
  aktiv: z.boolean().optional(),
  daglig_grense: z.number().gt(0, "Grensen må være over 0").max(24, "Høyst 24 timer per dag").optional(),
  ukentlig_grense: z.number().gt(0, "Grensen må være over 0").max(80, "Høyst 80 timer per uke").optional(),
  overtid_prosent: z.number().int().min(40, "Overtidstillegget er minst 40 % (arbeidsmiljøloven § 10-6)").max(200).optional(),
  // Bursdagsvarsler til de andre i organisasjonen (0045_bursdager.sql).
  bursdag_varsel: z.enum(["av", "push", "epost", "begge"]).optional(),
  // Arbeidstiden i full stilling, standarden for nye ansatte (0048_full_stilling.sql).
  full_stilling: z.number().gt(0, "Arbeidstiden må være over 0").max(60, "Høyst 60 timer i uka").optional(),
  // Feriedager per år med fem arbeidsdager i uka (0050_feriebank.sql).
  ferie_dager: feriedager.optional(),
  // Vaktbytte mellom de ansatte (0060_vaktbytte.sql): av, med godkjenning eller uten.
  vaktbytte: z.enum(["av", "godkjenning", "fritt"]).optional(),
  // Åpent i helgene (0064_helg.sql): med stengt helg viser appen bare mandag–fredag.
  helg: z.boolean().optional(),
  // Timebank (0073_timebank.sql): overtid og ekstratimer kan settes i banken og avspaseres senere.
  timebank: z.boolean().optional(),
  // Fridagen ved vaktbytte (0074_vaktbytte_fridag.sql): den som gir bort en fast arbeidsdag, velger
  // hva fridagen tas fra (ferie, timebanken eller betalt fravær).
  vaktbytte_fridag: z.boolean().optional(),
  // Lønnskjøringen (0065_lonn.sql): sonen for arbeidsgiveravgift, OTP-satsen (0: uten OTP),
  // feriepengesatsen, lønnsdagen og måneden med halvt skattetrekk.
  aga_sone: z.enum(["1", "1a", "2", "3", "4", "4a", "5"], { error: "Velg sone for arbeidsgiveravgift" }).optional(),
  otp_prosent: z
    .number()
    .refine((v) => v === 0 || (v >= 2 && v <= 25), "OTP-satsen er 0 (uten OTP) eller fra 2 til 25 %")
    .optional(),
  feriepenger_prosent: z.number().min(10.2, "Feriepengene er minst 10,2 %").max(20, "Feriepengene kan være høyst 20 %").optional(),
  lonnsdag: z.number().int().min(1, "Velg en dag fra 1 til 31").max(31, "Velg en dag fra 1 til 31").optional(),
  halv_skatt: z.enum(["november", "desember"]).optional(),
  // Egenmelding (0071_egenmelding.sql): dager per gang og grensene i løpet av 12 måneder for egen
  // sykdom (null: ingen grense; lovens 3 dager og 4 ganger gjelder alltid), og dager per gang for
  // sykt barn.
  egenmelding_dager: z.number().int().min(3, "Egenmelding gjelder minst 3 dager per gang (loven)").max(16, "Høyst 16 dager (arbeidsgiverperioden)").optional(),
  egenmelding_ganger: z.number().int().min(4, "Loven gir minst 4 ganger i løpet av 12 måneder").max(52).nullable().optional(),
  egenmelding_dager_aar: z.number().int().min(12, "Minst 12 dager (4 ganger 3 dager)").max(366).nullable().optional(),
  egenmelding_barn_dager: z.number().int().min(3, "Egenmelding for sykt barn gjelder minst 3 dager per gang").max(30).optional(),
  // Betalingsfila fra lønnskjøringen (0076_lonn_betalingsfil.sql): kontoen lønnen betales fra
  // (null: organisasjonens kontonummer), BIC for banken den er i, og formatet.
  lonnskonto: valgfri(siffer("Lønnskontoen", 11, kontonrGyldig, "Lønnskontoen er ikke gyldig (sjekk sifrene)")),
  // Skatteetatens kontonummer for forskuddstrekk og utleggstrekk (0082): forskuddstrekket betales
  // med betalingsfila første virkedag etter lønnsdagen.
  skatt_kontonr: valgfri(siffer("Skatteetatens kontonummer", 11, kontonrGyldig, "Skatteetatens kontonummer er ikke gyldig (sjekk sifrene)")),
  bank_bic: valgfri(
    z
      .string()
      .transform((v) => v.replace(/\s/g, "").toUpperCase())
      .pipe(z.string().regex(/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/, "BIC har 8 eller 11 tegn, f.eks. DNBANOKK for DNB")),
  ),
  betalingsfil_format: z.enum(["pain.001.001.03", "pain.001.001.09"]).optional(),
  // A-meldingen (0077_amelding.sql): virksomheten (underenheten) arbeidsforholdene rapporteres
  // under, og pensjonsinnretningen (OTP-leverandøren).
  virksomhet_orgnr: valgfri(siffer("Organisasjonsnummeret til virksomheten", 9, orgnrGyldig, "Organisasjonsnummeret til virksomheten er ikke gyldig")),
  pensjonsinnretning_orgnr: valgfri(siffer("Organisasjonsnummeret til pensjonsleverandøren", 9, orgnrGyldig, "Organisasjonsnummeret til pensjonsleverandøren er ikke gyldig")),
  // Lønn under sykdom etter arbeidsgiverperioden (0079_nav_sykepenger.sql): arbeidsgiveren betaler
  // og krever refusjon fra NAV, eller NAV betaler sykepengene til den ansatte.
  sykepenger_refusjon: z.boolean().optional(),
  // Satsene for reiser (0083): statens satser (det som er over de trekkfrie, er trekkpliktig) eller
  // bare de trekkfrie satsene.
  reise_satser: z.enum(["staten", "trekkfri"]).optional(),
  // Lønnskjøringen for måneden lages av seg selv den første i måneden og holdes oppdatert
  // (0088_lonn_automatikk.sql, lonnAutomatikk.ts).
  auto_kjoring: z.boolean().optional(),
});

const foringSkjema = z.object({
  ansatt_id: uuid.optional(),
  dato: datoS,
  fra: valgfri(klokke),
  til: valgfri(klokke),
  pause_min: z.number().int().min(0, "Pausen kan ikke være negativ").max(600, "Pausen kan være høyst 10 timer").optional(),
  timer: valgfri(z.number().gt(0, "Skriv antall timer").max(24, "Høyst 24 timer i én føring")),
  overtid_prosent: valgfri(z.number().int().min(40, "Overtidstillegget er minst 40 %").max(200)),
  // Ekstratimer uten overtid (0069): aldri overtid, og ikke med i grensene.
  uten_overtid: z.boolean().optional(),
  // Til timebanken (0073): overtid og ekstratimer avspaseres senere i stedet for å lønnes nå.
  timebank: z.boolean().optional(),
  beskrivelse: valgfri(tekst(500, "Beskrivelsen")),
  vakt_id: uuid.optional(), // timene føres fra en vakt (bare når føringen lages)
});

// --- Utvalg -------------------------------------------------------------------

const ANSATT = `
  select a.id, a.ansattnummer, a.fornavn, a.etternavn, a.forkortelse, a.epost, a.telefon, a.adresse, a.postnr, a.poststed,
         a.fodselsdato, a.har_fnr, a.kontonr, a.stilling, a.stillingsprosent, a.ukentlig_arbeidstid, a.ansatt_fra,
         a.ansatt_til, a.ansettelsestype, a.lonnstype, a.maanedslonn, a.timelonn, a.aktiv, a.notat, a.gruppe_id, a.bursdag_varsel, a.ferie_dager, a.opprettet, a.oppdatert,
         -- Skattekortet (0065_lonn.sql), og det som er hentet fra Skatteetaten (0068).
         a.skattekort, a.skatt_tabell, a.skatt_prosent, a.skatt_frikort, a.skattekort_aar, a.biarbeidsgiver, a.skattekort_kilde,
         a.skattekort_hentet, a.skattekort_resultat, to_char(a.skattekort_utstedt, 'YYYY-MM-DD') as skattekort_utstedt, a.skattekort_tillegg,
         a.skattekort_trekk,
         -- Arbeidsforholdet i a-meldingen (0077_amelding.sql).
         a.yrkeskode, a.arbeidsforhold_type, a.arbeidstidsordning, a.aarsak_sluttdato, a.honorar_art,
         to_char(a.siste_lonnsendring, 'YYYY-MM-DD') as siste_lonnsendring, to_char(a.siste_stillingsendring, 'YYYY-MM-DD') as siste_stillingsendring,
         -- Rollen, om personen er ansatt (følger rollen, 0056_roller.sql), og om den er med på tavla (0057).
         (select g.navn from faktura.ansattgrupper g where g.org_id = a.org_id and g.id = a.gruppe_id) as rolle, a.arbeidstaker,
         coalesce((select g.tavle from faktura.ansattgrupper g where g.org_id = a.org_id and g.id = a.gruppe_id), true) as tavle,
         -- Kunden personen er hentet inn fra (0058; navnet bare for dem som ser kundene).
         a.kunde_id, (select k.navn from faktura.kunder k where k.org_id = a.org_id and k.id = a.kunde_id) as kunde,
         -- Ukedagene i den faste arbeidsplanen som gjelder i dag (1 = mandag).
         (select coalesce(array_agg(d.ukedag order by d.ukedag), '{}') from faktura.arbeidsplan_dager d
           where d.org_id = a.org_id
             and d.plan_id = (select p.id from faktura.arbeidsplaner p where p.org_id = a.org_id and p.ansatt_id = a.id and p.gjelder_fra <= faktura.i_dag()
                               order by p.gjelder_fra desc limit 1)) as arbeidsdager,
         -- De faste tilleggene på lønnen (0052_faste_tillegg.sql).
         (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'navn', t.navn, 'belop', t.belop, 'per', t.per, 'fra', t.fra, 'til', t.til)
                                    order by t.opprettet, t.id), '[]'::jsonb)
            from faktura.ansatt_tillegg t where t.org_id = a.org_id and t.ansatt_id = a.id) as tillegg,
         a.bruker_id = faktura.bruker_id() as meg,
         case when a.bruker_id is not null
                   and exists (select 1 from faktura.medlemmer m where m.org_id = a.org_id and m.bruker_id = a.bruker_id) then 'koblet'
              when exists (select 1 from faktura.invitasjoner i
                            where i.org_id = a.org_id and i.ansatt_id = a.id and i.akseptert_at is null and i.utloper > now()) then 'invitert'
         end as tilgang
    from faktura.ansatte a`;

const FORING = `
  select t.id, t.ansatt_id, a.fornavn || ' ' || a.etternavn as ansatt_navn, t.dato,
         to_char(t.fra, 'HH24:MI') as fra, to_char(t.til, 'HH24:MI') as til, t.pause_min, t.timer, t.overtid_prosent, t.uten_overtid, t.timebank,
         t.beskrivelse, t.status, t.avvist_grunn, t.levert_at, t.godkjent_at, t.opprettet, t.vakt_id
    from faktura.timeforinger t
    join faktura.ansatte a on a.org_id = t.org_id and a.id = t.ansatt_id`;

type Foringsrad = {
  id: string;
  ansatt_id: string;
  ansatt_navn: string;
  dato: string;
  timer: number;
  overtid_prosent: number | null;
  uten_overtid: boolean;
  timebank: boolean;
  status: string;
};

export type Bursdagsvarsel = "av" | "push" | "epost" | "begge";
export type Vaktbytte = "av" | "godkjenning" | "fritt";
export type AgaSone = "1" | "1a" | "2" | "3" | "4" | "4a" | "5";
type Oppsett = Regler & {
  aktiv: boolean;
  bursdag_varsel: Bursdagsvarsel;
  full_stilling: number;
  ferie_dager: number;
  vaktbytte: Vaktbytte;
  helg: boolean;
  aga_sone: AgaSone;
  otp_prosent: number;
  feriepenger_prosent: number;
  lonnsdag: number;
  halv_skatt: "november" | "desember";
  egenmelding_dager: number;
  egenmelding_ganger: number | null;
  egenmelding_dager_aar: number | null;
  egenmelding_barn_dager: number;
  timebank: boolean;
  vaktbytte_fridag: boolean;
  lonnskonto: string | null;
  skatt_kontonr: string | null;
  bank_bic: string | null;
  betalingsfil_format: "pain.001.001.03" | "pain.001.001.09";
  virksomhet_orgnr: string | null;
  pensjonsinnretning_orgnr: string | null;
  sykepenger_refusjon: boolean;
  reise_satser: "staten" | "trekkfri";
  auto_kjoring: boolean;
};
export async function regler(db: Db, org: string): Promise<Oppsett> {
  const r = await en<Oppsett>(
    db,
    `select aktiv, daglig_grense, ukentlig_grense, overtid_prosent, bursdag_varsel, full_stilling, ferie_dager, vaktbytte, helg,
            aga_sone, otp_prosent, feriepenger_prosent, lonnsdag, halv_skatt, egenmelding_dager, egenmelding_ganger, egenmelding_dager_aar, egenmelding_barn_dager,
            timebank, vaktbytte_fridag, lonnskonto, skatt_kontonr, bank_bic, betalingsfil_format, virksomhet_orgnr, pensjonsinnretning_orgnr, sykepenger_refusjon,
            reise_satser, auto_kjoring
       from faktura.lonn_oppsett where org_id = $1`,
    [org],
  );
  return (
    r ?? {
      aktiv: false,
      ...AML,
      bursdag_varsel: "av",
      full_stilling: 37.5,
      ferie_dager: 25,
      vaktbytte: "godkjenning",
      helg: true,
      aga_sone: "1",
      otp_prosent: 2,
      feriepenger_prosent: 12,
      lonnsdag: 20,
      halv_skatt: "desember",
      egenmelding_dager: 3,
      egenmelding_ganger: 4,
      egenmelding_dager_aar: null,
      egenmelding_barn_dager: 3,
      timebank: false,
      vaktbytte_fridag: true,
      lonnskonto: null,
      skatt_kontonr: null,
      bank_bic: null,
      betalingsfil_format: "pain.001.001.03",
      virksomhet_orgnr: null,
      pensjonsinnretning_orgnr: null,
      sykepenger_refusjon: true,
      reise_satser: "staten",
      auto_kjoring: true,
    }
  );
}

// Den innloggedes egen ansattrad i organisasjonen (eller null).
const meg = (db: Db, org: string) =>
  en<{ id: string; fornavn: string; etternavn: string }>(db, "select id, fornavn, etternavn from faktura.ansatte where org_id = $1 and bruker_id = faktura.bruker_id()", [
    org,
  ]);

// Ukene med føringer: sum, ordinære timer, overtid og merarbeid per ansatt og uke, status for
// uka (den laveste: utkast før levert før godkjent; avvist foran alt), og timene som var
// planlagt i vaktplanen (publiserte vakter, nøkkel «ansatt:mandag»).
function ukesummer(foringer: Foringsrad[], r: Regler, avtalt: Map<string, number | null>, planlagt: Map<string, number>) {
  const uker = new Map<string, { ansatt_id: string; ansatt_navn: string; aar: number; uke: number; fra: string; til: string; rader: Foringsrad[] }>();
  for (const f of foringer) {
    const u = uke(f.dato);
    const nokkel = `${f.ansatt_id}:${u.fra}`;
    if (!uker.has(nokkel)) uker.set(nokkel, { ansatt_id: f.ansatt_id, ansatt_navn: f.ansatt_navn, ...u, rader: [] });
    uker.get(nokkel)!.rader.push(f);
  }
  const rekke = ["avvist", "utkast", "levert", "godkjent"];
  return [...uker.values()]
    .sort((a, b) => b.fra.localeCompare(a.fra) || a.ansatt_navn.localeCompare(b.ansatt_navn, "nb"))
    .map(({ rader, ...u }) => ({
      ...u,
      ...(beregnUke(rader, r, avtalt.get(u.ansatt_id)) as Ukesum),
      // Timene som settes i timebanken (0073), av summen over.
      timebank: Math.round(rader.filter((x) => x.timebank).reduce((sum, x) => sum + Number(x.timer), 0) * 100) / 100,
      planlagt: planlagt.get(`${u.ansatt_id}:${u.fra}`) ?? null,
      status: rekke.find((s) => rader.some((x) => x.status === s))!,
      antall: rader.length,
      antall_status: Object.fromEntries(rekke.map((s) => [s, rader.filter((x) => x.status === s).length])) as Record<string, number>,
    }));
}

// Push til eier og administrator (de som godkjenner timer, planlegger vakter og får vite om
// sykdom), unntatt den som selv gjorde det. Slås opp av serveren: en ansatt ser ikke hvem de andre medlemmene er.
export async function varslePersonal(org: string, unntatt: string, hendelse: "timer" | "vakter" | "fravaer" | "reiser", tittel: string, tekst: string, url: string, tag: string) {
  const mottakere = await somSystem((db) =>
    alle<{ bruker_id: string }>(db, "select bruker_id from faktura.medlemmer where org_id = $1 and rolle in ('eier', 'admin') and bruker_id <> $2", [
      org,
      unntatt,
    ]),
  );
  if (mottakere.length)
    await leggIKo({ type: "varsel", varsel: { hendelse, org_id: org, bruker_ider: mottakere.map((m) => m.bruker_id), tittel, tekst, url, tag } });
}

const timerTekst = (t: number) => `${t.toLocaleString("nb-NO", { maximumFractionDigits: 2 })} t`;
const TIMEBANK_TYPE = "Bare overtid og ekstratimer (uten overtid) kan settes i timebanken";

export function ansattRuter() {
  const r = new Hono();

  // --- Oppsett ---------------------------------------------------------------

  r.get("/lonn-oppsett", async (c) => c.json(await bruk(c, (db) => regler(db, orgId(c)))));

  r.put("/lonn-oppsett", async (c) => {
    const b = oppsettSkjema.parse(await c.req.json().catch(() => ({})));
    return c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'admin')", [orgId(c)]);
        const naa = await regler(db, orgId(c));
        const ny = { ...naa, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) };
        await db.query(
          `insert into faktura.lonn_oppsett (org_id, aktiv, daglig_grense, ukentlig_grense, overtid_prosent, bursdag_varsel, full_stilling, ferie_dager, vaktbytte, helg,
                                             aga_sone, otp_prosent, feriepenger_prosent, lonnsdag, halv_skatt,
                                             egenmelding_dager, egenmelding_ganger, egenmelding_dager_aar, egenmelding_barn_dager, timebank,
                                             vaktbytte_fridag, lonnskonto, bank_bic, betalingsfil_format, virksomhet_orgnr, pensjonsinnretning_orgnr, sykepenger_refusjon,
                                             skatt_kontonr, reise_satser, auto_kjoring)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30)
           on conflict (org_id) do update set aktiv = excluded.aktiv, daglig_grense = excluded.daglig_grense,
             ukentlig_grense = excluded.ukentlig_grense, overtid_prosent = excluded.overtid_prosent, bursdag_varsel = excluded.bursdag_varsel,
             full_stilling = excluded.full_stilling, ferie_dager = excluded.ferie_dager, vaktbytte = excluded.vaktbytte, helg = excluded.helg,
             aga_sone = excluded.aga_sone, otp_prosent = excluded.otp_prosent, feriepenger_prosent = excluded.feriepenger_prosent,
             lonnsdag = excluded.lonnsdag, halv_skatt = excluded.halv_skatt, egenmelding_dager = excluded.egenmelding_dager,
             egenmelding_ganger = excluded.egenmelding_ganger, egenmelding_dager_aar = excluded.egenmelding_dager_aar,
             egenmelding_barn_dager = excluded.egenmelding_barn_dager, timebank = excluded.timebank,
             vaktbytte_fridag = excluded.vaktbytte_fridag, lonnskonto = excluded.lonnskonto, bank_bic = excluded.bank_bic,
             betalingsfil_format = excluded.betalingsfil_format, virksomhet_orgnr = excluded.virksomhet_orgnr,
             pensjonsinnretning_orgnr = excluded.pensjonsinnretning_orgnr, sykepenger_refusjon = excluded.sykepenger_refusjon,
             skatt_kontonr = excluded.skatt_kontonr, reise_satser = excluded.reise_satser, auto_kjoring = excluded.auto_kjoring`,
          [
            orgId(c),
            ny.aktiv,
            ny.daglig_grense,
            ny.ukentlig_grense,
            ny.overtid_prosent,
            ny.bursdag_varsel,
            ny.full_stilling,
            ny.ferie_dager,
            ny.vaktbytte,
            ny.helg,
            ny.aga_sone,
            ny.otp_prosent,
            ny.feriepenger_prosent,
            ny.lonnsdag,
            ny.halv_skatt,
            ny.egenmelding_dager,
            ny.egenmelding_ganger,
            ny.egenmelding_dager_aar,
            ny.egenmelding_barn_dager,
            ny.timebank,
            ny.vaktbytte_fridag,
            ny.lonnskonto ?? null,
            ny.bank_bic ?? null,
            ny.betalingsfil_format,
            ny.virksomhet_orgnr ?? null,
            ny.pensjonsinnretning_orgnr ?? null,
            ny.sykepenger_refusjon,
            ny.skatt_kontonr ?? null,
            ny.reise_satser ?? "staten",
            ny.auto_kjoring ?? true,
          ],
        );
        return regler(db, orgId(c));
      }),
    );
  });

  // --- Ansatte ---------------------------------------------------------------

  r.get("/ansatte", async (c) => {
    const aktiv = c.req.query("aktiv");
    return c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'personal_les')", [orgId(c)]);
        return alle(db, `${ANSATT} where a.org_id = $1 and ($2::boolean is null or a.aktiv = $2) order by a.aktiv desc, a.etternavn, a.fornavn`, [
          orgId(c),
          aktiv === undefined ? null : aktiv !== "false",
        ]);
      }),
    );
  });

  // Den innloggede som ansatt (for timeføringen), eller null.
  r.get("/ansatte/meg", async (c) => c.json(await bruk(c, (db) => en(db, `${ANSATT} where a.org_id = $1 and a.bruker_id = faktura.bruker_id()`, [orgId(c)]))));

  r.get("/ansatte/:id", async (c) => {
    const a = await bruk(c, (db) => en(db, `${ANSATT} where a.org_id = $1 and a.id = $2`, [orgId(c), id(c)]));
    if (!a) throw new ApiFeil(404, "Fant ikke den ansatte");
    return c.json(a);
  });

  // Fødselsnummeret krypteres (eller er kryptert på forhånd, i importen), og fødselsdatoen hentes
  // fra det. De faste tilleggene lagres for seg (lagreTillegg).
  async function felter(b: z.infer<typeof ansattSkjema> | Partial<z.infer<typeof ansattSkjema>>, kryptert?: Map<string, Buffer>) {
    const { fnr, tillegg: _tillegg, rolle: _rolle, ...resten } = b;
    const f: Record<string, unknown> = Object.fromEntries(Object.entries(resten).filter(([, v]) => v !== undefined));
    if (fnr !== undefined) {
      f.fnr_kryptert = fnr ? (kryptert?.get(fnr) ?? (await krypter(fnr))) : null;
      if (fnr) f.fodselsdato = fodselsdato(fnr);
    }
    if (typeof f.fodselsdato === "string" && f.fodselsdato > iDag()) throw new ApiFeil(400, "Fødselsdatoen kan ikke være fram i tid");
    return f;
  }

  // Rollen og kunden må finnes i organisasjonen (databasen sjekker det også, men med en uklar melding).
  async function sjekkGruppe(db: Db, org: string, f: Record<string, unknown>) {
    if (typeof f.gruppe_id === "string" && !(await en(db, "select 1 from faktura.ansattgrupper where org_id = $1 and id = $2", [org, f.gruppe_id])))
      throw new ApiFeil(400, "Fant ikke rollen");
    if (typeof f.kunde_id === "string" && !(await en(db, "select 1 from faktura.kunder where org_id = $1 and id = $2", [org, f.kunde_id])))
      throw new ApiFeil(400, "Fant ikke kunden");
  }

  // Rollen med det navnet (store og små bokstaver teller ikke), eller en ny (for ansatte; den kan
  // gjøres om til en rolle for dem som ikke er ansatt etterpå). husk: rollene som er slått opp.
  async function rolleId(db: Db, org: string, navn: string, husk?: Map<string, string>) {
    const n = navn.trim();
    const kjent = husk?.get(n.toLowerCase());
    if (kjent) return kjent;
    const g =
      (await en<{ id: string }>(db, "select id from faktura.ansattgrupper where org_id = $1 and lower(btrim(navn)) = lower($2) order by rekkefolge, opprettet limit 1", [
        org,
        n,
      ])) ??
      (await en<{ id: string }>(
        db,
        `insert into faktura.ansattgrupper (org_id, navn, rekkefolge)
         values ($1, $2, (select coalesce(max(rekkefolge), 0) + 1 from faktura.ansattgrupper where org_id = $1)) returning id`,
        [org, n.charAt(0).toUpperCase() + n.slice(1)],
      ));
    husk?.set(n.toLowerCase(), g!.id);
    return g!.id;
  }

  // Ny ansatt (felt: kolonnene fra felter). Uten arbeidstid får den nye ansatte organisasjonens
  // arbeidstid i full stilling.
  async function nyAnsatt(db: Db, org: string, f: Record<string, unknown>, fullStilling?: number) {
    if (f.ukentlig_arbeidstid === undefined) f.ukentlig_arbeidstid = fullStilling ?? (await regler(db, org)).full_stilling;
    const navn = Object.keys(f);
    return (await en<{ id: string }>(
      db,
      `insert into faktura.ansatte (org_id, ${navn.join(", ")}) values ($1, ${navn.map((_, i) => `$${i + 2}`).join(", ")}) returning id`,
      [org, ...navn.map((k) => f[k])],
    ))!.id;
  }

  // De faste tilleggene til en ansatt. erstatt: listen er alle tilleggene (de med id endres, de
  // uten legges til, og de som ikke er med, fjernes). Ellers (importen) legges de til, og et
  // tillegg med samme navn som et som finnes, får beløpet fra fila (og perioden og «per» når de
  // står der).
  async function lagreTillegg(db: Db, org: string, ansatt: string, liste: Tillegg[], erstatt: boolean) {
    const finnes = await alle<{ id: string; navn: string }>(db, "select id, navn from faktura.ansatt_tillegg where org_id = $1 and ansatt_id = $2", [org, ansatt]);
    const beholdt = new Set<string>();
    for (const t of liste) {
      const id = erstatt ? t.id : finnes.find((x) => x.navn.trim().toLowerCase() === t.navn.toLowerCase())?.id;
      if (id && !finnes.some((x) => x.id === id)) throw new ApiFeil(404, "Fant ikke tillegget");
      if (id) beholdt.add(id);
      if (id && erstatt)
        await db.query("update faktura.ansatt_tillegg set navn = $3, belop = $4, per = $5, fra = $6, til = $7 where org_id = $1 and id = $2", [
          org,
          id,
          t.navn,
          t.belop,
          t.per ?? "maaned",
          t.fra ?? null,
          t.til ?? null,
        ]);
      else if (id)
        await db.query("update faktura.ansatt_tillegg set belop = $3, per = coalesce($4, per), fra = coalesce($5, fra), til = coalesce($6, til) where org_id = $1 and id = $2", [
          org,
          id,
          t.belop,
          t.per ?? null,
          t.fra ?? null,
          t.til ?? null,
        ]);
      else
        await db.query("insert into faktura.ansatt_tillegg (org_id, ansatt_id, navn, belop, per, fra, til) values ($1, $2, $3, $4, $5, $6, $7)", [
          org,
          ansatt,
          t.navn,
          t.belop,
          t.per ?? "maaned",
          t.fra ?? null,
          t.til ?? null,
        ]);
    }
    const fjern = erstatt ? finnes.filter((x) => !beholdt.has(x.id)).map((x) => x.id) : [];
    if (fjern.length) await db.query("delete from faktura.ansatt_tillegg where org_id = $1 and id = any($2::uuid[])", [org, fjern]);
  }

  r.post("/ansatte", async (c) => {
    const b = ansattSkjema.parse(await c.req.json().catch(() => ({})));
    const f = await felter(b);
    const a = await bruk(c, async (db) => {
      if (b.rolle && b.gruppe_id === undefined) f.gruppe_id = await rolleId(db, orgId(c), b.rolle);
      await sjekkGruppe(db, orgId(c), f);
      const ny = await nyAnsatt(db, orgId(c), f);
      if (b.tillegg?.length) await lagreTillegg(db, orgId(c), ny, b.tillegg, true);
      return en(db, `${ANSATT} where a.org_id = $1 and a.id = $2`, [orgId(c), ny]);
    });
    if (b.fnr) await hentSkattekortFor(c, [a.id]);
    return c.json(a, 201);
  });

  // Med godkjent tilgang til Skatteetaten hentes skattekortet når fødselsnummeret legges inn.
  async function hentSkattekortFor(c: Context, ider: string[]) {
    const t = await bruk(c, (db) => en<{ status: string }>(db, "select status from faktura.skattekort_tilgang where org_id = $1", [orgId(c)]));
    if (t?.status === "godkjent" && ider.length) await leggIKo({ type: "skattekort-hent", org_id: orgId(c), ansatt_ider: ider, kilde: "ansatt" });
  }

  // Skattekortet fra Skatteetaten regnes om når valget av biarbeidsgiver endres (fra trekket for
  // lønn fra biarbeidsgiver eller hovedarbeidsgiver), med mindre skattekortet også endres for hånd.
  async function regnOmSkattekort(db: Db, org: string, ansatt: string, b: Partial<z.infer<typeof ansattSkjema>>, f: Record<string, unknown>) {
    if (b.biarbeidsgiver === undefined) return;
    const n = await en<Record<string, any>>(
      db,
      `select biarbeidsgiver, skattekort, skatt_tabell, skatt_prosent::float8 as skatt_prosent, skatt_frikort::float8 as skatt_frikort,
              skattekort_kilde, skattekort_trekk
         from faktura.ansatte where org_id = $1 and id = $2`,
      [org, ansatt],
    );
    if (!n || n.biarbeidsgiver === b.biarbeidsgiver || n.skattekort_kilde !== "skatteetaten" || !n.skattekort_trekk?.length) return;
    // Skjemaet sender gjerne hele skattekortet; bare verdier som er endret, teller som endret for hånd.
    if (["skattekort", "skatt_tabell", "skatt_prosent", "skatt_frikort"].some((k) => k in f && (f[k] ?? null) !== (n[k] ?? null))) return;
    const kort = kortFraTrekk(n.skattekort_trekk as Trekk[], b.biarbeidsgiver);
    if (kort) Object.assign(f, kort);
  }

  r.patch("/ansatte/:id", async (c) => {
    const kropp = await c.req.json().catch(() => ({}));
    const b = ansattSkjema.partial().parse(kropp);
    // Lønns- og stillingsendringer (0080): datoen de gjelder fra (standard i dag), og grunnen.
    const endring = z
      .object({ lonn_gjelder_fra: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ugyldig dato").optional(), lonn_grunn: z.string().trim().max(300).optional() })
      .parse(kropp);
    const f = await felter(b);
    if (!Object.keys(f).length && !b.tillegg && !b.rolle) throw new ApiFeil(400, "Ingen felt å endre");
    const a = await bruk(c, async (db) => {
      if (b.rolle && b.gruppe_id === undefined) f.gruppe_id = await rolleId(db, orgId(c), b.rolle);
      await sjekkGruppe(db, orgId(c), f);
      await regnOmSkattekort(db, orgId(c), id(c), b, f);
      const navn = Object.keys(f);
      if (endring.lonn_gjelder_fra || endring.lonn_grunn)
        await db.query("select set_config('faktura.lonn_gjelder_fra', $1, true), set_config('faktura.lonn_grunn', $2, true)", [
          endring.lonn_gjelder_fra ?? "",
          endring.lonn_grunn ?? "",
        ]);
      if (navn.length) {
        const res = await db.query(`update faktura.ansatte set ${navn.map((k, i) => `${k} = $${i + 3}`).join(", ")} where org_id = $1 and id = $2`, [
          orgId(c),
          id(c),
          ...navn.map((k) => f[k]),
        ]);
        if (!res.rowCount) throw new ApiFeil(404, "Fant ikke den ansatte");
      } else {
        await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
        if (!(await en(db, "select 1 from faktura.ansatte where org_id = $1 and id = $2", [orgId(c), id(c)]))) throw new ApiFeil(404, "Fant ikke den ansatte");
      }
      if (b.tillegg) await lagreTillegg(db, orgId(c), id(c), b.tillegg, true);
      return en(db, `${ANSATT} where a.org_id = $1 and a.id = $2`, [orgId(c), id(c)]);
    });
    if (b.fnr) await hentSkattekortFor(c, [id(c)]);
    return c.json(a);
  });

  // --- Lønns- og stillingsendringer (0080_lonnsendringer.sql) ------------------
  // Historikken (nyeste først, også de som gjelder fram i tid), en ny endring fra en dato, og
  // sletting av en endring. Feltene på den ansatte er det som gjelder i dag.
  const LONNSENDRING = `
    select r.id, to_char(r.gjelder_fra, 'YYYY-MM-DD') as gjelder_fra, r.lonnstype, r.maanedslonn::float8 as maanedslonn, r.timelonn::float8 as timelonn,
           r.stillingsprosent::float8 as stillingsprosent, r.grunn, r.opprettet,
           (select coalesce(u.navn, u.epost) from faktura.brukere u where u.id = r.opprettet_av) as opprettet_av,
           r.gjelder_fra = (select min(x.gjelder_fra) from faktura.lonnsendringer x where x.org_id = r.org_id and x.ansatt_id = r.ansatt_id and x.slettet is null) as forste
      from faktura.lonnsendringer r`;
  const endringer = (db: Db, org: string, ansatt: string) =>
    alle(db, `${LONNSENDRING} where r.org_id = $1 and r.ansatt_id = $2 and r.slettet is null order by r.gjelder_fra desc`, [org, ansatt]);

  r.get("/ansatte/:id/lonnsendringer", async (c) => c.json(await bruk(c, (db) => endringer(db, orgId(c), id(c)))));

  r.post("/ansatte/:id/lonnsendringer", async (c) => {
    const b = z
      .object({
        gjelder_fra: z.string({ error: "Velg datoen endringen gjelder fra" }).regex(/^\d{4}-\d{2}-\d{2}$/, "Ugyldig dato"),
        lonnstype: z.enum(["maaned", "time"]).nullish(),
        maanedslonn: z.number().min(0, "Lønnen kan ikke være negativ").max(10_000_000).nullish(),
        timelonn: z.number().min(0, "Lønnen kan ikke være negativ").max(100_000).nullish(),
        stillingsprosent: z.number().gt(0, "Stillingsprosenten må være over 0").max(100, "Stillingsprosenten kan være høyst 100").nullish(),
        grunn: z.string().trim().max(300).nullish(),
      })
      .parse(await c.req.json().catch(() => ({})));
    if (b.lonnstype == null && b.maanedslonn == null && b.timelonn == null && b.stillingsprosent == null) throw new ApiFeil(400, "Skriv hva som endres");
    return c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.ny_lonnsendring($1, $2, $3, $4, $5, $6, $7)", [
          id(c),
          b.gjelder_fra,
          b.lonnstype ?? null,
          b.maanedslonn ?? null,
          b.timelonn ?? null,
          b.stillingsprosent ?? null,
          b.grunn || null,
        ]);
        return { endringer: await endringer(db, orgId(c), id(c)), ansatt: await en(db, `${ANSATT} where a.org_id = $1 and a.id = $2`, [orgId(c), id(c)]) };
      }),
      201,
    );
  });

  r.delete("/ansatte/:id/lonnsendringer/:endring", async (c) => {
    const endring = uuid.parse(c.req.param("endring"));
    return c.json(
      await bruk(c, async (db) => {
        const e = await en(db, "select 1 from faktura.lonnsendringer where org_id = $1 and ansatt_id = $2 and id = $3", [orgId(c), id(c), endring]);
        if (!e) throw new ApiFeil(404, "Fant ikke endringen");
        await db.query("select faktura.slett_lonnsendring($1)", [endring]);
        return { endringer: await endringer(db, orgId(c), id(c)), ansatt: await en(db, `${ANSATT} where a.org_id = $1 and a.id = $2`, [orgId(c), id(c)]) };
      }),
    );
  });

  // --- Import fra andre systemer ------------------------------------------------
  // Som for kunder og produkter (api.ts): radene er lest og koblet i nettleseren. «proving» gir
  // bare planen (nye, oppdateres, hoppes over, feil); ellers lagres de gyldige radene samlet,
  // med de faste tilleggene. Fødselsnumrene krypteres før transaksjonen (Cloud KMS, noen om
  // gangen), og planen lages på nytt i den, så den stemmer med det som finnes da.
  const importSkjema = z.object({
    rader: z.array(z.record(z.string(), z.unknown())).min(1).max(2000, "Høyst 2000 rader om gangen"),
    duplikater: z.enum(["hopp", "oppdater"]).optional(),
    proving: z.boolean().optional(),
  });
  const ansattSjekk = (a: z.infer<typeof ansattSkjema>) => {
    const fodt = a.fnr ? fodselsdato(a.fnr) : a.fodselsdato;
    if (fodt && fodt > iDag()) return "Fødselsdatoen kan ikke være fram i tid";
    if (a.ansatt_til && a.ansatt_til < (a.ansatt_fra ?? iDag())) return "Sluttdatoen er før startdatoen";
    return null;
  };
  const planleggImport = async (db: Db, org: string, b: z.infer<typeof importSkjema>) => {
    await db.query("select faktura.krev($1, 'personal')", [org]);
    const finnes = new Map<string, string>();
    for (const a of await alle<{ id: string; fornavn: string; etternavn: string; epost: string | null }>(
      db,
      "select id, fornavn, etternavn, epost from faktura.ansatte where org_id = $1 order by ansattnummer",
      [org],
    ))
      for (const k of ansattFinnes(a)) if (!finnes.has(k)) finnes.set(k, a.id);
    return planlegg(b.rader, ansattSkjema, ansattnokler, finnes, b.duplikater ?? "hopp", ansattSjekk, { oppslag: ansattOppslag, melding: ansattFeil });
  };

  r.post("/ansatte/importer", async (c) => {
    const b = importSkjema.parse(await c.req.json().catch(() => ({})));
    let plan = await bruk(c, (db) => planleggImport(db, orgId(c), b));
    const medFnr: string[] = []; // de lagrede radene med fødselsnummer (skattekortet hentes)
    if (!b.proving) {
      const lagres = (p: (typeof plan)[number]) => p.status === "ny" || p.status === "oppdater";
      const kryptert = new Map<string, Buffer>();
      const fnr = [...new Set(plan.filter(lagres).map((p) => p.data!.fnr).filter((x): x is string => !!x))];
      for (let i = 0; i < fnr.length; i += 8) await Promise.all(fnr.slice(i, i + 8).map(async (x) => kryptert.set(x, await krypter(x))));
      plan = await bruk(c, async (db) => {
        const plan = await planleggImport(db, orgId(c), b);
        const full = (await regler(db, orgId(c))).full_stilling;
        const roller = new Map<string, string>();
        medFnr.length = 0;
        for (const p of plan.filter(lagres)) {
          try {
            const d = p.data!;
            const alleFelt = await felter(d, kryptert);
            // Rollen i fila (f.eks. «Lege»): den som finnes med det navnet, eller en ny.
            if (d.rolle) alleFelt.gruppe_id = await rolleId(db, orgId(c), d.rolle, roller);
            if (p.status === "ny") {
              const ny = await nyAnsatt(db, orgId(c), alleFelt, full);
              if (d.tillegg?.length) await lagreTillegg(db, orgId(c), ny, d.tillegg, false);
              if (d.fnr) medFnr.push(ny);
              continue;
            }
            if (d.fnr) medFnr.push(p.id!);
            // Tomme felt i fila sletter ikke det som står fra før, og et notat legges til det
            // som står der (med mindre det står der allerede).
            const { notat, ...f } = Object.fromEntries(Object.entries(alleFelt).filter(([, v]) => v !== null && v !== ""));
            const sett = Object.keys(f).map((k, i) => `${k} = $${i + 3}`);
            const verdier = Object.values(f);
            if (notat !== undefined) {
              verdier.push(notat);
              const n = `$${verdier.length + 2}::text`;
              sett.push(`notat = case when coalesce(notat, '') = '' then ${n} when strpos(notat, ${n}) > 0 then notat else notat || E'\\n' || ${n} end`);
            }
            if (sett.length) await db.query(`update faktura.ansatte set ${sett.join(", ")} where org_id = $1 and id = $2`, [orgId(c), p.id, ...verdier]);
            if (d.tillegg?.length) await lagreTillegg(db, orgId(c), p.id!, d.tillegg, false);
          } catch (e) {
            throw new ApiFeil(tilHttp(e).status, `Rad ${p.nr}: ${tilHttp(e).error}`);
          }
        }
        return plan;
      });
      await hentSkattekortFor(c, medFnr);
    }
    const antall = { ny: 0, oppdater: 0, hopp: 0, feil: 0 };
    for (const p of plan) antall[p.status]++;
    return c.json({ antall, rader: plan.map(({ nr, status, grunn }) => ({ nr, status, grunn })) });
  });

  // --- Kunder som rollehavere ----------------------------------------------------
  // Kunder (f.eks. legene på et legekontor, som kontoret fakturerer) hentes inn i registeret med
  // en rolle, uten å skrives inn på nytt (0058_kunder_som_rollehavere.sql): navnet (som det er
  // rettet i appen), e-posten, telefonen og adressen fra kunden. Personen kobles til kunden, så
  // en kunde som er hentet inn, hoppes over neste gang. Finnes personen alt blant de aktive (samme
  // e-post, ellers samme navn; appen viser hvem før det hentes), kobles den til kunden og får
  // rollen i stedet for å legges inn to ganger, og det som mangler av e-post, telefon og adresse,
  // fylles ut fra kunden. Er den koblet til en annen kunde, hoppes kunden over.
  const fraKunderSkjema = z
    .object({
      kunder: z
        .array(z.object({ kunde_id: uuid, fornavn: ansattSkjema.shape.fornavn, etternavn: ansattSkjema.shape.etternavn }))
        .min(1, "Velg minst én kunde")
        .max(500, "Høyst 500 kunder om gangen"),
      // Rollen de får: id-en, eller navnet (den som finnes med det navnet, eller en ny).
      gruppe_id: uuid.optional(),
      rolle: valgfri(tekst(40, "Rollen")),
      ansatt_fra: datoS.optional(), // fra når de er med (standard i dag)
    })
    .refine((b) => b.gruppe_id || b.rolle, "Velg rollen de skal ha");
  type Person = { id: string; fornavn: string; etternavn: string; epost: string | null; kunde_id: string | null; aktiv: boolean };
  const personNavn = (p: { fornavn: string; etternavn: string }) => `${p.fornavn} ${p.etternavn}`.trim().replace(/\s+/g, " ").toLowerCase();

  r.post("/ansatte/fra-kunder", async (c) => {
    const b = fraKunderSkjema.parse(await c.req.json().catch(() => ({})));
    const org = orgId(c);
    const rader = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [org]);
      const gruppe = b.gruppe_id ?? (await rolleId(db, org, b.rolle!));
      await sjekkGruppe(db, org, { gruppe_id: gruppe });
      const kunder = new Map(
        (
          await alle<{ id: string; navn: string; epost: string | null; telefon: string | null; adresse: string | null; postnr: string | null; poststed: string | null }>(
            db,
            "select id, navn, epost, telefon, adresse, postnr, poststed from faktura.kunder where org_id = $1 and id = any($2::uuid[])",
            [org, b.kunder.map((k) => k.kunde_id)],
          )
        ).map((k) => [k.id, k]),
      );
      const personer = await alle<Person>(db, "select id, fornavn, etternavn, epost, kunde_id, aktiv from faktura.ansatte where org_id = $1 order by ansattnummer", [org]);
      const hentet = new Map(personer.filter((p) => p.kunde_id).map((p) => [p.kunde_id!, p]));
      const medEpost = new Map<string, Person>();
      const medNavn = new Map<string, Person>();
      const husk = (p: Person) => {
        if (!p.aktiv) return;
        if (p.epost && !medEpost.has(p.epost.toLowerCase())) medEpost.set(p.epost.toLowerCase(), p);
        if (!medNavn.has(personNavn(p))) medNavn.set(personNavn(p), p);
      };
      personer.forEach(husk);
      const full = (await regler(db, org)).full_stilling;
      const svar: { kunde_id: string; status: "ny" | "koblet" | "hopp"; ansatt_id: string; navn: string; grunn?: string }[] = [];
      for (const v of b.kunder) {
        const k = kunder.get(v.kunde_id);
        if (!k) throw new ApiFeil(404, "Fant ikke kunden");
        const fra = hentet.get(k.id);
        if (fra) {
          svar.push({ kunde_id: k.id, status: "hopp", ansatt_id: fra.id, navn: `${fra.fornavn} ${fra.etternavn}`, grunn: "Hentet inn fra før" });
          continue;
        }
        const epost = k.epost && k.epost.length <= 254 ? k.epost.trim().toLowerCase() : null;
        const treff = (epost ? medEpost.get(epost) : undefined) ?? medNavn.get(personNavn(v));
        if (treff?.kunde_id) {
          const annen = kunder.get(treff.kunde_id)?.navn ?? (await en<{ navn: string }>(db, "select navn from faktura.kunder where org_id = $1 and id = $2", [org, treff.kunde_id]))?.navn;
          svar.push({ kunde_id: k.id, status: "hopp", ansatt_id: treff.id, navn: `${treff.fornavn} ${treff.etternavn}`, grunn: `Koblet til kunden «${annen ?? "en annen kunde"}»` });
          continue;
        }
        // Adressen på én linje, og et norsk postnummer (kunder i utlandet har andre).
        const postnr = k.postnr?.trim() ?? "";
        const kontakt = {
          epost,
          telefon: k.telefon?.trim() || null,
          adresse: k.adresse?.replace(/\s*\n\s*/g, ", ").trim().slice(0, 200) || null,
          postnr: /^\d{4}$/.test(postnr) ? postnr : null,
          poststed: k.poststed?.trim() || null,
        };
        if (treff) {
          // Adressen fylles bare ut når personen ikke har noen (ikke halvveis fra hver).
          await db.query(
            `update faktura.ansatte
                set kunde_id = $3, gruppe_id = $4, epost = coalesce(epost, $5), telefon = coalesce(telefon, $6),
                    adresse = case when adresse is null and postnr is null and poststed is null then $7 else adresse end,
                    postnr = case when adresse is null and postnr is null and poststed is null then $8 else postnr end,
                    poststed = case when adresse is null and postnr is null and poststed is null then $9 else poststed end
              where org_id = $1 and id = $2`,
            [org, treff.id, k.id, gruppe, kontakt.epost, kontakt.telefon, kontakt.adresse, kontakt.postnr, kontakt.poststed],
          );
          treff.kunde_id = k.id;
          hentet.set(k.id, treff);
          svar.push({ kunde_id: k.id, status: "koblet", ansatt_id: treff.id, navn: `${treff.fornavn} ${treff.etternavn}` });
          continue;
        }
        const ny = await nyAnsatt(
          db,
          org,
          { fornavn: v.fornavn, etternavn: v.etternavn, ...kontakt, gruppe_id: gruppe, kunde_id: k.id, ...(b.ansatt_fra ? { ansatt_fra: b.ansatt_fra } : {}) },
          full,
        );
        const p = { id: ny, fornavn: v.fornavn, etternavn: v.etternavn, epost, kunde_id: k.id, aktiv: true };
        husk(p);
        hentet.set(k.id, p);
        svar.push({ kunde_id: k.id, status: "ny", ansatt_id: ny, navn: `${v.fornavn} ${v.etternavn}` });
      }
      return svar;
    });
    const antall = { ny: 0, koblet: 0, hopp: 0 };
    for (const x of rader) antall[x.status]++;
    return c.json({ antall, rader });
  });

  // Bare ansatte uten timer kan slettes; ellers settes en sluttdato (og den ansatte inaktiv).
  r.delete("/ansatte/:id", async (c) => {
    await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      const t = await en<{ n: number }>(db, "select count(*)::int as n from faktura.timeforinger where org_id = $1 and ansatt_id = $2", [orgId(c), id(c)]);
      if (t!.n > 0) throw new ApiFeil(409, `Den ansatte har ${t!.n} ${t!.n === 1 ? "timeføring" : "timeføringer"} og kan ikke slettes. Sett en sluttdato i stedet.`);
      // Lønnsslipper i godkjente kjøringer skal oppbevares; i utkast tas de bort.
      const l = await en<{ n: number }>(
        db,
        "select count(*)::int as n from faktura.lonnsslipper where org_id = $1 and ansatt_id = $2 and not faktura.lonn_utkast(kjoring_id)",
        [orgId(c), id(c)],
      );
      if (l!.n > 0) throw new ApiFeil(409, "Den ansatte har lønnsslipper (som skal oppbevares) og kan ikke slettes. Sett en sluttdato i stedet.");
      await db.query("delete from faktura.lonnsslipper where org_id = $1 and ansatt_id = $2", [orgId(c), id(c)]);
      const res = await db.query("delete from faktura.ansatte where org_id = $1 and id = $2", [orgId(c), id(c)]);
      if (!res.rowCount) throw new ApiFeil(404, "Fant ikke den ansatte");
    });
    return c.body(null, 204);
  });

  // Egen innlogging: invitasjon på e-post (rollen ansatt). Er e-posten alt med i
  // organisasjonen, kobles den med en gang.
  r.post("/ansatte/:id/inviter", async (c) => {
    const svar = await bruk(c, async (db) => {
      const token = (await en<{ t: string | null }>(db, "select faktura.inviter_ansatt($1, $2) as t", [orgId(c), id(c)]))!.t;
      const a = await en<{ fornavn: string; epost: string }>(db, "select fornavn, epost from faktura.ansatte where org_id = $1 and id = $2", [orgId(c), id(c)]);
      const org = await en<{ navn: string }>(db, "select navn from faktura.organisasjoner where id = $1", [orgId(c)]);
      return { token, ansatt: a!, org: org!.navn };
    });
    if (!svar.token) return c.json({ koblet: true, lenke: null, sendt_til: null });
    const lenke = `${config.appUrl}/invitasjon/${svar.token}`;
    await leggIKo({
      type: "epost",
      til: [svar.ansatt.epost],
      emne: `Du er invitert til ${svar.org} i HI4 Faktura`,
      fra_navn: svar.org,
      tekst: [
        `Hei ${svar.ansatt.fornavn},`,
        "",
        `${svar.org} har gitt deg tilgang til HI4 Faktura, der du fører timene dine.`,
        "",
        `Åpne lenken for å logge inn (bruk denne e-postadressen): ${lenke}`,
        "",
        "Lenken gjelder i sju dager.",
      ].join("\n"),
    });
    return c.json({ koblet: false, lenke, sendt_til: svar.ansatt.epost });
  });

  r.delete("/ansatte/:id/tilgang", async (c) => {
    await bruk(c, (db) => db.query("select faktura.fjern_ansatt_tilgang($1, $2)", [orgId(c), id(c)]));
    return c.body(null, 204);
  });

  // --- Timer -------------------------------------------------------------------

  // Føringene i perioden (den ansatte ser bare sine egne), med ukene oppsummert.
  r.get("/timer", async (c) => {
    const q = z
      .object({ fra: datoS, til: datoS, ansatt: uuid.optional(), status: z.enum(["utkast", "levert", "godkjent", "avvist"]).optional() })
      .parse(c.req.query());
    if (q.til < q.fra) throw new ApiFeil(400, "Slutten er før starten");
    return c.json(
      await bruk(c, async (db) => {
        const regel = await regler(db, orgId(c));
        // Hele uker, så overtiden regnes riktig også når perioden starter midt i en uke.
        const fra = uke(q.fra).fra;
        const til = uke(q.til).til;
        const foringer = await alle<Foringsrad>(
          db,
          `${FORING} where t.org_id = $1 and t.dato between $2 and $3 and ($4::uuid is null or t.ansatt_id = $4)
            order by t.dato, t.fra nulls last, t.opprettet`,
          [orgId(c), fra, til, q.ansatt ?? null],
        );
        const avtalt = new Map(
          (
            await alle<{ id: string; avtalt: number }>(
              db,
              "select id, ukentlig_arbeidstid * stillingsprosent / 100 as avtalt from faktura.ansatte where org_id = $1 and id = any($2::uuid[])",
              [orgId(c), [...new Set(foringer.map((f) => f.ansatt_id))]],
            )
          ).map((a) => [a.id, a.avtalt] as const),
        );
        // Vakter den ansatte er borte fra (fravær), er ikke planlagt arbeid.
        const planlagt = new Map<string, number>();
        for (const v of await alle<{ ansatt_id: string; dato: string; timer: number }>(
          db,
          `select v.ansatt_id, v.dato, v.timer from faktura.vakter v
            where v.org_id = $1 and v.dato between $2 and $3 and v.publisert_at is not null and v.ansatt_id = any($4::uuid[])
              and not exists (select 1 from faktura.fravaer f where f.org_id = v.org_id and f.ansatt_id = v.ansatt_id and v.dato between f.fra and f.til and f.prosent is null)`,
          [orgId(c), fra, til, [...avtalt.keys()]],
        )) {
          const k = `${v.ansatt_id}:${uke(v.dato).fra}`;
          planlagt.set(k, Math.round(((planlagt.get(k) ?? 0) + Number(v.timer)) * 100) / 100);
        }
        // Og de faste dagene i arbeidsplanene (dager i planen uten vakt).
        for (const f of (await beregnBemanning(db, orgId(c), fra, til, q.ansatt ?? null)).faste) {
          if (f.fravaer || !avtalt.has(f.ansatt_id) || f.dato < fra || f.dato > til) continue;
          const k = `${f.ansatt_id}:${uke(f.dato).fra}`;
          planlagt.set(k, Math.round(((planlagt.get(k) ?? 0) + f.timer) * 100) / 100);
        }
        let uker = ukesummer(foringer, regel, avtalt, planlagt);
        // Med status: ukene med føringer med den statusen (f.eks. levert, til godkjenning).
        if (q.status) uker = uker.filter((u) => u.antall_status[q.status!] > 0);
        const iPerioden = (d: string) => d >= q.fra && d <= q.til;
        return { regler: regel, foringer: foringer.filter((f) => iPerioden(f.dato) && (!q.status || f.status === q.status)), uker };
      }),
    );
  });

  // Ny føring: for seg selv, eller (personal) for en annen ansatt.
  r.post("/timer", async (c) => {
    const b = foringSkjema.parse(await c.req.json().catch(() => ({})));
    if (!b.fra !== !b.til) throw new ApiFeil(400, "Skriv både fra og til, eller bare antall timer");
    if (!b.fra && !b.timer) throw new ApiFeil(400, "Skriv fra og til, eller antall timer");
    if (b.uten_overtid && b.overtid_prosent) throw new ApiFeil(400, "Timene kan ikke være både overtid og uten overtid");
    if (b.timebank && !b.uten_overtid && !b.overtid_prosent) throw new ApiFeil(400, TIMEBANK_TYPE);
    const f = await bruk(c, async (db) => {
      const ansatt = b.ansatt_id ?? (await meg(db, orgId(c)))?.id;
      if (!ansatt) throw new ApiFeil(400, "Du er ikke registrert som ansatt her. Velg en ansatt.");
      const ny = await en<{ id: string }>(
        db,
        `insert into faktura.timeforinger (org_id, ansatt_id, dato, fra, til, pause_min, timer, overtid_prosent, beskrivelse, vakt_id, uten_overtid, timebank)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
        [
          orgId(c),
          ansatt,
          b.dato,
          b.fra ?? null,
          b.til ?? null,
          b.pause_min ?? 0,
          b.fra ? null : b.timer,
          b.overtid_prosent ?? null,
          b.beskrivelse ?? null,
          b.vakt_id ?? null,
          b.uten_overtid ?? false,
          b.timebank ?? false,
        ],
      );
      return en(db, `${FORING} where t.id = $1`, [ny!.id]);
    });
    return c.json(f, 201);
  });

  r.patch("/timer/:id", async (c) => {
    const b = foringSkjema.omit({ ansatt_id: true, vakt_id: true }).partial().parse(await c.req.json().catch(() => ({})));
    const f = await bruk(c, async (db) => {
      const naa = await en<{ fra: string | null; til: string | null; status: string; overtid_prosent: number | null; uten_overtid: boolean; timebank: boolean }>(
        db,
        "select fra, til, status, overtid_prosent, uten_overtid, timebank from faktura.timeforinger where org_id = $1 and id = $2",
        [orgId(c), id(c)],
      );
      if (!naa) throw new ApiFeil(404, "Fant ikke føringen");
      const felt: Record<string, unknown> = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));
      // Overtid og uten overtid utelukker hverandre: det ene valget tar bort det andre.
      if (felt.uten_overtid && felt.overtid_prosent) throw new ApiFeil(400, "Timene kan ikke være både overtid og uten overtid");
      if (felt.uten_overtid === true) felt.overtid_prosent = null;
      if (felt.overtid_prosent != null) felt.uten_overtid = false;
      // Blir føringen vanlige timer, er den ikke lenger i timebanken.
      const overtid = felt.overtid_prosent !== undefined ? felt.overtid_prosent : naa.overtid_prosent;
      const uten = felt.uten_overtid !== undefined ? felt.uten_overtid : naa.uten_overtid;
      if (!overtid && !uten) {
        if (felt.timebank === true) throw new ApiFeil(400, TIMEBANK_TYPE);
        if (naa.timebank && felt.timebank === undefined) felt.timebank = false;
      }
      // Bare timer: fra og til fjernes. Med fra og til regnes timene ut i databasen.
      if (felt.timer != null && felt.fra === undefined && felt.til === undefined) Object.assign(felt, { fra: null, til: null });
      const fra = felt.fra !== undefined ? felt.fra : naa.fra;
      const til = felt.til !== undefined ? felt.til : naa.til;
      if (!fra !== !til) throw new ApiFeil(400, "Skriv både fra og til, eller bare antall timer");
      if (fra) delete felt.timer;
      else if (felt.timer === null) throw new ApiFeil(400, "Skriv antall timer");
      const navn = Object.keys(felt);
      if (!navn.length) throw new ApiFeil(400, "Ingen felt å endre");
      const res = await db.query(`update faktura.timeforinger set ${navn.map((k, i) => `${k} = $${i + 3}`).join(", ")} where org_id = $1 and id = $2`, [
        orgId(c),
        id(c),
        ...navn.map((k) => felt[k]),
      ]);
      if (!res.rowCount) throw new ApiFeil(409, "Timene er levert og kan ikke endres");
      return en(db, `${FORING} where t.id = $1`, [id(c)]);
    });
    return c.json(f);
  });

  r.delete("/timer/:id", async (c) => {
    await bruk(c, async (db) => {
      const res = await db.query("delete from faktura.timeforinger where org_id = $1 and id = $2", [orgId(c), id(c)]);
      if (!res.rowCount) {
        const finnes = await en<{ status: string }>(db, "select status from faktura.timeforinger where org_id = $1 and id = $2", [orgId(c), id(c)]);
        throw finnes ? new ApiFeil(409, "Timene er levert og kan ikke slettes") : new ApiFeil(404, "Fant ikke føringen");
      }
    });
    return c.body(null, 204);
  });

  // Lever timene i perioden (vanligvis en uke): de som godkjenner, får varsel.
  r.post("/timer/lever", async (c) => {
    const b = z.object({ ansatt_id: uuid.optional(), fra: datoS, til: datoS }).parse(await c.req.json().catch(() => ({})));
    const svar = await bruk(c, async (db) => {
      const ansatt = b.ansatt_id ?? (await meg(db, orgId(c)))?.id;
      if (!ansatt) throw new ApiFeil(400, "Du er ikke registrert som ansatt her");
      const n = (await en<{ n: number }>(db, "select faktura.lever_timer($1, $2, $3, $4) as n", [orgId(c), ansatt, b.fra, b.til]))!.n;
      if (!n) throw new ApiFeil(409, "Ingen timer å levere i perioden");
      const a = await en<{ navn: string; timer: number }>(
        db,
        `select a.fornavn || ' ' || a.etternavn as navn,
                (select coalesce(sum(t.timer), 0) from faktura.timeforinger t
                  where t.org_id = a.org_id and t.ansatt_id = a.id and t.dato between $3 and $4 and t.status = 'levert') as timer
           from faktura.ansatte a where a.org_id = $1 and a.id = $2`,
        [orgId(c), ansatt, b.fra, b.til],
      );
      const u = uke(b.fra);
      const periode = u.fra === b.fra && u.til === b.til ? `uke ${u.uke}` : `${visDato(b.fra)}–${visDato(b.til)}`;
      return { levert: n, varsel: { tittel: `Timer levert: ${a!.navn}`, tekst: `${a!.navn} har levert ${timerTekst(a!.timer)} for ${periode}.` } };
    });
    await varslePersonal(orgId(c), c.get("bruker").id, "timer", svar.varsel.tittel, svar.varsel.tekst, "/timer?fane=godkjenning", `timer-${orgId(c)}`);
    return c.json({ levert: svar.levert });
  });

  // Godkjenn eller avvis (personal): den ansatte får varsel.
  for (const handling of ["godkjenn", "avvis"] as const) {
    r.post(`/timer/${handling}`, async (c) => {
      const b = z
        .object({ ider: z.array(uuid).min(1, "Velg timene").max(1000), grunn: z.string().max(500, "Grunnen kan ha høyst 500 tegn").optional() })
        .parse(await c.req.json().catch(() => ({})));
      const svar = await bruk(c, async (db) => {
        const n =
          handling === "godkjenn"
            ? (await en<{ n: number }>(db, "select faktura.godkjenn_timer($1, $2) as n", [orgId(c), b.ider]))!.n
            : (await en<{ n: number }>(db, "select faktura.avvis_timer($1, $2, $3) as n", [orgId(c), b.ider, b.grunn ?? ""]))!.n;
        // Én melding per ansatt og uke.
        const berort = await alle<{ bruker_id: string | null; dato: string }>(
          db,
          `select a.bruker_id, t.dato from faktura.timeforinger t join faktura.ansatte a on a.org_id = t.org_id and a.id = t.ansatt_id
            where t.org_id = $1 and t.id = any($2::uuid[]) and a.bruker_id is not null and a.bruker_id is distinct from faktura.bruker_id()`,
          [orgId(c), b.ider],
        );
        const meldinger = new Map<string, { bruker: string; uke: number; fra: string }>();
        for (const x of berort) meldinger.set(`${x.bruker_id}:${uke(x.dato).fra}`, { bruker: x.bruker_id!, uke: uke(x.dato).uke, fra: uke(x.dato).fra });
        for (const m of meldinger.values())
          await leggIKo({
            type: "varsel",
            varsel: {
              hendelse: "timer",
              org_id: orgId(c),
              bruker_ider: [m.bruker],
              tittel: handling === "godkjenn" ? `Timene for uke ${m.uke} er godkjent` : `Timene for uke ${m.uke} ble avvist`,
              tekst: handling === "godkjenn" ? "Trykk for å se timene." : `${b.grunn?.trim() ?? ""} Rett dem og lever på nytt.`.trim(),
              url: `/timer?uke=${m.fra}`,
              tag: `timer-${m.bruker}-${m.fra}`,
            },
          });
        return { [handling === "godkjenn" ? "godkjent" : "avvist"]: n };
      });
      return c.json(svar);
    });
  }

  return r;
}
