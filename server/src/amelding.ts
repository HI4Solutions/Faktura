// A-meldingen (0077_amelding.sql): den månedlige rapporteringen til a-ordningen, format 2.3.
// Grunnlaget for en måned er de godkjente lønnskjøringene med utbetaling i måneden (lønnen etter
// beskrivelsen i a-meldingen, forskuddstrekket og arbeidsgiveravgiften) og arbeidsforholdene som er
// aktive i den (også uten utbetaling: a-meldingen leveres hver måned så lenge noen er ansatt;
// frilansere, oppdragstakere og styremedlemmer bare i månedene de får honorar, 0096).
//
// byggLeveranse gir meldingen som JSON til Skatteetatens API ({"leveranse": …}; desimaltall som
// tekst, heltall som tall), og tilXml den samme som XML til opplasting på skatteetaten.no
// (<melding><Leveranse>…). Feltene står i rekkefølgen skjemaet krever. Fødselsnumrene leser bare
// workeren; kontroller og oppsummer trenger dem ikke, så appen kan vise grunnlaget og avvikene.
//
// https://github.com/Skatteetaten/api-dokumentasjon (innrapportering-amelding)

import { alle, en, type Db } from "./db.js";
import { lonnsart } from "./lonnsarter.js";
import { otpMedlemskap, pluss, rund, virkedag } from "./lonnsberegning.js";
import { PERMISJONSARTER, permisjonNavn, rapporteres, sluttdatoKjent, type PermisjonsArt } from "./permisjoner.js";

export const NAVNEROM = "urn:ske:fastsetting:innsamling:a-meldingen:v2_3";
export const KILDESYSTEM = "HI4 Faktura";

export type Arbeidsforholdsrad = {
  id: string;
  ansattnummer: number;
  navn: string;
  har_fnr: boolean;
  ansatt_fra: string;
  ansatt_til: string | null;
  stillingsprosent: number;
  ansettelsestype: "fast" | "midlertidig" | "tilkalling";
  yrkeskode: string | null;
  arbeidsforhold_type: string;
  arbeidstidsordning: string;
  aarsak_sluttdato: string | null;
  siste_lonnsendring: string | null;
  siste_stillingsendring: string | null;
  // OTP-medlemskapet (0097): fødselsdatoen, og da den ansatte ble meldt inn og ut hos
  // pensjonsleverandøren.
  fodselsdato?: string | null;
  otp_innmeldt?: string | null;
  otp_utmeldt?: string | null;
};
export type Slippdata = {
  ansatt_id: string;
  utbetalingsdato: string;
  skattetrekk: number;
  aga: number;
  aga_grunnlag: number;
  aga_sats: number;
  otp: number;
  linjer: { lonnsart: string; belop: number; antall: number | null; opptjent_fra?: string | null; opptjent_til?: string | null; tillegg?: Record<string, unknown> | null }[];
};
// AFP-premien som er betalt i måneden (0098, afpPremier.ts): premien og arbeidsgiveravgiften av den.
export type Premiedata = { afp: number; aga: number; aga_sats: number };
// Permisjon og permittering som berører måneden (0084; prosent 1–100).
export type Permisjonsrad = { id: string; ansatt_id: string; fra: string; til: string; art: string | null; prosent: number; slutt_ukjent: boolean; betalt: boolean };
export type Grunnlag = {
  maaned: string; // ÅÅÅÅ-MM
  org: { navn: string; orgnr: string | null };
  virksomhet: string | null;
  pensjonsinnretning: string | null;
  sone: string;
  fullStilling: number;
  arbeidsforhold: Arbeidsforholdsrad[];
  slipper: Slippdata[];
  utkast: { periode: string; type: string }[]; // kjøringer med utbetaling i måneden som står som utkast
  permisjoner: Permisjonsrad[];
  // OTP-satsen og om ordningen tar opp dem som har fylt 75 år (0097), til påminnelsene om inn- og
  // utmelding.
  otp?: { prosent: number; unntak75: boolean };
  // AFP (0098): premiene som er betalt i måneden (arbeidsgiveravgiften følger innbetalingen), og
  // premien som er avsatt for forrige kvartal uten at betalingen er registrert (påminnelsen, i
  // andre og tredje måned i kvartalet).
  premier?: Premiedata[];
  afpIkkeBetalt?: { kvartal: string; avsatt: number } | null;
};
export type Avvik = { niva: "feil" | "advarsel"; tekst: string; ansatt_id?: string };

// Fristen: den 5. i måneden etter, eller neste virkedag.
export function frist(maaned: string) {
  const [a, m] = maaned.split("-").map(Number) as [number, number];
  let d = m === 12 ? `${a + 1}-01-05` : `${a}-${String(m + 1).padStart(2, "0")}-05`;
  while (!virkedag(d)) d = pluss(d, 1);
  return d;
}

