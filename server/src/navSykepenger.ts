// Sykepenger fra NAV i workeren (0079_nav_sykepenger.sql, docs/nav.md): sykmeldingene NAV sender
// til arbeidsgiveren hentes for hver virksomhet med systembrukeren i Altinn (tilgangspakken «Lønn
// med personopplysninger av særlig kategori») og scopet nav:helseytelser/sykepenger, fra siste
// løpenummer. Fødselsnummeret kobles til den ansatte (bare workeren dekrypterer fødselsnumrene) og
// lagres ikke. En sykmelding (hel eller gradert) gir fravær for dagene som ikke alt er registrert;
// det som lederen bør se på (annet fravær i perioden, en ukjent ansatt), står som merknader, og
// eier og administrator får varsel.
//
// NAVs forespørsler om inntektsmelding hentes på samme måte (de nye fra siste løpenummer, og
// statusen på dem som venter), med inntekten i a-ordningen de tre månedene før inntektsdatoen.
// Inntektsmeldingen sendes fra workeren (navInntektsmelding.ts), og statusen hentes til NAV har
// godkjent eller avvist den.
// https://github.com/navikt/sykepenger-im-lps-api
import { alle, en, somSystem, type Db } from "./db.js";
import { config } from "./config.js";
import { dekrypter } from "./kryptering.js";
import { adresser, EtatFeil, etatKall, hentToken, SCOPE } from "./maskinporten.js";
import { NAV_SYKEPENGER } from "./altinn.js";
import { harPakke, hentTilgang, melding } from "./skattekort.js";
import { leggIKo } from "./tjenester.js";
import { pluss } from "./lonnsberegning.js";
import { fritekst, inntektsmeldingSkjema, tilNav } from "./navInntektsmelding.js";

const logg = (severity: string, message: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ severity, message, ...data }));
const visDato = (d: string) => d.split("-").reverse().join(".");
const MAKS = 1000; // NAV gir høyst så mange om gangen

export type Sykmeldingsperiode = { fom: string; tom: string; grad: number; type: "full" | "gradert" | "avventende" | "behandlingsdager" | "reisetilskudd"; reisetilskudd: boolean };
export type Sykmelding = {
  loepenr: number;
  sykmeldingId: string;
  fnr: string | null;
  navn: string | null;
  sykefravaerFom: string | null;
  mottattAvNav: string | null;
  sendtTilArbeidsgiver: string | null;
  perioder: Sykmeldingsperiode[];
  egenmeldingsdager: { fom: string; tom: string }[];
  meldingTilArbeidsgiver: string | null;
  tiltakArbeidsplassen: string | null;
  behandler: string | null;
};

const dato = (x: unknown) => (typeof x === "string" && /^\d{4}-\d{2}-\d{2}/.test(x) ? x.slice(0, 10) : null);
const tekst = (x: unknown, maks: number) => (typeof x === "string" && x.trim() ? x.trim().slice(0, maks) : null);

// Sykmeldingen slik NAV gir den (feltene kan ligge rett i objektet eller under «sykmelding»).
export function tolkSykmelding(r: any): Sykmelding | null {
  const s = r?.sykmelding ?? r?.arbeidsgiverSykmelding ?? r;
  const id = r?.sykmeldingId ?? r?.id ?? s?.sykmeldingId ?? s?.id;
  if (!id) return null;
  const perioder: Sykmeldingsperiode[] = (s?.sykmeldingPerioder ?? s?.perioder ?? [])
    .map((p: any) => {
      const fom = dato(p?.fom);
      const tom = dato(p?.tom);
      if (!fom || !tom) return null;
      const a = p?.aktivitet ?? p;
      const gradert = a?.gradertSykmelding;
      if (gradert) {
        const grad = Math.round(Number(gradert.sykmeldingsgrad ?? gradert.grad ?? 100));
        return { fom, tom, grad: grad >= 1 && grad <= 100 ? grad : 100, type: grad >= 100 ? "full" : "gradert", reisetilskudd: Boolean(gradert.harReisetilskudd) };
      }
      if (a?.avventendeSykmelding) return { fom, tom, grad: 0, type: "avventende", reisetilskudd: false };
      if (a?.antallBehandlingsdagerUke != null || a?.behandlingsdager != null) return { fom, tom, grad: 0, type: "behandlingsdager", reisetilskudd: false };
      if (a?.harReisetilskudd === true || a?.reisetilskudd === true) return { fom, tom, grad: 0, type: "reisetilskudd", reisetilskudd: true };
      return { fom, tom, grad: 100, type: "full", reisetilskudd: false };
    })
    .filter(Boolean)
    .sort((x: Sykmeldingsperiode, y: Sykmeldingsperiode) => x.fom.localeCompare(y.fom));
  const sykmeldt = s?.sykmeldt ?? r?.sykmeldt ?? {};
  const oppfolging = s?.oppfoelging ?? s?.oppfolging ?? {};
  const behandler = s?.behandler ?? null;
  return {
    loepenr: Number(r?.loepenr ?? s?.loepenr ?? 0),
    sykmeldingId: String(id),
    fnr: typeof sykmeldt.fnr === "string" ? sykmeldt.fnr.replace(/\s/g, "") : null,
    navn: tekst(sykmeldt.navn, 200),
    sykefravaerFom: dato(s?.sykefravaerFom) ?? perioder[0]?.fom ?? null,
    mottattAvNav: typeof s?.mottattAvNav === "string" ? s.mottattAvNav : null,
    sendtTilArbeidsgiver: typeof s?.sendtTilArbeidsgiver === "string" ? s.sendtTilArbeidsgiver : null,
    perioder,
    egenmeldingsdager: (s?.egenmeldingsdager ?? []).map((e: any) => ({ fom: dato(e?.fom), tom: dato(e?.tom) })).filter((e: any) => e.fom && e.tom),
    meldingTilArbeidsgiver: tekst(oppfolging.meldingTilArbeidsgiver, 4000),
    tiltakArbeidsplassen: tekst(oppfolging.tiltakArbeidsplassen, 4000),
    behandler: behandler ? tekst([behandler.navn, behandler.tlf].filter(Boolean).join(", "), 300) : null,
  };
}

