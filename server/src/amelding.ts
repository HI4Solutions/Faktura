// A-meldingen (0077_amelding.sql): den månedlige rapporteringen til a-ordningen, format 2.3.
// Grunnlaget for en måned er de godkjente lønnskjøringene med utbetaling i måneden (lønnen etter
// beskrivelsen i a-meldingen, forskuddstrekket og arbeidsgiveravgiften) og arbeidsforholdene som er
// aktive i den (også uten utbetaling: a-meldingen leveres hver måned så lenge noen er ansatt).
//
// byggLeveranse gir meldingen som JSON til Skatteetatens API ({"leveranse": …}; desimaltall som
// tekst, heltall som tall), og tilXml den samme som XML til opplasting på skatteetaten.no
// (<melding><Leveranse>…). Feltene står i rekkefølgen skjemaet krever. Fødselsnumrene leser bare
// workeren; kontroller og oppsummer trenger dem ikke, så appen kan vise grunnlaget og avvikene.
//
// https://github.com/Skatteetaten/api-dokumentasjon (innrapportering-amelding)

import { alle, en, type Db } from "./db.js";
import { lonnsart } from "./lonnsarter.js";
import { rund } from "./lonnsberegning.js";

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
};
export type Slippdata = {
  ansatt_id: string;
  utbetalingsdato: string;
  skattetrekk: number;
  aga: number;
  aga_grunnlag: number;
  aga_sats: number;
  otp: number;
  linjer: { lonnsart: string; belop: number; antall: number | null }[];
};
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
  permisjoner: { ansatt_id: string; fra: string; til: string }[]; // permisjon over 14 dager i måneden
};
export type Avvik = { niva: "feil" | "advarsel"; tekst: string; ansatt_id?: string };

const forste = (maaned: string) => `${maaned}-01`;
function siste(maaned: string) {
  const [a, m] = maaned.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10);
}
const desimal = (n: number) => String(rund(n));
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
    "select aga_sone, full_stilling::float8 as full_stilling, virksomhet_orgnr, pensjonsinnretning_orgnr from faktura.lonn_oppsett where org_id = $1",
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
  const linjer = await alle<{ slipp_id: string; lonnsart: string; belop: number; antall: number | null }>(
    db,
    `select l.slipp_id, l.lonnsart, l.belop::float8 as belop, l.antall::float8 as antall
       from faktura.lonnslinjer l where l.slipp_id = any($1::uuid[]) and not l.fjernet`,
    [slipper.map((s) => s.id)],
  );
  const arbeidsforhold = await alle<Arbeidsforholdsrad>(
    db,
    `select a.id, a.ansattnummer, a.fornavn || ' ' || a.etternavn as navn, a.har_fnr, to_char(a.ansatt_fra, 'YYYY-MM-DD') as ansatt_fra,
            to_char(a.ansatt_til, 'YYYY-MM-DD') as ansatt_til, a.stillingsprosent::float8 as stillingsprosent, a.ansettelsestype, a.yrkeskode,
            a.arbeidsforhold_type, a.arbeidstidsordning, a.aarsak_sluttdato, to_char(a.siste_lonnsendring, 'YYYY-MM-DD') as siste_lonnsendring,
            to_char(a.siste_stillingsendring, 'YYYY-MM-DD') as siste_stillingsendring
       from faktura.ansatte a
      where a.org_id = $1 and a.arbeidstaker
        and ((a.ansatt_fra <= $3::date and (a.ansatt_til is null or a.ansatt_til >= $2::date)) or a.id = any($4::uuid[]))
      order by a.ansattnummer`,
    [org, fra, til, [...new Set(slipper.map((s) => s.ansatt_id))]],
  );
  const utkast = await alle<{ periode: string; type: string }>(
    db,
    `select to_char(periode, 'YYYY-MM-DD') as periode, type from faktura.lonnskjoringer
      where org_id = $1 and status = 'utkast' and utbetalingsdato between $2::date and $3::date order by periode`,
    [org, fra, til],
  );
  // Permisjon (uten lønn) over 14 dager som berører måneden: skal rapporteres, men appen gjør det ikke ennå.
  const permisjoner = await alle<{ ansatt_id: string; fra: string; til: string }>(
    db,
    `select f.ansatt_id, to_char(f.fra, 'YYYY-MM-DD') as fra, to_char(f.til, 'YYYY-MM-DD') as til from faktura.fravaer f
      where f.org_id = $1 and f.type = 'permisjon' and not f.betalt and f.til - f.fra >= 14 and f.fra <= $3::date and f.til >= $2::date`,
    [org, fra, til],
  );
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
      linjer: linjer.filter((l) => l.slipp_id === s.id).map(({ lonnsart: art, belop: b, antall }) => ({ lonnsart: art, belop: b, antall })),
    })),
    utkast,
    permisjoner,
  };
}