const forste = (maaned: string) => `${maaned}-01`;
function siste(maaned: string) {
  const [a, m] = maaned.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10);
}
const desimal = (n: number) => String(rund(n));
const visDato = (d: string) => d.split("-").reverse().join(".");
const belop = (n: number) => rund(n).toFixed(2);
const FORM: Record<string, string> = { fast: "fast", midlertidig: "midlertidig", tilkalling: "midlertidigAnsattSomTilkallingsvikar" };

// --- Grunnlaget -------------------------------------------------------------------------------

// Grunnlaget for måneden fra databasen (som brukeren, eller som workeren).
export async function hentGrunnlag(db: Db, org: string, maaned: string): Promise<Grunnlag> {
  const fra = forste(maaned);
  const til = siste(maaned);
  const o = await en<{ navn: string; orgnr: string | null }>(db, "select navn, orgnr from faktura.organisasjoner where id = $1", [org]);
  const oppsett = await en<any>(
    db,
    `select aga_sone, full_stilling::float8 as full_stilling, virksomhet_orgnr, pensjonsinnretning_orgnr, otp_prosent::float8 as otp_prosent, otp_unntak_75,
            afp
       from faktura.lonn_oppsett where org_id = $1`,
    [org],
  );
  const slipper = await alle<any>(
    db,
    `select s.id, s.ansatt_id, to_char(s.utbetalingsdato, 'YYYY-MM-DD') as utbetalingsdato, s.skattetrekk::float8 as skattetrekk, s.aga::float8 as aga,
            s.aga_grunnlag::float8 as aga_grunnlag, s.aga_sats::float8 as aga_sats, s.otp::float8 as otp
       from faktura.lonnsslipper s join faktura.lonnskjoringer k on k.id = s.kjoring_id
      where s.org_id = $1 and k.status = 'godkjent' and s.utbetalingsdato between $2::date and $3::date
      order by s.utbetalingsdato, s.ansattnummer`,
    [org, fra, til],
  );
  const linjer = await alle<{
    slipp_id: string;
    lonnsart: string;
    belop: number;
    antall: number | null;
    opptjent_fra: string | null;
    opptjent_til: string | null;
    tillegg: Record<string, unknown> | null;
  }>(
    db,
    `select l.slipp_id, l.lonnsart, l.belop::float8 as belop, l.antall::float8 as antall,
            to_char(l.opptjent_fra, 'YYYY-MM-DD') as opptjent_fra, to_char(l.opptjent_til, 'YYYY-MM-DD') as opptjent_til, l.tillegg
       from faktura.lonnslinjer l where l.slipp_id = any($1::uuid[]) and not l.fjernet`,
    [slipper.map((s) => s.id)],
  );
  // Arbeidsforholdene som er aktive i måneden, og dem med utbetaling i den. Frilansere,
  // oppdragstakere og styremedlemmer (0096) rapporteres bare i månedene de får honorar.
  const arbeidsforhold = await alle<Arbeidsforholdsrad>(
    db,
    `select a.id, a.ansattnummer, a.fornavn || ' ' || a.etternavn as navn, a.har_fnr, to_char(a.ansatt_fra, 'YYYY-MM-DD') as ansatt_fra,
            to_char(a.ansatt_til, 'YYYY-MM-DD') as ansatt_til, coalesce(g.stillingsprosent, a.stillingsprosent)::float8 as stillingsprosent,
            a.ansettelsestype, a.yrkeskode, a.arbeidsforhold_type, a.arbeidstidsordning, a.aarsak_sluttdato,
            to_char(coalesce(e.lonn, case when a.siste_lonnsendring <= $3::date then a.siste_lonnsendring end), 'YYYY-MM-DD') as siste_lonnsendring,
            to_char(coalesce(e.stilling, case when a.siste_stillingsendring <= $3::date then a.siste_stillingsendring end), 'YYYY-MM-DD') as siste_stillingsendring,
            to_char(a.fodselsdato, 'YYYY-MM-DD') as fodselsdato, to_char(a.otp_innmeldt, 'YYYY-MM-DD') as otp_innmeldt,
            to_char(a.otp_utmeldt, 'YYYY-MM-DD') as otp_utmeldt
       from faktura.ansatte a
       left join lateral faktura.lonn_gjeldende(a.org_id, a.id, $3::date) g on true
       left join lateral faktura.lonn_endringsdatoer(a.org_id, a.id, $3::date) e on true
      where a.org_id = $1 and a.arbeidstaker
        and ((a.arbeidsforhold_type <> 'frilanserOppdragstakerHonorarPersonerMm' and a.ansatt_fra <= $3::date and (a.ansatt_til is null or a.ansatt_til >= $2::date))
             or a.id = any($4::uuid[]))
      order by a.ansattnummer`,
    [org, fra, til, [...new Set(slipper.map((s) => s.ansatt_id))]],
  );
  const utkast = await alle<{ periode: string; type: string }>(
    db,
    `select to_char(periode, 'YYYY-MM-DD') as periode, type from faktura.lonnskjoringer
      where org_id = $1 and status = 'utkast' and utbetalingsdato between $2::date and $3::date order by periode`,
    [org, fra, til],
  );
  // Permisjonene og permitteringene som berører måneden (de som skal rapporteres, velges ved bruk).
  const permisjoner = await alle<Permisjonsrad>(
    db,
    `select f.id, f.ansatt_id, to_char(f.fra, 'YYYY-MM-DD') as fra, to_char(f.til, 'YYYY-MM-DD') as til, f.permisjon_art as art,
            coalesce(f.prosent, 100)::int as prosent, f.slutt_ukjent, f.betalt
       from faktura.fravaer f
      where f.org_id = $1 and f.type = 'permisjon' and f.fra <= $3::date and f.til >= $2::date
      order by f.fra`,
    [org, fra, til],
  );
  // AFP-premiene som er betalt i måneden, og om premien for forrige kvartal er betalt.
  const premier = await alle<Premiedata>(
    db,
    "select afp::float8 as afp, aga::float8 as aga, aga_sats::float8 as aga_sats from faktura.afp_premier where org_id = $1 and dato between $2::date and $3::date order by dato",
    [org, fra, til],
  );
  let afpIkkeBetalt: Grunnlag["afpIkkeBetalt"] = null;
  const nr = Number(maaned.slice(5, 7));
  if (oppsett?.afp && nr % 3 !== 1) {
    const q = Math.floor((nr - 1) / 3) + 1;
    const f = q === 1 ? { aar: Number(maaned.slice(0, 4)) - 1, kvartal: 4 } : { aar: Number(maaned.slice(0, 4)), kvartal: q - 1 };
    const qFra = `${f.aar}-${String((f.kvartal - 1) * 3 + 1).padStart(2, "0")}-01`;
    const x = await en<{ avsatt: number; betalt: boolean }>(
      db,
      `select coalesce((select sum(s.afp + s.ou) from faktura.lonnsslipper s join faktura.lonnskjoringer k on k.id = s.kjoring_id
                         where s.org_id = $1 and k.status = 'godkjent' and k.utbetalingsdato between $2::date and ($2::date + interval '3 months' - interval '1 day')::date), 0)::float8 as avsatt,
              exists (select 1 from faktura.afp_premier p where p.org_id = $1 and p.aar = $3 and p.kvartal = $4) as betalt`,
      [org, qFra, f.aar, f.kvartal],
    );
    if (x && x.avsatt > 0 && !x.betalt) afpIkkeBetalt = { kvartal: `${f.kvartal}. kvartal ${f.aar}`, avsatt: rund(x.avsatt) };
  }
  return {
    maaned,
    org: { navn: o?.navn ?? "", orgnr: o?.orgnr ?? null },
    virksomhet: oppsett?.virksomhet_orgnr ?? null,
    pensjonsinnretning: oppsett?.pensjonsinnretning_orgnr ?? null,
    sone: oppsett?.aga_sone ?? "1",
    fullStilling: Number(oppsett?.full_stilling ?? 37.5),
    arbeidsforhold,
    slipper: slipper.map((s) => ({
      ansatt_id: s.ansatt_id,
      utbetalingsdato: s.utbetalingsdato,
      skattetrekk: s.skattetrekk,
      aga: s.aga,
      aga_grunnlag: s.aga_grunnlag,
      aga_sats: s.aga_sats,
      otp: s.otp,
      linjer: linjer
        .filter((l) => l.slipp_id === s.id)
        .map(({ lonnsart: art, belop: b, antall, opptjent_fra, opptjent_til, tillegg }) => ({ lonnsart: art, belop: b, antall, opptjent_fra, opptjent_til, tillegg })),
    })),
    utkast,
    permisjoner,
    otp: { prosent: Number(oppsett?.otp_prosent ?? 2), unntak75: !!oppsett?.otp_unntak_75 },
    premier,
    afpIkkeBetalt,
  };
}

