// Inntektsmeldingen til NAV (0079_nav_sykepenger.sql, navSykepenger.ts, docs/nav.md): skjemaet
// appen tar imot (det NAV vil ha, uten fødselsnummer), forslaget appen lager fra forespørselen,
// fraværet og lønnen, og meldingen slik den sendes (POST /v1/inntektsmelding).
//
// Innholdet følger NAVs format (sykepenger-im-lps-api, domene-inntektsmelding): arbeidsgiver-
// perioden (16 dager, eller kortere med begrunnelse når arbeidsgiveren ikke betaler hele),
// månedsinntekten (snittet av de tre siste kalendermånedene før inntektsdatoen, folketrygdloven
// § 8-28; avviker den mer enn 1000 kr fra a-ordningen, må det være en endringsårsak), refusjonen
// (når arbeidsgiveren betaler lønnen under sykdommen, med endringer og stopp som beløp fra en
// dato), og naturalytelser som faller bort. Kravet om refusjon er en del av inntektsmeldingen.
import { z } from "zod";
import { alle, en, type Db } from "./db.js";
import { AGP_DAGER, OPPTJENING_DAGER, grunnbelop, pluss, rund } from "./lonnsberegning.js";

// --- Kodene ---------------------------------------------------------------------------------

// Begrunnelsen når arbeidsgiveren ikke betaler (hele) arbeidsgiverperioden.
export const BEGRUNNELSER: Record<string, string> = {
  ManglerOpptjening: "Ikke fire uker i jobben før fraværet (mangler opptjening)",
  ArbeidOpphoert: "Arbeidsforholdet er avsluttet",
  BeskjedGittForSent: "Beskjed om fraværet ble gitt for sent",
  BetvilerArbeidsufoerhet: "Arbeidsgiveren betviler at den ansatte er arbeidsufør",
  FerieEllerAvspasering: "Ferie eller avspasering i perioden",
  FiskerMedHyre: "Fisker med hyre",
  FravaerUtenGyldigGrunn: "Fravær uten gyldig grunn",
  IkkeFravaer: "Ikke fravær (har jobbet)",
  IkkeFullStillingsandel: "Ikke full stillingsandel i perioden",
  IkkeLoenn: "Ikke lønn i perioden",
  LovligFravaer: "Lovlig fravær uten lønn",
  Permittering: "Permittering",
  Saerregler: "Særregler",
  StreikEllerLockout: "Streik eller lockout",
  TidligereVirksomhet: "En tidligere arbeidsgiver har betalt arbeidsgiverperioden",
};

// Naturalytelser som faller bort under sykdommen (verdien per måned, og datoen de faller bort fra).
export const NATURALYTELSER: Record<string, string> = {
  BIL: "Bil",
  BOLIG: "Bolig",
  ELEKTRONISKKOMMUNIKASJON: "Elektronisk kommunikasjon (telefon, internett)",
  FRITRANSPORT: "Fri transport",
  KOSTDAGER: "Kostdager",
  KOSTDOEGN: "Kostdøgn",
  KOSTBESPARELSEIHJEMMET: "Kostbesparelse i hjemmet",
  LOSJI: "Losji",
  BEDRIFTSBARNEHAGEPLASS: "Bedriftsbarnehageplass",
  TILSKUDDBARNEHAGEPLASS: "Tilskudd til barnehageplass",
  RENTEFORDELLAAN: "Rentefordel lån",
  SKATTEPLIKTIGDELFORSIKRINGER: "Skattepliktig del av forsikringer",
  AKSJERGRUNNFONDSBEVISTILUNDERKURS: "Aksjer og grunnfondsbevis til underkurs",
  OPSJONER: "Opsjoner",
  BESOEKSREISERHJEMMETANNET: "Besøksreiser til hjemmet, annet",
  INNBETALINGTILUTENLANDSKPENSJONSORDNING: "Innbetaling til utenlandsk pensjonsordning",
  YRKEBILTJENESTLIGBEHOVKILOMETER: "Yrkesbil etter tjenstlig behov (kilometer)",
  YRKEBILTJENESTLIGBEHOVLISTEPRIS: "Yrkesbil etter tjenstlig behov (listepris)",
  ANNET: "Annet",
};