// --- Inntektene, trekket og avgiften ----------------------------------------------------------

type Inntekt = { beskrivelse: string; aga: boolean; trekk: boolean; belop: number; antall: number | null };

// Lønnen per ansatt etter beskrivelsen i a-meldingen (og om den gir avgift og trekk); antall
// timer for timelønnen.
export function inntekter(slipper: Slippdata[]): Map<string, Inntekt[]> {
  const ut = new Map<string, Map<string, Inntekt>>();
  for (const s of slipper) {
    const per = ut.get(s.ansatt_id) ?? new Map<string, Inntekt>();
    ut.set(s.ansatt_id, per);
    for (const l of s.linjer) {
      const art = lonnsart(l.lonnsart);
      if (art.type !== "lonn" || !art.amelding || !l.belop) continue;
      const nokkel = `${art.amelding}|${art.aga}|${art.trekk}`;
      const x = per.get(nokkel) ?? { beskrivelse: art.amelding, aga: art.aga, trekk: art.trekk, belop: 0, antall: null };
      x.belop += l.belop;
      if (art.amelding === "timeloenn" && l.antall != null) x.antall = (x.antall ?? 0) + Number(l.antall);
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

// Avgiftsgrunnlaget per sats: lønnen og pensjonen (OTP) for seg. I sone 1a deles en slipp der
// fribeløpet ble brukt opp, i delen med redusert sats og delen med full sats.
export function avgiftsgrunnlag(slipper: Slippdata[], sone: string) {
  const per = new Map<number, { lonn: number; pensjon: number }>();
  const legg = (sats: number, lonn: number, pensjon: number) => {
    const x = per.get(sats) ?? { lonn: 0, pensjon: 0 };
    x.lonn += lonn;
    x.pensjon += pensjon;
    per.set(sats, x);
  };
  for (const s of slipper) {
    const g = s.aga_grunnlag;
    if (!g) continue;
    const andelPensjon = s.otp / g;
    const sats = rund(s.aga_sats);
    if (sone === "1a" && sats !== STANDARDSATS["1a"] && sats !== 14.1) {
      const full = Math.min(g, Math.max(0, (s.aga - (g * 10.6) / 100) / ((14.1 - 10.6) / 100)));
      for (const [del, x] of [
        [10.6, g - full],
        [14.1, full],
      ] as const)
        if (x > 0) legg(del, x * (1 - andelPensjon), x * andelPensjon);
    } else legg(sats, g - s.otp, s.otp);
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
    if (f.arbeidsforhold_type !== "frilanserOppdragstakerHonorarPersonerMm" && !f.yrkeskode)
      a.push({ niva: "feil", tekst: `${f.navn} mangler yrkeskode (7 siffer, SSBs yrkeskoder).`, ansatt_id: f.id });
    if (f.ansatt_til && f.ansatt_til <= siste(g.maaned) && !f.aarsak_sluttdato)
      a.push({ niva: "advarsel", tekst: `${f.navn} slutter ${f.ansatt_til.split("-").reverse().join(".")}: velg årsaken til sluttdatoen.`, ansatt_id: f.id });
    iMelding.delete(f.id);
  }
  for (const k of g.utkast)
    a.push({ niva: "advarsel", tekst: `Lønnskjøringen for ${k.periode.slice(0, 7)}${k.type === "ekstra" ? " (ekstra)" : ""} med utbetaling i måneden står som utkast og er ikke med.` });
  for (const p of g.permisjoner) {
    const f = g.arbeidsforhold.find((x) => x.id === p.ansatt_id);
    if (f) a.push({ niva: "advarsel", tekst: `${f.navn} har permisjon over 14 dager. Permisjonen er ikke med i a-meldingen fra appen ennå; meld den i Altinn om den skal rapporteres.`, ansatt_id: f.id });
  }
  if (!g.arbeidsforhold.length && !g.slipper.length) a.push({ niva: "advarsel", tekst: "Ingen er ansatt eller har fått lønn i måneden, så det er ingenting å rapportere." });
  return a;
}

// --- Oppsummeringen (uten fødselsnumre) -------------------------------------------------------

export function oppsummer(g: Grunnlag) {
  const inn = inntekter(g.slipper);
  const trekk = forskuddstrekk(g.slipper);
  const avgift = avgiftsgrunnlag(g.slipper, g.sone);
  return {
    maaned: g.maaned,
    virksomhet: g.virksomhet,
    antall_arbeidsforhold: g.arbeidsforhold.length,
    antall_med_lonn: inn.size,
    inntekt: rund([...inn.values()].flat().reduce((x, i) => x + i.belop, 0)),
    forskuddstrekk: trekk.perDato.map(([dato, b]) => ({ dato, belop: b })),
    sum_forskuddstrekk: trekk.perDato.reduce((x, [, b]) => x + b, 0),
    arbeidsgiveravgift: sumAvgift(avgift),
    avgiftsgrunnlag: avgift,
    mottakere: g.arbeidsforhold
      .map((f) => ({
        ansatt_id: f.id,
        navn: f.navn,
        ansattnummer: f.ansattnummer,
        inntekter: inn.get(f.id) ?? [],
        forskuddstrekk: trekk.perAnsatt.get(f.id) ?? 0,
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
    x.sisteDatoForStillingsprosentendring = f.siste_stillingsendring ?? f.ansatt_fra;
  }
  if (f.ansatt_til && f.aarsak_sluttdato) x.aarsakTilSluttdato = f.aarsak_sluttdato;
  if (!frilanser) x.formForAnsettelse = FORM[f.ansettelsestype] ?? "fast";
  return x;
}

// Leveransen som JSON til API-et ({"leveranse": …}).
export function byggLeveranse(g: Grunnlag, v: Byggevalg) {
  if (!g.org.orgnr) throw new Error("Organisasjonen mangler organisasjonsnummer");
  if (!g.virksomhet) throw new Error("Virksomheten mangler organisasjonsnummer");
  const inn = inntekter(g.slipper);
  const trekk = forskuddstrekk(g.slipper);
  const avgift = avgiftsgrunnlag(g.slipper, g.sone);
  const mottakere = g.arbeidsforhold
    .map((f) => {
      const fnr = v.fnr(f.id);
      if (!fnr) throw new Error(`${f.navn} mangler fødselsnummer`);
      const x: Record<string, unknown> = { norskIdentifikator: fnr, arbeidsforhold: [arbeidsforhold(f, g)] };
      const t = trekk.perAnsatt.get(f.id) ?? 0;
      if (t) x.forskuddstrekk = [{ beloep: -t }];
      const i = inn.get(f.id) ?? [];
      if (i.length)
        x.inntekt = i.map((y) => ({
          fordel: "kontantytelse",
          utloeserArbeidsgiveravgift: y.aga,
          inngaarIGrunnlagForTrekk: y.trekk,
          beloep: belop(y.belop),
          arbeidsforholdId: String(f.ansattnummer),
          loennsinntekt: y.antall != null && y.antall > 0 ? { beskrivelse: y.beskrivelse, antall: desimal(y.antall) } : { beskrivelse: y.beskrivelse },
        }));
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
  if (g.slipper.length) {
    const betaling: Record<string, unknown> = { sumArbeidsgiveravgift: sumAvgift(avgift) };
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