// --- Inntektene, trekket og avgiften ----------------------------------------------------------

// fordel: kontantytelse (lønn), naturalytelse eller utgiftsgodtgjoerelse (reiser; 0083). opptjent:
// opptjeningsperioden når lønnen gjelder en annen måned (etterbetaling). bil: listeprisen og
// registreringsnummeret for fri bil (tilleggsinformasjonen).
type Fordel = "kontantytelse" | "naturalytelse" | "utgiftsgodtgjoerelse";
type Inntekt = {
  fordel: Fordel;
  beskrivelse: string;
  aga: boolean;
  trekk: boolean;
  belop: number;
  antall: number | null;
  opptjent: { fra: string; til: string } | null;
  bil: { listepris: number; regnr: string | null; bilpool: boolean } | null;
};
const FORDEL: Record<string, Fordel> = { lonn: "kontantytelse", natural: "naturalytelse", utgift: "utgiftsgodtgjoerelse" };
// Beskrivelsene som rapporteres med antall: timer for timelønnen, døgn, netter og km for reisene.
const MED_ANTALL = new Set([
  "timeloenn",
  "reiseKostMedOvernattingPaaHotell",
  "reiseKostMedOvernattingPaaHybelUtenKokEllerPensjonatEllerBrakke",
  "reiseKostMedOvernattingPaaHybelMedKokEllerPrivat",
  "reiseKostUtenOvernatting",
  "reiseNattillegg",
  "kilometergodtgjoerelseBil",
  "kilometergodtgjoerelsePassasjertillegg",
  "kilometergodtgjoerelseAndreFremkomstmidler",
]);