const PERIODETEKST: Record<Sykmeldingsperiode["type"], string> = {
  full: "100 %",
  gradert: "gradert",
  avventende: "avventende sykmelding",
  behandlingsdager: "behandlingsdager",
  reisetilskudd: "reisetilskudd",
};
export const periodeTekst = (p: Sykmeldingsperiode) =>
  `${visDato(p.fom)}–${visDato(p.tom)} (${p.type === "gradert" ? `${p.grad} %` : PERIODETEKST[p.type]})`;

const FRAVAERSTYPE: Record<string, string> = { ferie: "ferie", permisjon: "permisjon", kurs: "kurs", avspasering: "avspasering", annet: "annet fravær", syk: "sykefravær", sykt_barn: "sykt barn" };

// Fraværet for sykmeldingen: dagene i periodene (hel eller gradert) og egenmeldingsdagene før den,
// som ikke alt har fravær. Gir id-ene og merknadene (annet fravær i perioden, utenfor ansettelsen).
export async function registrerFravaer(org: string, ansattId: string, sykmeldingRad: string, s: Sykmelding): Promise<{ ider: string[]; merknader: string[] }> {
  const ider: string[] = [];
  const merknader: string[] = [];
  const perioder = [
    ...s.egenmeldingsdager.map((e) => ({ fom: e.fom, tom: e.tom, grad: 100, dokumentasjon: "egenmelding" as const, type: "full" as const })),
    ...s.perioder.filter((x) => x.type === "full" || x.type === "gradert").map((x) => ({ ...x, dokumentasjon: "sykmelding" as const })),
  ];
  for (const p of perioder) {
    const eksisterende = await somSystem((db) =>
      alle<{ type: string; fra: string; til: string }>(
        db,
        `select type, to_char(fra, 'YYYY-MM-DD') as fra, to_char(til, 'YYYY-MM-DD') as til from faktura.fravaer
          where org_id = $1 and ansatt_id = $2 and til >= $3 and fra <= $4 and prosent is null order by fra`,
        [org, ansattId, p.fom, p.tom],
      ),
    );
    const ledige: [string, string][] = [];
    let start = p.fom;
    for (const e of eksisterende) {
      if (e.fra > start) ledige.push([start, pluss(e.fra, -1) < p.tom ? pluss(e.fra, -1) : p.tom]);
      if (e.type !== "syk") merknader.push(`Den ansatte har ${FRAVAERSTYPE[e.type] ?? e.type} ${visDato(e.fra)}–${visDato(e.til)} i sykmeldingsperioden.`);
      if (pluss(e.til, 1) > start) start = pluss(e.til, 1);
    }
    if (start <= p.tom) ledige.push([start, p.tom]);
    for (const [fra, til] of ledige) {
      try {
        const r = await somSystem((db) =>
          en<{ id: string }>(
            db,
            `insert into faktura.fravaer (org_id, ansatt_id, type, fra, til, notat, dokumentasjon, sykmeldingsgrad, nav_sykmelding)
             values ($1, $2, 'syk', $3, $4, $5, $6, $7, $8) returning id`,
            [
              org,
              ansattId,
              fra,
              til,
              p.dokumentasjon === "egenmelding" ? "Egenmelding (fra sykmeldingen hos NAV)" : "Sykmelding fra NAV",
              p.dokumentasjon,
              p.type === "gradert" && p.grad < 100 ? p.grad : null,
              sykmeldingRad,
            ],
          ),
        );
        if (r) ider.push(r.id);
      } catch (e) {
        merknader.push(`Fraværet ${visDato(fra)}–${visDato(til)} ble ikke registrert: ${melding(e)}`);
      }
    }
  }
  return { ider, merknader };
}

