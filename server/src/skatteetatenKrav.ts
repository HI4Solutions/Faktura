// Krav og betalinger og frister fra Skatteetaten i workeren (0112_skatteetaten_krav.sql,
// docs/skatteetaten-krav.md). Med systembrukeren organisasjonen har gitt systemet i Altinn
// (tilgangspakken «Krav, betalinger og utlegg») hentes, hver morgen, med en gang tilgangen er
// godkjent, og når appen ber om det («Hent nå»):
//
//   Krav og betalinger (scopet skatteetaten:kravogbetalinger): de åpne kravene (skatt og avgifter)
//   med forfallene og betalingsinformasjonen (konto og KID), innbetalingene som ikke er plassert,
//   og innbetalingene og utbetalingene det siste året (Skatteetaten gir høyst ett år om gangen).
//   Frister (skatteetaten:frister): fristene for mva-meldingen og skattemeldingen det neste året.
//
// Svarene tolkes til det appen viser, og lagres; det rå svaret lagres ikke. Ingen krav, betalinger
// eller frister (KB-007, KB-009, FRI-007) er et tomt svar, ikke en feil. Krav og frister hentes hver
// for seg, med hvert sitt token, så det ene kan virke selv om det andre ikke gjør det (f.eks. når
// bare det ene scopet er lagt på Maskinporten-klienten).
//
// Skatteetaten gir bare tilgang når leverandøren er integrert mot et API for innrapportering og
// organisasjonen har rapportert gjennom systemet minst én gang (f.eks. a-meldingen).
// https://skatteetaten.github.io/api-dokumentasjon/api/kravogbetalinger
// https://skatteetaten.github.io/api-dokumentasjon/api/frister
import { alle, somSystem } from "./db.js";
import { config } from "./config.js";
import { adresser, EtatFeil, etatKall, hentToken, SCOPE } from "./maskinporten.js";
import { KRAV_OG_UTLEGG } from "./altinn.js";
import { harPakke, hentTilgang, melding, skattFeil } from "./skattekort.js";
import { leggIKo } from "./tjenester.js";

const logg = (severity: string, message: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ severity, message, ...data }));

// --- Det appen viser -----------------------------------------------------------------------------

// Et forfall på et krav (et krav kan ha flere, f.eks. forskuddsskatten), med det som gjenstår og
// betalingsinformasjonen: kontonummeret og KID, og IBAN og BIC for betaling fra utlandet.
export type Forfall = {
  id: string | null;
  dato: string | null;
  opprinnelig: number;
  gjenstaaende: number;
  kontonummer: string | null;
  kid: string | null;
  iban: string | null;
  bic: string | null;
  bank: string | null;
};
export type Krav = {
  id: string;
  type: string | null; // kravtypen, f.eks. RESTSKATT
  beskrivelse: string; // kravbeskrivelsen på bokmål (ellers kravtypen)
  periode: string | null; // perioden kravet gjelder, f.eks. «2023/02» eller «Inntektsår 2023»
  gruppe: string | null; // kravgruppen, f.eks. Skatt eller Merverdiavgift
  opprinnelig: number;
  gjenstaaende: number;
  renter: number; // stipulerte renter (når kravet ikke er betalt ved forfall)
  opprettet: string | null;
  forfall: Forfall[];
};
export type Innbetaling = { id: string | null; dato: string | null; belop: number; uplassert: number; type: string | null; fra: string | null };
export type Utbetaling = { id: string | null; dato: string | null; belop: number; melding: string | null; status: string | null; konto: string | null };
// Summene: saldoen (det som skyldes etter innbetalingene som er plassert), forfalt og ikke forfalt,
// stipulerte renter og innbetalinger som ikke er plassert mot et krav.
export type Summer = { saldo: number; forfalt: number; ikke_forfalt: number; renter: number; uplassert: number };
export type Kravoversikt = {
  summer: Summer;
  grupper: (Omit<Summer, "uplassert"> & { gruppe: string })[];
  aapne: Krav[];
  uplasserte: Innbetaling[];
  innbetalinger: Innbetaling[];
  utbetalinger: Utbetaling[];
  periode: { fra: string; til: string }; // innbetalingene og utbetalingene
  skjermet: boolean;
};
export type Frist = { tittel: string; beskrivelse: string | null; type: string | null; frist: string; kilde: string | null };
export type Fristoversikt = { frister: Frist[]; kilder: { kilde: string; status: string }[] };