// Lønnen, naturalytelsene og utgiftsgodtgjørelsene per ansatt etter beskrivelsen i a-meldingen (og
// om de gir avgift og trekk, og opptjeningsperioden for etterbetaling); antall timer for
// timelønnen og døgn, netter eller km for reisene. Fri bil per bil.
export function inntekter(slipper: Slippdata[]): Map<string, Inntekt[]> {
  const ut = new Map<string, Map<string, Inntekt>>();
  for (const s of slipper) {
    const per = ut.get(s.ansatt_id) ?? new Map<string, Inntekt>();
    ut.set(s.ansatt_id, per);
    for (const l of s.linjer) {
      const art = lonnsart(l.lonnsart);
      const fordel = FORDEL[art.type];
      if (!fordel || !art.amelding || !l.belop) continue;
      const opptjent = l.opptjent_fra && l.opptjent_til ? { fra: l.opptjent_fra, til: l.opptjent_til } : null;
      const t = l.tillegg as { listepris?: number; regnr?: string | null; bilpool?: boolean } | null | undefined;
      const bil = l.lonnsart === "natural_bil" && t?.listepris ? { listepris: Number(t.listepris), regnr: t.regnr ?? null, bilpool: !!t.bilpool } : null;
      const nokkel = `${fordel}|${art.amelding}|${art.aga}|${art.trekk}|${opptjent?.fra ?? ""}|${opptjent?.til ?? ""}|${bil ? `${bil.listepris}|${bil.regnr}|${bil.bilpool}` : ""}`;
      const x = per.get(nokkel) ?? { fordel, beskrivelse: art.amelding, aga: art.aga, trekk: art.trekk, belop: 0, antall: null, opptjent, bil };
      x.belop += l.belop;
      if (MED_ANTALL.has(art.amelding) && l.antall != null) x.antall = (x.antall ?? 0) + Number(l.antall);
      per.set(nokkel, x);
    }
  }
  return new Map(
    [...ut].map(([id, per]) => [
      id,
      [...per.values()].map((x) => ({ ...x, belop: rund(x.belop), antall: x.antall == null ? null : rund(x.antall) })).filter((x) => x.belop !== 0),
    ]),
  );
}

// Trekkene i lønnen (0082) som skal i a-meldingen: fagforeningskontingenten som fradrag (negativt
// beløp), og utleggstrekkene til Skatteetaten (samordnet, og for skattekrav etter det gamle
// regelverket) i hele kroner med datoen for trekket (lønnsdatoen). Bidragstrekk og andre
// utleggstrekk rapporteres ikke.
const UTLEGG: Record<string, string> = { utleggstrekk_samordnet: "utleggstrekkSamordnet", utleggstrekk_skatt: "utleggstrekkSkatt" };
export function trekkILonn(slipper: Slippdata[]) {
  const fradrag = new Map<string, number>();
  const utlegg = new Map<string, { beskrivelse: string; beloep: number; dato: string }[]>();
  let sumUtlegg = 0;
  for (const s of slipper)
    for (const l of s.linjer) {
      if (l.lonnsart === "fagforening") fradrag.set(s.ansatt_id, rund((fradrag.get(s.ansatt_id) ?? 0) - Number(l.belop)));
      const beskrivelse = UTLEGG[l.lonnsart];
      if (!beskrivelse) continue;
      const b = Math.round(-Number(l.belop));
      if (!b) continue;
      const liste = utlegg.get(s.ansatt_id) ?? [];
      const x = liste.find((y) => y.beskrivelse === beskrivelse && y.dato === s.utbetalingsdato);
      if (x) x.beloep += b;
      else liste.push({ beskrivelse, beloep: b, dato: s.utbetalingsdato });
      utlegg.set(s.ansatt_id, liste);
      sumUtlegg += b;
    }
  return { fradrag, utlegg, sumUtlegg };
}