// Fødselsnumrene til de ansatte i organisasjonen (dekryptert, bare i workeren).
async function ansatteEtterFnr(org: string): Promise<Map<string, { id: string; navn: string }>> {
  const rader = await somSystem((db) =>
    alle<{ id: string; navn: string; fnr_kryptert: Buffer }>(
      db,
      "select id, fornavn || ' ' || etternavn as navn, fnr_kryptert from faktura.ansatte where org_id = $1 and fnr_kryptert is not null",
      [org],
    ),
  );
  const m = new Map<string, { id: string; navn: string }>();
  for (const r of rader) m.set((await dekrypter(r.fnr_kryptert)).replace(/\s/g, ""), { id: r.id, navn: r.navn });
  return m;
}

// Varsel til eier og administrator.
async function varsle(org: string, tittel: string, tekst: string, url: string, tag: string) {
  const mottakere = await somSystem((db) => alle<{ bruker_id: string }>(db, "select bruker_id from faktura.medlemmer where org_id = $1 and rolle in ('eier', 'admin')", [org]));
  if (mottakere.length)
    await leggIKo({ type: "varsel", varsel: { hendelse: "fravaer", org_id: org, bruker_ider: mottakere.map((m) => m.bruker_id), tittel, tekst, url, tag } }).catch(() => undefined);
}

async function henting(org: string, type: "sykmelding" | "forespoersel", virksomhet: string) {
  return (
    (await somSystem((db) =>
      en<{ siste_loepenr: number }>(db, "select siste_loepenr::float8 as siste_loepenr from faktura.nav_henting where org_id = $1 and type = $2 and virksomhet_orgnr = $3", [
        org,
        type,
        virksomhet,
      ]),
    ))?.siste_loepenr ?? 0
  );
}
async function lagreHenting(org: string, type: string, virksomhet: string, siste: number, feil: string | null) {
  await somSystem((db) =>
    db.query(
      `insert into faktura.nav_henting (org_id, type, virksomhet_orgnr, siste_loepenr, sist_hentet, siste_feil) values ($1, $2, $3, $4, now(), $5)
       on conflict (org_id, type, virksomhet_orgnr) do update set siste_loepenr = greatest(faktura.nav_henting.siste_loepenr, excluded.siste_loepenr),
         sist_hentet = now(), siste_feil = excluded.siste_feil`,
      [org, type, virksomhet, siste, feil],
    ),
  );
}

// Sykmeldingene for en virksomhet etter siste løpenummer. Gir antallet nye.
export async function hentSykmeldinger(org: string, virksomhet: string, token: string, ansatte: () => Promise<Map<string, { id: string; navn: string }>>): Promise<number> {
  let siste = await henting(org, "sykmelding", virksomhet);
  let nye = 0;
  for (;;) {
    const r = await etatKall(`${adresser().nav}/v1/sykmeldinger`, token, { metode: "POST", kropp: { orgnr: virksomhet, ...(siste > 0 ? { fraLoepenr: siste } : {}) }, hvem: "NAV" });
    if (r.status >= 300) throw navFeil(r);
    const liste: any[] = Array.isArray(r.data) ? r.data : Array.isArray(r.data?.sykmeldinger) ? r.data.sykmeldinger : [];
    const sykmeldinger = liste.map(tolkSykmelding).filter((s): s is Sykmelding => Boolean(s) && s!.loepenr > siste).sort((a, b) => a.loepenr - b.loepenr);
    for (const s of sykmeldinger) {
      if (await lagreSykmelding(org, virksomhet, s, ansatte)) nye++;
      siste = Math.max(siste, s.loepenr);
      await lagreHenting(org, "sykmelding", virksomhet, siste, null);
    }
    if (liste.length < MAKS || !sykmeldinger.length) break;
  }
  await lagreHenting(org, "sykmelding", virksomhet, siste, null);
  return nye;
}