// --- Tolkingen av svarene ------------------------------------------------------------------------

const tall = (x: unknown) => {
  const n = typeof x === "number" ? x : typeof x === "string" && x.trim() ? Number(x.replace(",", ".")) : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
const sum = (xs: number[]) => Math.round(xs.reduce((s, x) => s + x, 0) * 100) / 100;
const dato = (x: unknown) => (typeof x === "string" && /^\d{4}-\d{2}-\d{2}/.test(x) ? x.slice(0, 10) : null);
const tekst = (x: unknown, maks = 300) => (typeof x === "string" && x.trim() ? x.trim().replace(/\s+/g, " ").slice(0, maks) : typeof x === "number" ? String(x) : null);
const liste = (x: unknown): any[] => (Array.isArray(x) ? x : []);
const ordet = (x: unknown) => tekst(x)?.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase()) ?? null;

// Teksten på bokmål ({spraakTekst: [{tekst, spraak}]}), ellers nynorsk eller den første.
export function spraak(x: unknown): string | null {
  if (typeof x === "string") return tekst(x);
  const t = liste((x as any)?.spraakTekst);
  const valgt = t.find((s) => s?.spraak === "nb") ?? t.find((s) => s?.spraak === "nn") ?? t[0];
  return tekst(valgt?.tekst);
}

// Perioden kravet gjelder: beskrivelsen (f.eks. «2023/02») og året når det står for seg.
const periode = (p: any) => {
  const deler = [spraak(p?.periodeBeskrivelse), tekst(p?.aar)].filter((x): x is string => !!x);
  return deler.length ? [...new Set(deler)].join(" ") : null;
};

// KID kan stå i betalingsinformasjonen eller på kontoen, med litt ulike navn.
function kid(b: any): string | null {
  for (const o of [b, b?.konto])
    if (o && typeof o === "object")
      for (const [k, v] of Object.entries(o)) if (/^kid/i.test(k) && tekst(v)) return tekst(v)!.replace(/\s/g, "");
  return null;
}

function tolkForfall(f: any): Forfall {
  const b = f?.betalingsinformasjon ?? {};
  const konto = b?.konto ?? {};
  return {
    id: tekst(f?.kravforfallsIdentifikator ?? f?.kravforfallidentifikator),
    dato: dato(f?.forfallsdato),
    opprinnelig: tall(f?.opprinneligBeloep),
    gjenstaaende: tall(f?.gjenstaaendeBeloep),
    kontonummer: tekst(konto?.kontonummer)?.replace(/[\s.]/g, "") ?? null,
    kid: kid(b),
    iban: tekst(konto?.iban)?.replace(/\s/g, "") ?? null,
    bic: tekst(konto?.swiftBIC ?? konto?.bic),
    bank: tekst(konto?.bankinformasjon),
  };
}

export function tolkKrav(k: any): Krav | null {
  const id = tekst(k?.kravidentifikator ?? k?.kravIdentifikator);
  if (!id) return null;
  const forfall = liste(k?.kravforfall)
    .map(tolkForfall)
    .sort((a, b) => (a.dato ?? "9999").localeCompare(b.dato ?? "9999"));
  return {
    id,
    type: tekst(k?.kravtype),
    beskrivelse: spraak(k?.kravbeskrivelse) ?? ordet(k?.kravtype) ?? "Krav",
    periode: periode(k?.kravperiode),
    gruppe: tekst(k?.kravgruppe),
    opprinnelig: tall(k?.opprinneligBeloep),
    gjenstaaende: tall(k?.gjenstaaendeBeloep),
    renter: tall(k?.stipulerteRenter),
    opprettet: dato(k?.opprettelsesdatoForKrav),
    forfall,
  };
}

export function tolkInnbetaling(i: any): Innbetaling {
  const fra = i?.innbetaltFra?.konto ?? i?.betaltFra?.konto ?? {};
  const navn = tekst(fra?.kontoeiersNavn, 120);
  const konto = tekst(fra?.kontonummer, 40);
  return {
    id: tekst(i?.innbetalingsidentifikator ?? i?.innbetalingsIdentifikator),
    dato: dato(i?.innbetalingsdato),
    belop: tall(i?.innbetaltBeloep),
    uplassert: tall(i?.uplassertBeloep),
    type: tekst(i?.innbetalingstype),
    fra: navn && konto ? `${navn} (${konto})` : (navn ?? konto),
  };
}