// Forskuddstrekket i hele kroner, per ansatt og per lønnsdato (summene stemmer med hverandre).
export function forskuddstrekk(slipper: Slippdata[]) {
  const perAnsatt = new Map<string, number>();
  const perDato = new Map<string, number>();
  for (const s of slipper) {
    const t = Math.round(s.skattetrekk);
    perAnsatt.set(s.ansatt_id, (perAnsatt.get(s.ansatt_id) ?? 0) + t);
    perDato.set(s.utbetalingsdato, (perDato.get(s.utbetalingsdato) ?? 0) + t);
  }
  return { perAnsatt, perDato: [...perDato].sort(([a], [b]) => a.localeCompare(b)) };
}

const STANDARDSATS: Record<string, number> = { "1": 14.1, "1a": 10.6, "2": 10.6, "3": 6.4, "4": 5.1, "4a": 7.9, "5": 0 };

// Avgiftsgrunnlaget per sats: lønnen og pensjonen (OTP, og AFP-premien som er betalt i måneden)
// for seg. I sone 1a deles en slipp (eller premie) der fribeløpet ble brukt opp, i delen med
// redusert sats og delen med full sats.
export function avgiftsgrunnlag(slipper: Slippdata[], sone: string, premier: Premiedata[] = []) {
  const per = new Map<number, { lonn: number; pensjon: number }>();
  const legg = (sats: number, lonn: number, pensjon: number) => {
    const x = per.get(sats) ?? { lonn: 0, pensjon: 0 };
    x.lonn += lonn;
    x.pensjon += pensjon;
    per.set(sats, x);
  };
  const grunnlag = [
    ...slipper.map((s) => ({ g: s.aga_grunnlag, pensjon: s.otp, aga: s.aga, sats: s.aga_sats })),
    ...premier.map((p) => ({ g: p.afp, pensjon: p.afp, aga: p.aga, sats: p.aga_sats })),
  ];
  for (const s of grunnlag) {
    const g = s.g;
    if (!g) continue;
    const andelPensjon = s.pensjon / g;
    const sats = rund(s.sats);
    if (sone === "1a" && sats !== STANDARDSATS["1a"] && sats !== 14.1) {
      const full = Math.min(g, Math.max(0, (s.aga - (g * 10.6) / 100) / ((14.1 - 10.6) / 100)));
      for (const [del, x] of [
        [10.6, g - full],
        [14.1, full],
      ] as const)
        if (x > 0) legg(del, x * (1 - andelPensjon), x * andelPensjon);
    } else legg(sats, g - s.pensjon, s.pensjon);
  }
  return [...per]
    .map(([sats, x]) => ({ sats, lonn: rund(x.lonn), pensjon: rund(x.pensjon) }))
    .sort((a, b) => b.sats - a.sats);
}

// Arbeidsgiveravgiften i hele kroner (summen av grunnlagene ganger satsene).
export const sumAvgift = (grupper: ReturnType<typeof avgiftsgrunnlag>) => Math.round(grupper.reduce((x, g) => x + ((g.lonn + g.pensjon) * g.sats) / 100, 0));

// --- Kontrollen -------------------------------------------------------------------------------