// Årsaken når inntekten ikke er snittet av de tre månedene (med det NAV vil vite om den).
export const ENDRINGSAARSAKER: Record<string, { navn: string; felt: "ingen" | "gjelderFra" | "tariff" | "ferier" | "permisjoner" | "permitteringer" | "sykefravaer" }> = {
  VarigLoennsendring: { navn: "Varig lønnsendring", felt: "gjelderFra" },
  NyStillingsprosent: { navn: "Ny stillingsprosent", felt: "gjelderFra" },
  NyStilling: { navn: "Ny stilling", felt: "gjelderFra" },
  Nyansatt: { navn: "Nyansatt", felt: "ingen" },
  Ferie: { navn: "Ferie", felt: "ferier" },
  Ferietrekk: { navn: "Ferietrekk eller utbetaling av feriepenger", felt: "ingen" },
  Permisjon: { navn: "Permisjon", felt: "permisjoner" },
  Permittering: { navn: "Permittering", felt: "permitteringer" },
  Sykefravaer: { navn: "Sykefravær", felt: "sykefravaer" },
  Bonus: { navn: "Bonus", felt: "ingen" },
  Tariffendring: { navn: "Tariffendring", felt: "tariff" },
  Feilregistrert: { navn: "Feil i a-meldingen", felt: "ingen" },
};

// --- Skjemaet -------------------------------------------------------------------------------

const datoS = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ugyldig dato");
const periode = z.object({ fom: datoS, tom: datoS }).refine((p) => p.fom <= p.tom, "Fra-datoen er etter til-datoen");
const perioder = z.array(periode).min(1, "Legg inn minst én periode").max(30);
const belop = z.number({ error: "Skriv beløpet" }).min(0, "Beløpet kan ikke være negativt").lt(1_000_000, "Beløpet må være under 1 000 000 kr");
const koder = (r: Record<string, unknown>) => Object.keys(r) as [string, ...string[]];

const endringsaarsak = z.discriminatedUnion(
  "aarsak",
  [
    z.object({ aarsak: z.literal("Bonus") }),
    z.object({ aarsak: z.literal("Feilregistrert") }),
    z.object({ aarsak: z.literal("Ferie"), ferier: perioder }),
    z.object({ aarsak: z.literal("Ferietrekk") }),
    z.object({ aarsak: z.literal("Nyansatt") }),
    z.object({ aarsak: z.literal("NyStilling"), gjelderFra: datoS }),
    z.object({ aarsak: z.literal("NyStillingsprosent"), gjelderFra: datoS }),
    z.object({ aarsak: z.literal("Permisjon"), permisjoner: perioder }),
    z.object({ aarsak: z.literal("Permittering"), permitteringer: perioder }),
    z.object({ aarsak: z.literal("Sykefravaer"), sykefravaer: perioder }),
    z.object({ aarsak: z.literal("Tariffendring"), gjelderFra: datoS, bleKjent: datoS }),
    z.object({ aarsak: z.literal("VarigLoennsendring"), gjelderFra: datoS }),
  ],
  { error: "Ukjent endringsårsak" },
);

// Fritekst NAV godtar (navnet på kontaktpersonen): bokstaver, tall, punktum, komma, mellomrom,
// understrek og bindestrek, 2–64 tegn.
export const FRITEKST = /^[.A-Za-zæøåÆØÅ0-9, _-]{2,64}$/;
export const TELEFON = /^(\d{8,15}|00\d{10,17}|\+\d{10,17})$/;