export function tolkUtbetaling(u: any): Utbetaling {
  return {
    id: tekst(u?.utbetalingsidentifikator ?? u?.utbetalingsIdentifikator),
    dato: dato(u?.utbetaltdato ?? u?.utbetalingsdato),
    belop: tall(u?.utbetaltBeloep),
    melding: tekst(u?.betaltTil?.meldingSendtTilMottaker),
    status: tekst(u?.utbetalingstatus ?? u?.utbetalingsstatus),
    konto: tekst(u?.betaltTil?.konto?.kontonummer, 40),
  };
}

// Summene slik Skatteetaten gir dem (totalOversikt og oversiktPerKravgruppe).
const summer = (o: any): Omit<Summer, "uplassert"> => ({
  saldo: tall(o?.saldo),
  forfalt: tall(o?.sumForfalteKrav),
  ikke_forfalt: tall(o?.sumIkkeForfalteKrav),
  renter: tall(o?.sumStipulerteRenter),
});

// Det neste forfallet på kravet som ikke er betalt (ellers det første).
export const nesteForfall = (k: Krav) => k.forfall.find((f) => f.gjenstaaende !== 0) ?? k.forfall[0] ?? null;

// Svarene fra Åpne krav, Innbetalinger og Utbetalinger til oversikten. Summene er Skatteetatens
// (totalOversikt og oversiktPerKravgruppe) når de er med; ellers regnes de ut fra kravene, med
// forfallene før i dag som forfalt.
export function tolkKravoversikt(aapne: any, inn: any, ut: any, p: { fra: string; til: string }, iDag: string): Kravoversikt {
  const krav = liste(aapne?.aapentKravMedGjenstaaendeBeloep ?? aapne?.krav)
    .map(tolkKrav)
    .filter((k): k is Krav => !!k);
  const uplasserte = liste(aapne?.innbetalingMedUplassertBeloep).map(tolkInnbetaling);
  const forfalt = (ks: Krav[]) => sum(ks.flatMap((k) => k.forfall.filter((f) => f.dato && f.dato < iDag).map((f) => f.gjenstaaende)));
  // Uten forfall: hele det som gjenstår regnes som ikke forfalt.
  const ikkeForfalt = (ks: Krav[]) => sum(ks.map((k) => (k.forfall.length ? sum(k.forfall.filter((f) => !f.dato || f.dato >= iDag).map((f) => f.gjenstaaende)) : k.gjenstaaende)));
  const renter = (ks: Krav[]) => sum(ks.map((k) => k.renter));
  const uplassert = sum(uplasserte.map((i) => i.uplassert));
  const total = aapne?.totalOversikt;
  const regnet = (ks: Krav[], u: number) => ({ saldo: sum([forfalt(ks), ikkeForfalt(ks), -u]), forfalt: forfalt(ks), ikke_forfalt: ikkeForfalt(ks), renter: renter(ks) });
  const grupperFra = liste(aapne?.oversiktPerKravgruppe).map((g) => ({ gruppe: tekst(g?.kravgruppe) ?? "Annet", ...summer(g) }));
  const navn = [...new Set(krav.map((k) => k.gruppe ?? "Annet"))];
  const forst = (k: Krav) => nesteForfall(k)?.dato ?? "9999";
  return {
    summer: total ? { ...summer(total), uplassert: tall(total?.sumUplasserteInnbetalinger ?? uplassert) } : { ...regnet(krav, uplassert), uplassert },
    grupper: grupperFra.length ? grupperFra : navn.map((g) => ({ gruppe: g, ...regnet(krav.filter((k) => (k.gruppe ?? "Annet") === g), 0) })),
    // De som forfaller først, øverst.
    aapne: krav.sort((a, b) => forst(a).localeCompare(forst(b))),
    uplasserte,
    innbetalinger: liste(inn?.innbetaling ?? inn?.innbetalinger)
      .map(tolkInnbetaling)
      .sort((a, b) => (b.dato ?? "").localeCompare(a.dato ?? "")),
    utbetalinger: liste(ut?.utbetaling ?? ut?.utbetalinger)
      .map(tolkUtbetaling)
      .sort((a, b) => (b.dato ?? "").localeCompare(a.dato ?? "")),
    periode: p,
    skjermet: Boolean(aapne?.skjermet),
  };
}