export function kontroller(g: Grunnlag): Avvik[] {
  const a: Avvik[] = [];
  if (!g.org.orgnr) a.push({ niva: "feil", tekst: "Organisasjonen mangler organisasjonsnummer." });
  if (!g.virksomhet)
    a.push({
      niva: "feil",
      tekst: "Legg inn organisasjonsnummeret til virksomheten (underenheten i Enhetsregisteret) under Innstillinger → Ansatte og timer → A-melding.",
    });
  if (g.slipper.some((s) => s.otp > 0) && !g.pensjonsinnretning)
    a.push({ niva: "feil", tekst: "Det er OTP i måneden: legg inn organisasjonsnummeret til pensjonsleverandøren under Innstillinger → Ansatte og timer → A-melding." });
  const iMelding = new Set(g.slipper.map((s) => s.ansatt_id));
  for (const f of g.arbeidsforhold) {
    if (!f.har_fnr) a.push({ niva: "feil", tekst: `${f.navn} mangler fødselsnummer (eller D-nummer).`, ansatt_id: f.id });
    // Yrket må også oppgis for frilansere, oppdragstakere og styremedlemmer; årsaken til
    // sluttdatoen bare for ordinære (og maritime) arbeidsforhold.
    if (!f.yrkeskode) a.push({ niva: "feil", tekst: `${f.navn} mangler yrkeskode (7 siffer, SSBs yrkeskoder).`, ansatt_id: f.id });
    if (f.arbeidsforhold_type !== "frilanserOppdragstakerHonorarPersonerMm" && f.ansatt_til && f.ansatt_til <= siste(g.maaned) && !f.aarsak_sluttdato)
      a.push({ niva: "advarsel", tekst: `${f.navn} slutter ${f.ansatt_til.split("-").reverse().join(".")}: velg årsaken til sluttdatoen.`, ansatt_id: f.id });
    iMelding.delete(f.id);
  }
  for (const k of g.utkast)
    a.push({ niva: "advarsel", tekst: `Lønnskjøringen for ${k.periode.slice(0, 7)}${k.type === "ekstra" ? " (ekstra)" : ""} med utbetaling i måneden står som utkast og er ikke med.` });
  // Permisjon over 14 dager og permittering: arten må være valgt, og en sluttdato som ikke er
  // bekreftet, rapporteres når permisjonen står til å slutte i måneden.
  for (const p of g.permisjoner) {
    const f = g.arbeidsforhold.find((x) => x.id === p.ansatt_id);
    if (!f || !rapporteres(p)) continue;
    if (f.arbeidsforhold_type === "frilanserOppdragstakerHonorarPersonerMm")
      a.push({ niva: "advarsel", tekst: `${f.navn} er frilanser eller oppdragstaker: permisjon og permittering rapporteres ikke for dem.`, ansatt_id: f.id });
    else if (!p.art)
      a.push({
        niva: "feil",
        tekst: `Velg hva slags permisjon ${f.navn} har (${visDato(p.fra)}–${visDato(p.til)}, under Fravær): permisjon over 14 dager skal med i a-meldingen.`,
        ansatt_id: f.id,
      });
    else if (p.slutt_ukjent && p.til <= siste(g.maaned))
      a.push({
        niva: "advarsel",
        tekst: `${permisjonNavn(p.art, p.betalt)} for ${f.navn} står til og med ${visDato(p.til)} uten bekreftet sluttdato, og den datoen rapporteres som sluttdato. Forleng den om den varer lenger.`,
        ansatt_id: f.id,
      });
  }
  // OTP (0097): den som er med i ordningen i måneden, meldes inn hos pensjonsleverandøren, og den
  // som slutter (eller fyller 75 år når ordningen ikke tar dem opp), meldes ut.
  if (g.otp && g.otp.prosent > 0)
    for (const f of g.arbeidsforhold) {
      const p = otpMedlemskap({ fodselsdato: f.fodselsdato ?? null, ansatt_fra: f.ansatt_fra, ansatt_til: f.ansatt_til, arbeidsforhold_type: f.arbeidsforhold_type }, g.otp.unntak75);
      if (!p || p.fra > siste(g.maaned)) continue;
      if (!f.otp_innmeldt && (!p.til || p.til >= forste(g.maaned)))
        a.push({ niva: "advarsel", tekst: `${f.navn} er med i OTP fra ${visDato(p.fra)}: meld den ansatte inn hos pensjonsleverandøren, og før datoen på den ansatte.`, ansatt_id: f.id });
      else if (f.otp_innmeldt && p.til && p.til <= siste(g.maaned) && !f.otp_utmeldt)
        a.push({ niva: "advarsel", tekst: `${f.navn} er med i OTP til og med ${visDato(p.til)}: meld den ansatte ut hos pensjonsleverandøren, og før datoen på den ansatte.`, ansatt_id: f.id });
    }
  // AFP (0098): premien for forrige kvartal er avsatt, men betalingen er ikke registrert.
  if (g.afpIkkeBetalt)
    a.push({
      niva: "advarsel",
      tekst: `AFP-premien for ${g.afpIkkeBetalt.kvartal} (avsatt ${g.afpIkkeBetalt.avsatt.toLocaleString("nb-NO", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/[\u00a0\u202f]/g, " ")} kr) er ikke registrert som betalt. Registrer betalingen under Lønn → AFP når fakturaen fra Fellesordningen er betalt, så kommer arbeidsgiveravgiften av premien med i a-meldingen for den måneden.`,
    });
  if (!g.arbeidsforhold.length && !g.slipper.length) a.push({ niva: "advarsel", tekst: "Ingen er ansatt eller har fått lønn i måneden, så det er ingenting å rapportere." });
  return a;
}

// --- Oppsummeringen (uten fødselsnumre) -------------------------------------------------------