// Lagrer sykmeldingen (én gang), registrerer fraværet og varsler. Gir om den var ny.
async function lagreSykmelding(org: string, virksomhet: string, s: Sykmelding, ansatte: () => Promise<Map<string, { id: string; navn: string }>>): Promise<boolean> {
  const ansatt = s.fnr ? ((await ansatte()).get(s.fnr) ?? null) : null;
  const navn = ansatt?.navn ?? s.navn ?? "Ukjent ansatt";
  const rad = await somSystem((db) =>
    en<{ id: string }>(
      db,
      `insert into faktura.nav_sykmeldinger (org_id, sykmelding_id, loepenr, virksomhet_orgnr, ansatt_id, navn, sykefravaer_fom, mottatt_av_nav, sendt_til_arbeidsgiver,
                                            perioder, egenmeldingsdager, melding_til_arbeidsgiver, tiltak_arbeidsplassen, behandler)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       on conflict (org_id, sykmelding_id) do nothing returning id`,
      [
        org,
        s.sykmeldingId,
        s.loepenr,
        virksomhet,
        ansatt?.id ?? null,
        navn,
        s.sykefravaerFom,
        s.mottattAvNav,
        s.sendtTilArbeidsgiver,
        JSON.stringify(s.perioder),
        JSON.stringify(s.egenmeldingsdager),
        s.meldingTilArbeidsgiver,
        s.tiltakArbeidsplassen,
        s.behandler,
      ],
    ),
  );
  if (!rad) return false;
  const merknader: string[] = [];
  let ider: string[] = [];
  if (!ansatt) merknader.push("Den sykmeldte er ikke registrert som ansatt med fødselsnummer her. Legg inn fødselsnummeret på den ansatte, og registrer fraværet.");
  else {
    const f = await registrerFravaer(org, ansatt.id, rad.id, s);
    ider = f.ider;
    merknader.push(...f.merknader);
  }
  for (const p of s.perioder.filter((x) => x.type !== "full" && x.type !== "gradert"))
    merknader.push(`${visDato(p.fom)}–${visDato(p.tom)}: ${PERIODETEKST[p.type]}; ikke registrert som fravær.`);
  await somSystem((db) => db.query("update faktura.nav_sykmeldinger set fravaer = $2, merknader = $3 where id = $1", [rad.id, ider, merknader]));
  const perioder = s.perioder.map(periodeTekst).join(", ");
  await varsle(org, "Ny sykmelding fra NAV", `${navn}: ${perioder || "uten perioder"}.${merknader.length ? " Se merknadene i appen." : ""}`, "/lonn?fane=sykepenger", `sykmelding-${rad.id}`);
  logg("INFO", "Sykmelding fra NAV", { org_id: org, ny: true, perioder: s.perioder.length, ansatt: Boolean(ansatt) });
  return true;
}

// Feilen fra NAV ({feilkode, feilmelding}); et fødselsnummer skjules av melding().
export function navFeil(r: { status: number; data: any; tekst: string }): EtatFeil {
  const d = r.data;
  const tekst = (typeof d?.feilmelding === "string" && d.feilmelding) || (typeof d?.message === "string" && d.message) || (typeof d?.title === "string" && d.title) || `NAV svarte ${r.status}`;
  const kode = typeof d?.feilkode === "string" ? d.feilkode : null;
  return new EtatFeil(`${tekst}${kode ? ` (${kode})` : ""}`, r.status, kode);
}

// Henter fra NAV for organisasjonen: sykmeldingene og forespørslene for hver virksomhet.
export async function hentFraNav(org: string) {
  if (!config.navSykepenger) return;
  const t = await hentTilgang(org);
  if (!t?.orgnr || !harPakke(t, NAV_SYKEPENGER)) return;
  const virksomheter = await somSystem((db) =>
    alle<{ orgnr: string }>(db, "select virksomhet_orgnr as orgnr from faktura.lonn_oppsett where org_id = $1 and virksomhet_orgnr is not null", [org]),
  );
  if (!virksomheter.length) return;
  let cache: Promise<Map<string, { id: string; navn: string }>> | null = null;
  const ansatte = () => (cache ??= ansatteEtterFnr(org));
  let token: string;
  try {
    token = await hentToken(SCOPE.nav, t.orgnr);
  } catch (e) {
    for (const v of virksomheter) for (const type of TYPER) await lagreHenting(org, type, v.orgnr, 0, melding(e));
    logg("WARNING", "Token til NAV ble ikke hentet", { org_id: org, feil: melding(e) });
    return;
  }
  for (const v of virksomheter) {
    try {
      await hentSykmeldinger(org, v.orgnr, token, ansatte);
    } catch (e) {
      await lagreHenting(org, "sykmelding", v.orgnr, 0, melding(e));
      logg("WARNING", "Sykmeldingene ble ikke hentet fra NAV", { org_id: org, feil: melding(e) });
    }
    try {
      await hentForespoersler(org, v.orgnr, token, ansatte);
      await oppdaterForespoersler(org, v.orgnr, token);
    } catch (e) {
      await lagreHenting(org, "forespoersel", v.orgnr, 0, melding(e));
      logg("WARNING", "Forespørslene ble ikke hentet fra NAV", { org_id: org, feil: melding(e) });
    }
  }
  try {
    await sjekkInntektsmeldinger(org, token);
  } catch (e) {
    logg("WARNING", "Statusen på inntektsmeldingene ble ikke hentet fra NAV", { org_id: org, feil: melding(e) });
  }
}

const TYPER = ["sykmelding", "forespoersel"] as const;