// Fristene ({kilder: [{frister: [...], kilde, status}], virksomhet}), de første først.
export function tolkFrister(d: any): Fristoversikt {
  const kilder = liste(d?.kilder);
  const frister = kilder
    .flatMap((k) =>
      liste(k?.frister).map((f): Frist | null => {
        const frist = dato(f?.frist);
        const tittel = tekst(f?.tittel) ?? tekst(f?.aktivitetsbeskrivelse);
        if (!frist || !tittel) return null;
        return { tittel, beskrivelse: tekst(f?.aktivitetsbeskrivelse, 600), type: tekst(f?.aktivitetstype), frist, kilde: tekst(k?.kilde) };
      }),
    )
    .filter((f): f is Frist => !!f)
    .sort((a, b) => a.frist.localeCompare(b.frist) || a.tittel.localeCompare(b.tittel, "nb"));
  return { frister, kilder: kilder.map((k) => ({ kilde: tekst(k?.kilde) ?? "ukjent", status: tekst(k?.status) ?? "OK" })) };
}

// --- Kallene til Skatteetaten --------------------------------------------------------------------

const osloIDag = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());
const pluss = (d: string, dager: number) => new Date(Date.parse(`${d}T12:00:00Z`) + dager * 86_400_000).toISOString().slice(0, 10);

// Svar som betyr at det ikke er noe å vise: ingen krav eller betalinger på organisasjonen og
// perioden (KB-007), ingen treff på organisasjonen (KB-009), ingen frister (FRI-007).
const INGEN = new Set(["KB-007", "KB-009", "FRI-007"]);

async function hent(url: string, token: string, hva: string): Promise<any | null> {
  const r = await etatKall(url, token, { hvem: "Skatteetaten" });
  if (r.status === 200) return r.data;
  if (r.status === 204) return null;
  const kode = typeof r.data?.kode === "string" ? r.data.kode : null;
  if (r.status === 404 && kode && INGEN.has(kode)) return null;
  // Tilgangen: tilgangspakken i Altinn, og at organisasjonen har rapportert gjennom systemet.
  if (r.status === 403)
    throw new EtatFeil(
      `${hva}: Skatteetaten avviste tilgangen (403${kode ? `, ${kode}` : ""}). Tilgangspakken «Krav, betalinger og utlegg» må være godkjent i Altinn, og Skatteetaten gir bare tilgang når organisasjonen har sendt inn noe gjennom ${config.altinnSystemnavn} (f.eks. a-meldingen).`,
      403,
      kode,
    );
  const f = skattFeil(r, hva);
  // Ukjent adresse (KB-003, FRI-003, eller en vanlig 404-side): adressen i maskinporten.ts må rettes.
  if (r.status === 404 && (!kode || /-003$/.test(kode)))
    throw new EtatFeil(`${f.message} Skatteetaten kjente ikke igjen adressen appen bruker; si fra til ${config.altinnSystemnavn}.`, 404, kode);
  throw f;
}

// De åpne kravene, og innbetalingene og utbetalingene det siste året.
export async function hentKrav(orgnr: string, iDag = osloIDag()): Promise<Kravoversikt> {
  const token = await hentToken(SCOPE.krav, orgnr);
  const base = `${adresser().krav}/${orgnr}`;
  const p = { fra: pluss(iDag, -364), til: iDag };
  const q = new URLSearchParams({ fraOgMed: p.fra, tilOgMed: p.til });
  const aapne = await hent(`${base}/aapnekrav`, token, "Kunne ikke hente kravene fra Skatteetaten");
  const inn = await hent(`${base}/innbetalinger?${q}`, token, "Kunne ikke hente innbetalingene fra Skatteetaten");
  const ut = await hent(`${base}/utbetalinger?${q}`, token, "Kunne ikke hente utbetalingene fra Skatteetaten");
  return tolkKravoversikt(aapne, inn, ut, p, iDag);
}