export function oppsummer(g: Grunnlag) {
  const inn = inntekter(g.slipper);
  const trekk = forskuddstrekk(g.slipper);
  const avgift = avgiftsgrunnlag(g.slipper, g.sone, g.premier);
  return {
    maaned: g.maaned,
    virksomhet: g.virksomhet,
    antall_arbeidsforhold: g.arbeidsforhold.length,
    antall_med_lonn: inn.size,
    inntekt: rund([...inn.values()].flat().reduce((x, i) => x + i.belop, 0)),
    forskuddstrekk: trekk.perDato.map(([dato, b]) => ({ dato, belop: b })),
    sum_forskuddstrekk: trekk.perDato.reduce((x, [, b]) => x + b, 0),
    sum_utleggstrekk: trekkILonn(g.slipper).sumUtlegg,
    arbeidsgiveravgift: sumAvgift(avgift),
    avgiftsgrunnlag: avgift,
    // AFP-premien som er betalt i måneden (med arbeidsgiveravgift av den).
    afp_premie: rund((g.premier ?? []).reduce((x, p) => x + Number(p.afp), 0)),
    mottakere: g.arbeidsforhold
      .map((f) => ({
        ansatt_id: f.id,
        navn: f.navn,
        ansattnummer: f.ansattnummer,
        inntekter: inn.get(f.id) ?? [],
        forskuddstrekk: trekk.perAnsatt.get(f.id) ?? 0,
        permisjoner: permisjonerI(g, f).map((p) => ({
          navn: permisjonNavn(p.art, p.betalt),
          fra: p.fra,
          til: sluttdatoKjent(p, siste(g.maaned)) ? p.til : null,
          prosent: p.prosent,
        })),
      }))
      .filter((m) => m.inntekter.length || g.arbeidsforhold.some((f) => f.id === m.ansatt_id)),
  };
}

// --- Meldingen --------------------------------------------------------------------------------

export type Byggevalg = {
  meldingsId: string;
  erstatter?: string | null;
  tidspunkt: string; // ÅÅÅÅ-MM-DDTtt:mm:ssZ
  fnr: (ansattId: string) => string | null;
};

// Permisjonene og permitteringene som skal med for arbeidsforholdet i måneden: permisjon over 14
// dager og all permittering, med arten valgt (frilansere har ikke permisjon).
function permisjonerI(g: Grunnlag, f: Arbeidsforholdsrad) {
  if (f.arbeidsforhold_type === "frilanserOppdragstakerHonorarPersonerMm") return [];
  return g.permisjoner.filter((p) => p.ansatt_id === f.id && p.art && p.art in PERMISJONSARTER && rapporteres(p));
}

function arbeidsforhold(f: Arbeidsforholdsrad, g: Grunnlag) {
  const frilanser = f.arbeidsforhold_type === "frilanserOppdragstakerHonorarPersonerMm";
  const x: Record<string, unknown> = { arbeidsforholdId: String(f.ansattnummer), typeArbeidsforhold: f.arbeidsforhold_type, startdato: f.ansatt_fra };
  if (f.ansatt_til) x.sluttdato = f.ansatt_til;
  if (!frilanser) x.antallTimerPerUkeSomEnFullStillingTilsvarer = desimal(g.fullStilling);
  if (f.yrkeskode) x.yrke = f.yrkeskode;
  if (!frilanser) {
    x.arbeidstidsordning = f.arbeidstidsordning;
    x.stillingsprosent = desimal(f.stillingsprosent);
    x.sisteLoennsendringsdato = f.siste_lonnsendring ?? f.ansatt_fra;
    // Permisjonene (permittering som permisjon med beskrivelsen «permittering»), med den samme id-en
    // hver måned og sluttdatoen når den er kjent.
    const p = permisjonerI(g, f);
    if (p.length)
      x.permisjon = p.map((y) => ({
        startdato: y.fra,
        ...(sluttdatoKjent(y, siste(g.maaned)) ? { sluttdato: y.til } : {}),
        permisjonsprosent: desimal(y.prosent),
        permisjonId: y.id,
        beskrivelse: PERMISJONSARTER[y.art as PermisjonsArt].amelding,
      }));
    x.sisteDatoForStillingsprosentendring = f.siste_stillingsendring ?? f.ansatt_fra;
  }
  if (!frilanser && f.ansatt_til && f.aarsak_sluttdato) x.aarsakTilSluttdato = f.aarsak_sluttdato;
  if (!frilanser) x.formForAnsettelse = FORM[f.ansettelsestype] ?? "fast";
  return x;
}