// --- Forespørsler om inntektsmelding ---------------------------------------------------------

export type Forespoersel = {
  loepenr: number;
  navReferanseId: string;
  fnr: string | null;
  status: "AKTIV" | "BESVART" | "FORKASTET";
  data: {
    sykmeldingsperioder: { fom: string; tom: string }[];
    egenmeldingsperioder: { fom: string; tom: string }[];
    inntektsdato: string | null;
    arbeidsgiverperiodePaakrevd: boolean;
    inntektPaakrevd: boolean;
    opprettetTid: string | null;
  };
};

const perioder = (x: unknown) =>
  (Array.isArray(x) ? x : [])
    .map((p: any) => ({ fom: dato(p?.fom), tom: dato(p?.tom) }))
    .filter((p): p is { fom: string; tom: string } => Boolean(p.fom && p.tom))
    .sort((a, b) => a.fom.localeCompare(b.fom));

// Forespørselen slik NAV gir den. Mangler flaggene, regnes arbeidsgiverperioden og inntekten som
// påkrevd.
export function tolkForespoersel(r: any): Forespoersel | null {
  const id = r?.navReferanseId;
  if (typeof id !== "string" || !id) return null;
  return {
    loepenr: Number(r.loepenr ?? 0),
    navReferanseId: id,
    fnr: typeof r.fnr === "string" ? r.fnr.replace(/\s/g, "") : null,
    status: r.status === "BESVART" || r.status === "FORKASTET" ? r.status : "AKTIV",
    data: {
      sykmeldingsperioder: perioder(r.sykmeldingsperioder),
      egenmeldingsperioder: perioder(r.egenmeldingsperioder),
      inntektsdato: dato(r.inntektsdato),
      arbeidsgiverperiodePaakrevd: r.arbeidsgiverperiodePaakrevd !== false,
      inntektPaakrevd: r.inntektPaakrevd !== false,
      opprettetTid: typeof r.opprettetTid === "string" ? r.opprettetTid : null,
    },
  };
}

// De nye forespørslene for en virksomhet etter siste løpenummer. Gir antallet nye.
export async function hentForespoersler(org: string, virksomhet: string, token: string, ansatte: () => Promise<Map<string, { id: string; navn: string }>>): Promise<number> {
  let siste = await henting(org, "forespoersel", virksomhet);
  let nye = 0;
  for (;;) {
    const r = await etatKall(`${adresser().nav}/v1/forespoersler`, token, { metode: "POST", kropp: { orgnr: virksomhet, ...(siste > 0 ? { fraLoepenr: siste } : {}) }, hvem: "NAV" });
    if (r.status >= 300) throw navFeil(r);
    const liste: any[] = Array.isArray(r.data) ? r.data : [];
    const forespoersler = liste.map(tolkForespoersel).filter((f): f is Forespoersel => Boolean(f) && f!.loepenr > siste).sort((a, b) => a.loepenr - b.loepenr);
    for (const f of forespoersler) {
      if (await lagreForespoersel(org, virksomhet, f, ansatte, token)) nye++;
      siste = Math.max(siste, f.loepenr);
      await lagreHenting(org, "forespoersel", virksomhet, siste, null);
    }
    if (liste.length < MAKS || !forespoersler.length) break;
  }
  await lagreHenting(org, "forespoersel", virksomhet, siste, null);
  return nye;
}

// Lagrer forespørselen (ny, eller ny status), henter inntekten i a-ordningen for en ny, og varsler.
// Gir om den var ny.
async function lagreForespoersel(
  org: string,
  virksomhet: string,
  f: Forespoersel,
  ansatte: () => Promise<Map<string, { id: string; navn: string }>>,
  token: string,
): Promise<boolean> {
  const ansatt = f.fnr ? ((await ansatte()).get(f.fnr) ?? null) : null;
  const rad = await somSystem((db) =>
    en<{ id: string; ny: boolean }>(
      db,
      `insert into faktura.nav_forespoersler (org_id, nav_referanse_id, loepenr, virksomhet_orgnr, ansatt_id, navn, status, data)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (org_id, nav_referanse_id) do update set status = excluded.status, loepenr = excluded.loepenr,
         ansatt_id = coalesce(faktura.nav_forespoersler.ansatt_id, excluded.ansatt_id),
         data = excluded.data || jsonb_strip_nulls(jsonb_build_object('inntekt', faktura.nav_forespoersler.data->'inntekt'))
       returning id, (xmax = 0) as ny`,
      [org, f.navReferanseId, f.loepenr, virksomhet, ansatt?.id ?? null, ansatt?.navn ?? null, f.status, JSON.stringify(f.data)],
    ),
  );
  if (!rad?.ny) return false;
  if (f.status === "AKTIV" && f.data.inntektPaakrevd && f.data.inntektsdato) await hentInntekt(org, rad.id, f.navReferanseId, f.data.inntektsdato, token);
  if (f.status === "AKTIV") {
    const navn = ansatt?.navn ?? "En ansatt som ikke er registrert med fødselsnummer";
    const p = f.data.sykmeldingsperioder.map((x) => `${visDato(x.fom)}–${visDato(x.tom)}`).join(", ");
    await varsle(
      org,
      "NAV ber om inntektsmelding",
      `${navn}${p ? ` (sykmeldt ${p})` : ""}. Send inntektsmeldingen fra appen.`,
      `/lonn?fane=sykepenger&foresporsel=${rad.id}`,
      `forespoersel-${rad.id}`,
    );
  }
  logg("INFO", "Forespørsel om inntektsmelding fra NAV", { org_id: org, status: f.status, ansatt: Boolean(ansatt) });
  return true;
}