export const inntektsmeldingSkjema = z
  .object({
    agp: z
      .object({
        perioder: z.array(periode).max(30),
        redusertLoennIAgp: z.object({ beloep: belop, begrunnelse: z.enum(koder(BEGRUNNELSER), { error: "Velg begrunnelsen" }) }).nullable(),
      })
      .nullable(),
    inntekt: z
      .object({
        beloep: belop,
        inntektsdato: datoS,
        endringAarsaker: z.array(endringsaarsak).max(12),
      })
      .nullable(),
    refusjon: z
      .object({
        beloepPerMaaned: belop,
        endringer: z.array(z.object({ beloep: belop, startdato: datoS })).max(24),
      })
      .nullable(),
    naturalytelser: z
      .array(
        z.object({
          naturalytelse: z.enum(koder(NATURALYTELSER), { error: "Velg naturalytelsen" }),
          verdiBeloep: z.number({ error: "Skriv verdien" }).gt(0, "Verdien må være over 0").lt(1_000_000, "Verdien må være under 1 000 000 kr"),
          sluttdato: datoS,
        }),
      )
      .max(20),
    kontaktinformasjon: z
      .string()
      .trim()
      .regex(FRITEKST, "Navnet på kontaktpersonen kan ha bokstaver, tall, punktum, komma og bindestrek (2–64 tegn)"),
    arbeidsgiverTlf: z
      .string({ error: "Skriv telefonnummeret" })
      .transform((v) => v.replace(/[\s-]/g, ""))
      .pipe(z.string().regex(TELEFON, "Telefonnummeret må ha 8 til 15 sifre (eller starte med + eller 00)")),
  })
  .superRefine((im, ctx) => {
    const feil = (melding: string, sti: (string | number)[]) => ctx.addIssue({ code: "custom", message: melding, path: sti });
    const agpDager = im.agp ? antallDager(im.agp.perioder) : 0;
    const agpSlutt = im.agp?.perioder.map((p) => p.tom).sort().at(-1) ?? null;
    if (im.agp) {
      if (agpDager > AGP_DAGER) feil(`Arbeidsgiverperioden er høyst ${AGP_DAGER} dager (nå ${agpDager}).`, ["agp", "perioder"]);
      if (agpDager < AGP_DAGER && !im.agp.redusertLoennIAgp)
        feil(`Arbeidsgiverperioden er kortere enn ${AGP_DAGER} dager: oppgi hva som er betalt og hvorfor.`, ["agp", "redusertLoennIAgp"]);
      if (overlapper(im.agp.perioder)) feil("Periodene i arbeidsgiverperioden overlapper.", ["agp", "perioder"]);
    }
    if (im.inntekt) {
      const sett = new Set(im.inntekt.endringAarsaker.map((a) => JSON.stringify(a)));
      if (sett.size < im.inntekt.endringAarsaker.length) feil("Den samme endringsårsaken står to ganger.", ["inntekt", "endringAarsaker"]);
    }
    if (im.refusjon) {
      const inntekt = im.inntekt?.beloep;
      if (inntekt != null && inntekt > 0) {
        if (im.refusjon.beloepPerMaaned > inntekt) feil("Refusjonen kan ikke være større enn månedsinntekten.", ["refusjon", "beloepPerMaaned"]);
        if (im.refusjon.endringer.some((e) => e.beloep > inntekt)) feil("En endring i refusjonen er større enn månedsinntekten.", ["refusjon", "endringer"]);
      }
      for (const e of im.refusjon.endringer) {
        if (im.inntekt && e.startdato <= im.inntekt.inntektsdato) feil("Endringene i refusjonen må gjelde fra etter inntektsdatoen.", ["refusjon", "endringer"]);
        if (agpSlutt && e.startdato <= agpSlutt) feil("Endringene i refusjonen må gjelde fra etter arbeidsgiverperioden.", ["refusjon", "endringer"]);
      }
    }
  });
export type Inntektsmelding = z.infer<typeof inntektsmeldingSkjema>;

// Det NAV ber om i forespørselen (data i nav_forespoersler, fra navSykepenger.ts).
export type Forespoerselsdata = {
  sykmeldingsperioder?: { fom: string; tom: string }[];
  egenmeldingsperioder?: { fom: string; tom: string }[];
  inntektsdato?: string | null;
  arbeidsgiverperiodePaakrevd?: boolean;
  inntektPaakrevd?: boolean;
  opprettetTid?: string | null;
  // Inntekten i a-ordningen de tre månedene før inntektsdatoen (NAVs /v1/inntekt).
  inntekt?: { inntektsdato: string; perMaaned: Record<string, number | null>; snitt: number } | null;
};