// Fristene det neste året.
export async function hentFrister(orgnr: string, iDag = osloIDag()): Promise<Fristoversikt> {
  const token = await hentToken(SCOPE.frister, orgnr);
  const q = new URLSearchParams({ fraOgMed: iDag, tilOgMed: pluss(iDag, 364) });
  return tolkFrister(await hent(`${adresser().frister}/${orgnr}?${q}`, token, "Kunne ikke hente fristene fra Skatteetaten"));
}

// Feil som ikke går over av seg selv (avvist, ugyldig, ikke satt opp): oppgaven prøves ikke igjen.
const varig = (e: unknown) => e instanceof EtatFeil && ((e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) || e.status === 503);

async function lagre(org: string, felt: Record<string, unknown>) {
  const k = Object.keys(felt);
  await somSystem((db) => db.query(`update faktura.skatteetaten_krav set ${k.map((x, i) => `${x} = $${i + 2}`).join(", ")} where org_id = $1`, [org, ...k.map((x) => felt[x])]));
}

// Henter krav og frister for organisasjonen og lagrer dem. Feil som kan gå over (ingen svar fra
// Skatteetaten, 5xx), kastes etter at begge er forsøkt, så Cloud Tasks prøver igjen.
export async function hentKravOgFrister(org: string): Promise<{ krav: boolean; frister: boolean } | null> {
  if (!config.kravOgFrister) return null;
  const t = await hentTilgang(org);
  if (!t?.orgnr || !harPakke(t, KRAV_OG_UTLEGG)) return null;
  await somSystem((db) =>
    db.query("insert into faktura.skatteetaten_krav (org_id, forsokt) values ($1, now()) on conflict (org_id) do update set forsokt = now()", [org]),
  );
  const svar = { krav: false, frister: false };
  let igjen: unknown = null;
  try {
    const k = await hentKrav(t.orgnr);
    await lagre(org, { krav: JSON.stringify(k), krav_hentet: new Date(), krav_feil: null });
    svar.krav = true;
  } catch (e) {
    logg("WARNING", "Kravene ble ikke hentet fra Skatteetaten", { org_id: org, feil: melding(e) });
    await lagre(org, { krav_feil: melding(e) });
    if (!varig(e)) igjen = e;
  }
  try {
    const f = await hentFrister(t.orgnr);
    await lagre(org, { frister: JSON.stringify(f), frister_hentet: new Date(), frister_feil: null });
    svar.frister = true;
  } catch (e) {
    logg("WARNING", "Fristene ble ikke hentet fra Skatteetaten", { org_id: org, feil: melding(e) });
    await lagre(org, { frister_feil: melding(e) });
    if (!varig(e)) igjen ??= e;
  }
  logg("INFO", "Krav og frister fra Skatteetaten", { org_id: org, ...svar });
  if (igjen) throw igjen;
  return svar;
}

// Hvert minutt (hjerteslaget): organisasjonene med tilgangspakken og Regnskap som ikke er hentet
// ennå (tilgangen er nettopp godkjent), og hver morgen fra kl. 06 de andre. De merkes først, så de
// ikke legges i kø hvert minutt mens de hentes.
export async function planleggKravOgFrister(): Promise<number> {
  if (!config.kravOgFrister) return 0;
  const rader = await somSystem((db) =>
    alle<{ org_id: string }>(
      db,
      `insert into faktura.skatteetaten_krav (org_id, forsokt)
       select t.org_id, now() from faktura.skattekort_tilgang t
         left join faktura.skatteetaten_krav k on k.org_id = t.org_id
        where t.status = 'godkjent' and $1 = any(t.pakker) and faktura.har_funksjon(t.org_id, 'regnskap')
          and (k.forsokt is null
               or ((now() at time zone 'Europe/Oslo')::time >= time '06:00'
                   and k.forsokt < ((now() at time zone 'Europe/Oslo')::date + time '06:00') at time zone 'Europe/Oslo'))
       on conflict (org_id) do update set forsokt = now()
       returning org_id`,
      [KRAV_OG_UTLEGG],
    ),
  );
  for (const r of rader) await leggIKo({ type: "skatteetaten-hent", org_id: r.org_id });
  return rader.length;
}