// Inntekten i a-ordningen de tre månedene før inntektsdatoen (det NAV sammenligner med).
export async function hentInntekt(org: string, id: string, navReferanseId: string, inntektsdato: string, token: string) {
  try {
    const r = await etatKall(`${adresser().nav}/v1/inntekt?navReferanseId=${encodeURIComponent(navReferanseId)}&inntektsdato=${inntektsdato}`, token, { hvem: "NAV" });
    if (r.status >= 300) throw navFeil(r);
    const perMaaned: Record<string, number | null> = {};
    for (const [m, v] of Object.entries(r.data?.inntektPerMaaned ?? {})) if (/^\d{4}-\d{2}$/.test(m)) perMaaned[m] = v == null ? null : Number(v);
    const snitt = Number(r.data?.gjennomsnittAvMaaneder ?? NaN);
    if (!Number.isFinite(snitt)) return;
    await somSystem((db) =>
      db.query("update faktura.nav_forespoersler set data = data || jsonb_build_object('inntekt', $2::jsonb) where id = $1", [
        id,
        JSON.stringify({ inntektsdato, perMaaned, snitt }),
      ]),
    );
  } catch (e) {
    logg("WARNING", "Inntekten ble ikke hentet fra NAV", { org_id: org, feil: melding(e) });
  }
}

// Statusen på forespørslene som venter: NAV gir de aktive; de andre er besvart eller trukket
// tilbake (de hentes én og én).
export async function oppdaterForespoersler(org: string, virksomhet: string, token: string) {
  const lokale = await somSystem((db) =>
    alle<{ id: string; nav_referanse_id: string }>(
      db,
      "select id, nav_referanse_id from faktura.nav_forespoersler where org_id = $1 and virksomhet_orgnr = $2 and status = 'AKTIV'",
      [org, virksomhet],
    ),
  );
  if (!lokale.length) return;
  const aktive = new Set<string>();
  let fra = 0;
  for (;;) {
    const r = await etatKall(`${adresser().nav}/v1/forespoersler`, token, {
      metode: "POST",
      kropp: { orgnr: virksomhet, status: "AKTIV", ...(fra > 0 ? { fraLoepenr: fra } : {}) },
      hvem: "NAV",
    });
    if (r.status >= 300) throw navFeil(r);
    const liste = (Array.isArray(r.data) ? r.data : []).map(tolkForespoersel).filter((f): f is Forespoersel => Boolean(f));
    for (const f of liste) aktive.add(f.navReferanseId);
    if (liste.length < MAKS) break;
    fra = Math.max(...liste.map((f) => f.loepenr));
  }
  for (const l of lokale.filter((x) => !aktive.has(x.nav_referanse_id))) {
    const r = await etatKall(`${adresser().nav}/v1/forespoersel/${encodeURIComponent(l.nav_referanse_id)}`, token, { hvem: "NAV" });
    if (r.status >= 300) {
      logg("WARNING", "Forespørselen ble ikke hentet fra NAV", { org_id: org, status: r.status });
      continue;
    }
    const f = tolkForespoersel(r.data);
    if (!f || f.status === "AKTIV") continue;
    await somSystem((db) => db.query("update faktura.nav_forespoersler set status = $2 where id = $1", [l.id, f.status]));
  }
}

// --- Inntektsmeldingen ----------------------------------------------------------------------

const VALIDERINGSFEIL: Record<string, string> = {
  INNTEKT_AVVIKER_FRA_A_ORDNINGEN:
    "Inntekten avviker mer enn 1 000 kr fra snittet i a-ordningen. Bruk snittet, eller oppgi årsaken til endringen (f.eks. varig lønnsendring), og send på nytt.",
  DUPLIKAT: "NAV har fått den samme inntektsmeldingen før.",
  TEKNISK_FEIL: "Teknisk feil hos NAV. Send inntektsmeldingen på nytt.",
};