// Det NAV sjekker mot forespørselen før den tar imot inntektsmeldingen.
export function kontrollerMotForespoersel(im: Inntektsmelding, d: Forespoerselsdata): string[] {
  const feil: string[] = [];
  if (d.arbeidsgiverperiodePaakrevd && !im.agp) feil.push("NAV ber om arbeidsgiverperioden.");
  if (d.inntektPaakrevd && !im.inntekt) feil.push("NAV ber om inntekten.");
  if (d.inntektPaakrevd === false && im.inntekt) feil.push("NAV ber ikke om inntekten denne gangen (den er gitt før). Ta den bort.");
  return feil;
}

// --- Datoene --------------------------------------------------------------------------------

const dagerMellom = (fra: string, til: string) => Math.round((Date.parse(`${til}T12:00:00Z`) - Date.parse(`${fra}T12:00:00Z`)) / 86_400_000);
export const antallDager = (p: { fom: string; tom: string }[]) => p.reduce((s, x) => s + dagerMellom(x.fom, x.tom) + 1, 0);
const overlapper = (p: { fom: string; tom: string }[]) => {
  const s = [...p].sort((a, b) => a.fom.localeCompare(b.fom));
  return s.some((x, i) => i > 0 && x.fom <= s[i - 1]!.tom);
};

// Sammenhengende dager som perioder.
export function tilPerioder(dager: string[]): { fom: string; tom: string }[] {
  const s = [...new Set(dager)].sort();
  const ut: { fom: string; tom: string }[] = [];
  for (const d of s) {
    const siste = ut.at(-1);
    if (siste && pluss(siste.tom, 1) === d) siste.tom = d;
    else ut.push({ fom: d, tom: d });
  }
  return ut;
}

// Arbeidsgiverperioden: de første 16 kalenderdagene med fravær i sykefraværstilfellet (et nytt
// fravær innen 16 dager etter det forrige hører til det samme; ellers begynner et nytt). Gir
// periodene i det siste tilfellet.
export function arbeidsgiverperioden(fravaer: { fom: string; tom: string }[]): { fom: string; tom: string }[] {
  const p = [...fravaer].sort((a, b) => a.fom.localeCompare(b.fom));
  let dager: string[] = [];
  let slutt: string | null = null;
  for (const x of p) {
    if (slutt && dagerMellom(slutt, x.fom) - 1 > AGP_DAGER) dager = [];
    const start = slutt && x.fom <= slutt ? pluss(slutt, 1) : x.fom;
    for (let d = start; d <= x.tom && dager.length < AGP_DAGER; d = pluss(d, 1)) dager.push(d);
    if (!slutt || x.tom > slutt) slutt = x.tom;
  }
  return tilPerioder(dager);
}

// De tre kalendermånedene før inntektsdatoen («2026-06», «2026-07», «2026-08» for 2026-09-14).
export function inntektsmaaneder(inntektsdato: string): string[] {
  const aar = Number(inntektsdato.slice(0, 4));
  const mnd = Number(inntektsdato.slice(5, 7));
  return [3, 2, 1].map((n) => {
    const d = new Date(Date.UTC(aar, mnd - 1 - n, 1));
    return d.toISOString().slice(0, 7);
  });
}

// Lønnsartene som er med i månedsinntekten (§ 8-28): den faste og vanlige lønnen, ikke overtid,
// bonus og feriepenger.
export const INNTEKT_LONNSARTER = [
  "fastlonn",
  "timelonn",
  "merarbeid",
  "ekstratimer",
  "avspasering",
  "timebank",
  "permisjon",
  "fast_tillegg",
  "uregelmessig_tillegg",
  "etterbetaling",
  "sykepenger",
  "sykepenger_nav",
  "omsorgspenger",
  "trekk_permisjon",
  "trekk_sykdom",
];