// Leveransen som JSON til API-et ({"leveranse": …}).
export function byggLeveranse(g: Grunnlag, v: Byggevalg) {
  if (!g.org.orgnr) throw new Error("Organisasjonen mangler organisasjonsnummer");
  if (!g.virksomhet) throw new Error("Virksomheten mangler organisasjonsnummer");
  const inn = inntekter(g.slipper);
  const trekk = forskuddstrekk(g.slipper);
  const avgift = avgiftsgrunnlag(g.slipper, g.sone, g.premier);
  const iLonn = trekkILonn(g.slipper);
  const mottakere = g.arbeidsforhold
    .map((f) => {
      const fnr = v.fnr(f.id);
      if (!fnr) throw new Error(`${f.navn} mangler fødselsnummer`);
      const x: Record<string, unknown> = { norskIdentifikator: fnr, arbeidsforhold: [arbeidsforhold(f, g)] };
      const fradrag = iLonn.fradrag.get(f.id) ?? 0;
      if (fradrag) x.fradrag = [{ beskrivelse: "fagforeningskontingent", beloep: belop(-fradrag) }];
      const t = trekk.perAnsatt.get(f.id) ?? 0;
      if (t) x.forskuddstrekk = [{ beskrivelse: "ordinaert", beloep: -t }];
      const i = inn.get(f.id) ?? [];
      if (i.length)
        x.inntekt = i.map((y) => {
          // Elementene i rekkefølgen XSD-en krever: beskrivelse, tilleggsinformasjon, antall.
          const loennsinntekt: Record<string, unknown> = { beskrivelse: y.beskrivelse };
          if (y.bil)
            loennsinntekt.tilleggsinformasjon = {
              bilOgBaat: y.bil.bilpool
                ? { listeprisForBil: belop(y.bil.listepris), erBilpool: true }
                : { listeprisForBil: belop(y.bil.listepris), bilregistreringsnummer: y.bil.regnr ?? "" },
            };
          if (y.antall != null && y.antall > 0) loennsinntekt.antall = desimal(y.antall);
          return {
            ...(y.opptjent ? { startdatoOpptjeningsperiode: y.opptjent.fra, sluttdatoOpptjeningsperiode: y.opptjent.til } : {}),
            fordel: y.fordel,
            utloeserArbeidsgiveravgift: y.aga,
            inngaarIGrunnlagForTrekk: y.trekk,
            beloep: belop(y.belop),
            arbeidsforholdId: String(f.ansattnummer),
            loennsinntekt,
          };
        });
      const u = iLonn.utlegg.get(f.id) ?? [];
      if (u.length) x.utleggstrekk = u.map((y) => ({ beskrivelse: y.beskrivelse, beloep: -y.beloep, datoForUtleggstrekk: y.dato }));
      return x;
    })
    .filter((m) => m.arbeidsforhold || m.inntekt);
  const virksomhet: Record<string, unknown> = { norskIdentifikator: g.virksomhet };
  if (mottakere.length) virksomhet.inntektsmottaker = mottakere;
  const lonn = avgift.filter((x) => x.lonn > 0);
  const pensjon = avgift.filter((x) => x.pensjon > 0);
  if (lonn.length || pensjon.length) {
    const grunnlag = (beloep: number, sats: number) => ({
      beregningskodeForArbeidsgiveravgift: "generelleNaeringer",
      sone: g.sone,
      avgiftsgrunnlagBeloep: belop(beloep),
      prosentsatsForAvgiftsberegning: desimal(sats),
    });
    const aga: Record<string, unknown> = {};
    if (lonn.length) aga.loennOgGodtgjoerelse = lonn.map((x) => grunnlag(x.lonn, x.sats));
    if (pensjon.length) aga.tilskuddOgPremieTilPensjon = pensjon.map((x) => grunnlag(x.pensjon, x.sats));
    virksomhet.arbeidsgiveravgift = aga;
  }
  const oppgave: Record<string, unknown> = {};
  if (g.slipper.length || g.premier?.length) {
    const betaling: Record<string, unknown> = { sumArbeidsgiveravgift: sumAvgift(avgift) };
    if (iLonn.sumUtlegg) betaling.sumUtleggstrekk = iLonn.sumUtlegg;
    const perDato = trekk.perDato.filter(([, b]) => b !== 0);
    if (perDato.length) betaling.sumForskuddstrekkPerLoennsutbetalingsdato = perDato.map(([dato, b]) => ({ loennsutbetalingsdato: dato, beloep: b }));
    oppgave.betalingsinformasjon = betaling;
  }
  oppgave.virksomhet = [virksomhet];
  if (g.pensjonsinnretning && g.slipper.some((s) => s.otp > 0)) oppgave.pensjonsinnretning = [{ identifikator: g.pensjonsinnretning }];
  const leveranse: Record<string, unknown> = { leveringstidspunkt: v.tidspunkt, kalendermaaned: g.maaned, kildesystem: KILDESYSTEM };
  if (v.erstatter) leveranse.erstatterMeldingsId = v.erstatter;
  leveranse.meldingsId = v.meldingsId;
  leveranse.opplysningspliktig = { norskIdentifikator: g.org.orgnr };
  leveranse.oppgave = oppgave;
  leveranse.spraakForTilbakemelding = "bokmaal";
  return { leveranse };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function element(navn: string, v: unknown, innrykk: string): string {
  if (Array.isArray(v)) return v.map((x) => element(navn, x, innrykk)).join("");
  if (v && typeof v === "object")
    return `${innrykk}<${navn}>\n${Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => element(k, x, `${innrykk}  `))
      .join("")}${innrykk}</${navn}>\n`;
  return `${innrykk}<${navn}>${esc(String(v))}</${navn}>\n`;
}

// Den samme leveransen som XML (til opplasting på skatteetaten.no).
export function tilXml(m: ReturnType<typeof byggLeveranse>): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<melding xmlns="${NAVNEROM}">\n${element("Leveranse", m.leveranse, "  ")}</melding>\n`;
}