async function settInntektsmelding(id: string, felt: Record<string, unknown>) {
  const navn = Object.keys(felt);
  await somSystem((db) => db.query(`update faktura.nav_inntektsmeldinger set ${navn.map((n, i) => `${n} = $${i + 2}`).join(", ")} where id = $1`, [id, ...Object.values(felt)]));
}

// Workeren sender inntektsmeldingen: forespørselen hentes på nytt (status og fødselsnummer), og
// meldingen sendes som ny eller som korrigering. NAV kjenner igjen en inntektsmelding som er sendt
// før (409 med den som finnes), så et nytt forsøk gir ikke to.
export async function sendInntektsmelding(org: string, id: string) {
  const m = await somSystem((db) =>
    en<{ id: string; status: string; innhold: unknown; ansatt_id: string | null; nav_referanse_id: string; forespoersel_id: string; navn: string | null }>(
      db,
      `select m.id, m.status, m.innhold, m.ansatt_id, f.nav_referanse_id, f.id as forespoersel_id, coalesce(a.fornavn || ' ' || a.etternavn, f.navn) as navn
         from faktura.nav_inntektsmeldinger m join faktura.nav_forespoersler f on f.id = m.forespoersel_id
         left join faktura.ansatte a on a.org_id = m.org_id and a.id = m.ansatt_id
        where m.org_id = $1 and m.id = $2`,
      [org, id],
    ),
  );
  if (!m || m.status !== "sender") return;
  const feil = async (tekst: string) => {
    await settInntektsmelding(m.id, { status: "feil", feil: tekst.slice(0, 2000) });
    await varsle(org, "Inntektsmeldingen ble ikke sendt", `${m.navn ?? "Den ansatte"}: ${tekst}`, `/lonn?fane=sykepenger&foresporsel=${m.forespoersel_id}`, `inntektsmelding-${m.id}`);
    logg("WARNING", "Inntektsmeldingen ble ikke sendt", { org_id: org, feil: tekst });
  };
  if (!config.navSykepenger) return feil("Innsendingen til NAV er ikke slått på.");
  const t = await hentTilgang(org);
  if (!t?.orgnr || !harPakke(t, NAV_SYKEPENGER)) return feil("Tilgangen hos NAV i Altinn mangler (tilgangspakken «Lønn med personopplysninger av særlig kategori»).");
  const a = await somSystem((db) => en<{ fnr_kryptert: Buffer | null }>(db, "select fnr_kryptert from faktura.ansatte where org_id = $1 and id = $2", [org, m.ansatt_id]));
  if (!a?.fnr_kryptert) return feil("Den ansatte mangler fødselsnummer.");
  const fnr = (await dekrypter(a.fnr_kryptert)).replace(/\s/g, "");
  const innhold = inntektsmeldingSkjema.safeParse(m.innhold);
  if (!innhold.success) return feil(`Inntektsmeldingen er ikke gyldig: ${innhold.error.issues[0]?.message ?? "ukjent feil"}`);
  try {
    const token = await hentToken(SCOPE.nav, t.orgnr);
    const fr = await etatKall(`${adresser().nav}/v1/forespoersel/${encodeURIComponent(m.nav_referanse_id)}`, token, { hvem: "NAV" });
    if (fr.status >= 300) return feil(navFeil(fr).message);
    const f = tolkForespoersel(fr.data);
    if (!f) return feil("NAV ga ikke forespørselen.");
    await somSystem((db) =>
      db.query("update faktura.nav_forespoersler set status = $2, data = $3::jsonb || jsonb_strip_nulls(jsonb_build_object('inntekt', data->'inntekt')) where id = $1", [
        m.forespoersel_id,
        f.status,
        JSON.stringify(f.data),
      ]),
    );
    if (f.status === "FORKASTET") return feil("NAV har trukket tilbake forespørselen (det kommer som regel en ny for sykefraværet).");
    if (f.fnr && f.fnr !== fnr) return feil("Fødselsnummeret til den ansatte er ikke det samme som i forespørselen fra NAV.");
    const aarsak = f.status === "BESVART" ? "Endring" : "Ny";
    const avsender = { systemNavn: fritekst(config.altinnSystemnavn) ?? "HI4 Faktura", systemVersjon: fritekst(process.env.K_REVISION) ?? "1.0" };
    await settInntektsmelding(m.id, { forsok_at: new Date(), aarsak });
    const r = await etatKall(`${adresser().nav}/v1/inntektsmelding`, token, { metode: "POST", kropp: tilNav(innhold.data, m.nav_referanse_id, fnr, aarsak, avsender), hvem: "NAV" });
    let innsendingId: string | null = null;
    if (r.status === 200 || r.status === 201) innsendingId = typeof r.data?.innsendingId === "string" ? r.data.innsendingId : null;
    else if (r.status === 409 && r.data?.feilkode === "DUPLIKAT_INNSENDING") innsendingId = typeof r.data?.referanseId === "string" ? r.data.referanseId : null;
    else if (r.data?.feilkode === "INNSENDING_PAA_GAMMEL_FORESPOERSEL") {
      await leggIKo({ type: "nav-hent", org_id: org }).catch(() => undefined);
      return feil("NAV har en nyere forespørsel for sykefraværet. Den hentes nå; send inntektsmeldingen for den.");
    } else return feil(navFeil(r).message);
    await settInntektsmelding(m.id, { status: "sendt", innsending_id: innsendingId, sendt_at: new Date(), feil: null });
    logg("INFO", "Inntektsmelding sendt til NAV", { org_id: org, aarsak });
    // NAV kontrollerer den (vanligvis innen noen minutter): statusen hentes om to minutter.
    await leggIKo({ type: "nav-hent", org_id: org }, 120).catch(() => undefined);
  } catch (e) {
    return feil(melding(e));
  }
}