// Navnet slik NAV godtar det (uten tegn utenfor FRITEKST), eller null.
export function fritekst(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s
    .normalize("NFD")
    .replace(/[\u0300-\u0309\u030b-\u036f]/g, "") // aksentene bort, men ringen i å blir
    .normalize("NFC")
    .replace(/[^.A-Za-zæøåÆØÅ0-9, _-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64)
    .trim();
  return FRITEKST.test(t) ? t : null;
}

// --- Forslaget ------------------------------------------------------------------------------

export type Forslag = {
  aarsak: "Ny" | "Endring" | null;
  innhold: Inntektsmelding;
  grunnlag: {
    fravaer: { fom: string; tom: string; kilde: "nav" | "appen" }[];
    agp_dager: number;
    maaneder: { maaned: string; lonn: number; nav: number | null }[];
    snitt_lonn: number;
    snitt_nav: number | null;
    maanedslonn: number | null; // fastlønnen nå (med fastlønn)
    seks_g: number; // 6 G per måned: det NAV dekker høyst
    refusjon: boolean; // arbeidsgiveren betaler lønnen under sykdommen (oppsettet)
    endringsaarsaker: { aarsak: string; tekst: string; forslag: Record<string, unknown> }[];
  };
  merknader: string[];
};

type Foresporsel = { id: string; ansatt_id: string | null; status: string; data: Forespoerselsdata };

// Inntektsmeldingen appen foreslår for forespørselen: arbeidsgiverperioden fra periodene NAV har
// og fraværet i appen, månedsinntekten (snittet i a-ordningen hos NAV, ellers fra lønnskjøringene),
// refusjonen når arbeidsgiveren betaler lønnen under sykdommen, og kontaktpersonen. Er
// forespørselen besvart, er forslaget det som sist ble godkjent (en korrigering sender alt på nytt).
export async function forslagTilInntektsmelding(db: Db, org: string, f: Foresporsel): Promise<Forslag> {
  const d = f.data ?? {};
  const merknader: string[] = [];
  const aarsak = f.status === "AKTIV" ? "Ny" : f.status === "BESVART" ? "Endring" : null;
  const a = await en<{
    ansatt_fra: string;
    ansatt_til: string | null;
    lonnstype: string;
    maanedslonn: number | null;
    siste_lonnsendring: string | null;
    siste_stillingsendring: string | null;
  }>(
    db,
    `select to_char(ansatt_fra, 'YYYY-MM-DD') as ansatt_fra, to_char(ansatt_til, 'YYYY-MM-DD') as ansatt_til, lonnstype, maanedslonn::float8 as maanedslonn,
            to_char(siste_lonnsendring, 'YYYY-MM-DD') as siste_lonnsendring, to_char(siste_stillingsendring, 'YYYY-MM-DD') as siste_stillingsendring
       from faktura.ansatte where org_id = $1 and id = $2`,
    [org, f.ansatt_id],
  );
  const oppsett = await en<{ sykepenger_refusjon: boolean; telefon: string | null }>(
    db,
    `select coalesce((select sykepenger_refusjon from faktura.lonn_oppsett where org_id = $1), true) as sykepenger_refusjon,
            (select telefon from faktura.organisasjoner where id = $1) as telefon`,
    [org],
  );
  const kontakt = await en<{ navn: string | null; kontaktinformasjon: string | null; arbeidsgiverTlf: string | null }>(
    db,
    `select (select coalesce(navn, split_part(epost, '@', 1)) from faktura.brukere where id = faktura.bruker_id()) as navn,
            m.innhold->>'kontaktinformasjon' as "kontaktinformasjon", m.innhold->>'arbeidsgiverTlf' as "arbeidsgiverTlf"
       from (select 1) x left join lateral (
         select innhold from faktura.nav_inntektsmeldinger where org_id = $1 order by opprettet desc limit 1
       ) m on true`,
    [org],
  );
  const sist = await en<{ innhold: Inntektsmelding }>(
    db,
    "select innhold from faktura.nav_inntektsmeldinger where org_id = $1 and forespoersel_id = $2 and status = 'godkjent' order by opprettet desc limit 1",
    [org, f.id],
  );

  // Fraværet: periodene NAV har, og sykefraværet i appen som henger sammen med dem.
  const navPerioder = [...(d.egenmeldingsperioder ?? []), ...(d.sykmeldingsperioder ?? [])].filter((p) => p?.fom && p?.tom);
  const forste = navPerioder.map((p) => p.fom).sort()[0] ?? d.inntektsdato ?? null;
  const siste = navPerioder.map((p) => p.tom).sort().at(-1) ?? forste;
  const egne = forste
    ? await alle<{ fom: string; tom: string }>(
        db,
        `select to_char(fra, 'YYYY-MM-DD') as fom, to_char(til, 'YYYY-MM-DD') as tom from faktura.fravaer
          where org_id = $1 and ansatt_id = $2 and type = 'syk' and til >= $3::date - 17 and fra <= $4 order by fra`,
        [org, f.ansatt_id, forste, siste],
      )
    : [];
  // Bare det som henger sammen med NAVs perioder (innen 16 dager før).
  const med: { fom: string; tom: string }[] = [];
  let start = forste;
  for (const e of [...egne].sort((x, y) => y.tom.localeCompare(x.tom))) {
    if (start && e.fom < start && dagerMellom(e.tom, start) - 1 <= AGP_DAGER) {
      med.push(e);
      start = e.fom;
    }
  }
  const fravaer = [
    ...navPerioder.map((p) => ({ fom: p.fom, tom: p.tom, kilde: "nav" as const })),
    ...med.filter((e) => !navPerioder.some((p) => p.fom <= e.fom && p.tom >= e.tom)).map((e) => ({ ...e, kilde: "appen" as const })),
  ].sort((x, y) => x.fom.localeCompare(y.fom));
  const agpPerioder = arbeidsgiverperioden(fravaer);
  const agpDager = antallDager(agpPerioder);
  const agpSlutt = agpPerioder.at(-1)?.tom ?? null;
  if (fravaer.some((p) => p.kilde === "appen") && agpPerioder.some((p) => p.fom < (navPerioder.map((x) => x.fom).sort()[0] ?? "9"))) {
    merknader.push("Arbeidsgiverperioden begynner med sykefravær som er registrert i appen før periodene NAV har (f.eks. egenmelding). Sjekk at det stemmer.");
  }

  // Inntekten: de tre månedene før inntektsdatoen.
  const inntektsdato = d.inntektsdato ?? agpPerioder[0]?.fom ?? forste ?? new Date().toISOString().slice(0, 10);
  const maaneder = inntektsmaaneder(inntektsdato);
  const lonn = await alle<{ maaned: string; belop: number }>(
    db,
    `select to_char(k.utbetalingsdato, 'YYYY-MM') as maaned, sum(l.belop)::float8 as belop
       from faktura.lonnslinjer l join faktura.lonnsslipper s on s.id = l.slipp_id join faktura.lonnskjoringer k on k.id = s.kjoring_id
      where k.org_id = $1 and s.ansatt_id = $2 and k.status = 'godkjent' and not l.fjernet and l.lonnsart = any($3)
        and to_char(k.utbetalingsdato, 'YYYY-MM') = any($4)
      group by 1`,
    [org, f.ansatt_id, INNTEKT_LONNSARTER, maaneder],
  );
  const nav = d.inntekt && d.inntekt.inntektsdato === inntektsdato ? d.inntekt : null;
  const rader = maaneder.map((m) => ({ maaned: m, lonn: rund(lonn.find((x) => x.maaned === m)?.belop ?? 0), nav: nav ? Number(nav.perMaaned?.[m] ?? 0) : null }));
  const snittLonn = rund(rader.reduce((s, r) => s + r.lonn, 0) / 3);
  const snittNav = nav ? rund(Number(nav.snitt)) : null;
  if (snittNav != null && Math.abs(snittNav - snittLonn) > 1000)
    merknader.push(
      `Snittet fra lønnskjøringene i appen (${kr(snittLonn)}) avviker fra a-ordningen hos NAV (${kr(snittNav)}). NAV sammenligner med a-ordningen; avviker inntekten mer enn 1 000 kr fra den, må det være en endringsårsak.`,
    );
  if (snittNav == null && d.inntektPaakrevd) merknader.push("Inntekten i a-ordningen er ikke hentet fra NAV ennå; forslaget er snittet fra lønnskjøringene i appen.");

  // Endringsårsaker appen ser: lønns- og stillingsendring, nyansatt, ferie og sykefravær i månedene.
  const fraMnd = `${maaneder[0]}-01`;
  const endringsaarsaker: Forslag["grunnlag"]["endringsaarsaker"] = [];
  if (a?.siste_lonnsendring && a.siste_lonnsendring >= fraMnd && a.siste_lonnsendring <= inntektsdato)
    endringsaarsaker.push({ aarsak: "VarigLoennsendring", tekst: `Lønnen ble endret ${visDato(a.siste_lonnsendring)}.`, forslag: { aarsak: "VarigLoennsendring", gjelderFra: a.siste_lonnsendring } });
  if (a?.siste_stillingsendring && a.siste_stillingsendring >= fraMnd && a.siste_stillingsendring <= inntektsdato)
    endringsaarsaker.push({
      aarsak: "NyStillingsprosent",
      tekst: `Stillingsprosenten ble endret ${visDato(a.siste_stillingsendring)}.`,
      forslag: { aarsak: "NyStillingsprosent", gjelderFra: a.siste_stillingsendring },
    });
  if (a && a.ansatt_fra > fraMnd) endringsaarsaker.push({ aarsak: "Nyansatt", tekst: `Ansatt fra ${visDato(a.ansatt_fra)}, så ikke alle månedene har full lønn.`, forslag: { aarsak: "Nyansatt" } });
  const iMnd = await alle<{ type: string; fom: string; tom: string; betalt: boolean }>(
    db,
    `select type, to_char(greatest(fra, $3::date), 'YYYY-MM-DD') as fom, to_char(least(til, $4::date), 'YYYY-MM-DD') as tom, betalt
       from faktura.fravaer where org_id = $1 and ansatt_id = $2 and type in ('ferie', 'syk', 'permisjon') and til >= $3 and fra <= $4 order by fra`,
    [org, f.ansatt_id, fraMnd, pluss(inntektsdato, -1)],
  );
  const ferier = iMnd.filter((x) => x.type === "ferie").map(({ fom, tom }) => ({ fom, tom }));
  if (ferier.length) endringsaarsaker.push({ aarsak: "Ferie", tekst: "Ferie i månedene (med ferietrekk kan lønnen ha vært lavere).", forslag: { aarsak: "Ferie", ferier } });
  const syke = iMnd.filter((x) => x.type === "syk" && x.tom < (agpPerioder[0]?.fom ?? inntektsdato)).map(({ fom, tom }) => ({ fom, tom }));
  if (syke.length) endringsaarsaker.push({ aarsak: "Sykefravaer", tekst: "Sykefravær i månedene.", forslag: { aarsak: "Sykefravaer", sykefravaer: syke } });
  const permisjoner = iMnd.filter((x) => x.type === "permisjon" && !x.betalt).map(({ fom, tom }) => ({ fom, tom }));
  if (permisjoner.length) endringsaarsaker.push({ aarsak: "Permisjon", tekst: "Permisjon uten lønn i månedene.", forslag: { aarsak: "Permisjon", permisjoner } });

  // Refusjonen: når arbeidsgiveren betaler lønnen under sykdommen, hele månedsinntekten (NAV
  // dekker høyst 6 G); den stopper når den ansatte slutter.
  const seksG = rund((grunnbelop(inntektsdato) * 6) / 12);
  const inntekt = snittNav ?? snittLonn;
  const refusjon = Boolean(oppsett?.sykepenger_refusjon);
  const endringer: { beloep: number; startdato: string }[] = [];
  if (a?.ansatt_til) {
    const stopp = pluss(a.ansatt_til, 1);
    if (stopp > inntektsdato && (!agpSlutt || stopp > agpSlutt)) endringer.push({ beloep: 0, startdato: stopp });
  }
  if (refusjon && inntekt > seksG)
    merknader.push(`Inntekten er over 6 G (${kr(seksG)} i måneden). NAV refunderer høyst sykepenger av 6 G; resten av lønnen under sykdommen betaler arbeidsgiveren selv.`);

  // Arbeidsgiverperioden og om den er betalt: uten fire uker i jobben betaler ikke arbeidsgiveren.
  const utenOpptjening = !!(a && agpPerioder[0] && dagerMellom(a.ansatt_fra, agpPerioder[0].fom) < OPPTJENING_DAGER);
  if (utenOpptjening) merknader.push("Den ansatte hadde ikke vært ansatt i fire uker da fraværet begynte: arbeidsgiveren betaler ikke arbeidsgiverperioden (NAV gjør det).");
  if (d.arbeidsgiverperiodePaakrevd && agpDager < AGP_DAGER && !utenOpptjening)
    merknader.push(`Fraværet appen og NAV kjenner, gir bare ${agpDager} dager i arbeidsgiverperioden. Er den kortere enn 16 dager, oppgi hva som er betalt og hvorfor.`);

  const telefon = (kontakt?.arbeidsgiverTlf ?? oppsett?.telefon ?? "").replace(/[\s-]/g, "");
  const nytt: Inntektsmelding = {
    agp: d.arbeidsgiverperiodePaakrevd
      ? {
          perioder: agpPerioder,
          redusertLoennIAgp: utenOpptjening ? { beloep: 0, begrunnelse: "ManglerOpptjening" } : null,
        }
      : null,
    inntekt: d.inntektPaakrevd === false ? null : { beloep: inntekt, inntektsdato, endringAarsaker: [] },
    refusjon: refusjon ? { beloepPerMaaned: inntekt, endringer } : null,
    naturalytelser: [],
    kontaktinformasjon: fritekst(kontakt?.kontaktinformasjon) ?? fritekst(kontakt?.navn) ?? "",
    arbeidsgiverTlf: TELEFON.test(telefon) ? telefon : "",
  };
  return {
    aarsak,
    innhold: aarsak === "Endring" && sist ? sist.innhold : nytt,
    grunnlag: {
      fravaer,
      agp_dager: agpDager,
      maaneder: rader,
      snitt_lonn: snittLonn,
      snitt_nav: snittNav,
      maanedslonn: a?.lonnstype === "maaned" ? Number(a.maanedslonn ?? 0) || null : null,
      seks_g: seksG,
      refusjon,
      endringsaarsaker,
    },
    merknader,
  };
}

const visDato = (d: string) => d.split("-").reverse().join(".");
const kr = (n: number) => `${n.toLocaleString("nb-NO", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/[\u00a0\u202f]/g, " ")} kr`;

// --- Meldingen til NAV ----------------------------------------------------------------------

// Inntektsmeldingen slik NAV vil ha den: alle nøklene (agp, inntekt og refusjon kan være null) og
// ingen andre.
export function tilNav(im: Inntektsmelding, navReferanseId: string, fnr: string, aarsak: "Ny" | "Endring", avsender: { systemNavn: string; systemVersjon: string }) {
  return {
    navReferanseId,
    agp: im.agp ? { perioder: im.agp.perioder.map(({ fom, tom }) => ({ fom, tom })), redusertLoennIAgp: im.agp.redusertLoennIAgp } : null,
    inntekt: im.inntekt ? { beloep: im.inntekt.beloep, inntektsdato: im.inntekt.inntektsdato, endringAarsaker: im.inntekt.endringAarsaker } : null,
    refusjon: im.refusjon ? { beloepPerMaaned: im.refusjon.beloepPerMaaned, endringer: im.refusjon.endringer.map(({ beloep, startdato }) => ({ beloep, startdato })) } : null,
    naturalytelser: im.naturalytelser.map(({ naturalytelse, verdiBeloep, sluttdato }) => ({ naturalytelse, verdiBeloep, sluttdato })),
    sykmeldtFnr: fnr,
    aarsakInnsending: aarsak,
    kontaktinformasjon: im.kontaktinformasjon,
    arbeidsgiverTlf: im.arbeidsgiverTlf,
    avsender,
  };
}