// Statusen på inntektsmeldingene NAV kontrollerer (sendt de siste 30 dagene).
export async function sjekkInntektsmeldinger(org: string, token: string) {
  const sendt = await somSystem((db) =>
    alle<{ id: string; innsending_id: string; forespoersel_id: string; navn: string | null }>(
      db,
      `select m.id, m.innsending_id, m.forespoersel_id, coalesce(a.fornavn || ' ' || a.etternavn, f.navn) as navn
         from faktura.nav_inntektsmeldinger m join faktura.nav_forespoersler f on f.id = m.forespoersel_id
         left join faktura.ansatte a on a.org_id = m.org_id and a.id = m.ansatt_id
        where m.org_id = $1 and m.status = 'sendt' and m.innsending_id is not null and m.sendt_at > now() - interval '30 days'`,
      [org],
    ),
  );
  for (const m of sendt) {
    const r = await etatKall(`${adresser().nav}/v1/inntektsmelding/${encodeURIComponent(m.innsending_id)}`, token, { hvem: "NAV" });
    if (r.status >= 300) {
      logg("WARNING", "Statusen på inntektsmeldingen ble ikke hentet", { org_id: org, status: r.status });
      continue;
    }
    const status = r.data?.status;
    const url = `/lonn?fane=sykepenger&foresporsel=${m.forespoersel_id}`;
    if (status === "GODKJENT") {
      await settInntektsmelding(m.id, { status: "godkjent", feil: null });
      await somSystem((db) => db.query("update faktura.nav_forespoersler set status = 'BESVART' where id = $1 and status = 'AKTIV'", [m.forespoersel_id]));
      await varsle(org, "NAV har godkjent inntektsmeldingen", `${m.navn ?? "Den ansatte"}: inntektsmeldingen er godkjent.`, url, `inntektsmelding-${m.id}`);
    } else if (status === "FEILET") {
      const v = r.data?.valideringsfeil ?? {};
      const tekst = VALIDERINGSFEIL[v.feilkode] ?? (typeof v.feilmelding === "string" && v.feilmelding ? v.feilmelding : "NAV avviste inntektsmeldingen.");
      await settInntektsmelding(m.id, { status: "avvist", feil: String(tekst).slice(0, 2000) });
      await varsle(org, "NAV avviste inntektsmeldingen", `${m.navn ?? "Den ansatte"}: ${tekst}`, url, `inntektsmelding-${m.id}`);
    }
  }
}

// Hvert minutt (hjerteslaget): organisasjonene som har gitt tilgang hos NAV og ikke er hentet for
// den siste timen, legges i kø.
export async function planleggNavHenting(): Promise<number> {
  if (!config.navSykepenger) return 0;
  const rader = await somSystem((db: Db) =>
    alle<{ org_id: string }>(
      db,
      `select t.org_id from faktura.skattekort_tilgang t join faktura.lonn_oppsett l on l.org_id = t.org_id
        where t.status = 'godkjent' and $1 = any(t.pakker) and l.aktiv and l.virksomhet_orgnr is not null
          and not exists (select 1 from faktura.nav_henting h where h.org_id = t.org_id and h.sist_hentet > now() - interval '1 hour')`,
      [NAV_SYKEPENGER],
    ),
  );
  for (const r of rader) {
    // Merkes først, så den ikke legges i kø hvert minutt mens den hentes.
    await somSystem((db) =>
      db.query(
        `insert into faktura.nav_henting (org_id, type, virksomhet_orgnr, sist_hentet)
         select l.org_id, t.type, l.virksomhet_orgnr, now() from faktura.lonn_oppsett l cross join (values ('sykmelding'), ('forespoersel')) t(type)
          where l.org_id = $1 and l.virksomhet_orgnr is not null
         on conflict (org_id, type, virksomhet_orgnr) do update set sist_hentet = now()`,
        [r.org_id],
      ),
    );
    await leggIKo({ type: "nav-hent", org_id: r.org_id });
  }
  return rader.length;
}
