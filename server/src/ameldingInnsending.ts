// A-meldingen i workeren (0077_amelding.sql, amelding.ts): bare workeren leser fødselsnumrene, så
// den lager meldingen appen har bestilt. Som fil: XML-en lagres i bøtta, og appen gir en
// tidsbegrenset lenke til den (lastes opp på skatteetaten.no). Til API-et: meldingen sendes med
// systembrukeren organisasjonen har gitt i Altinn (tilgangspakken «A-ordningen») og en
// idempotensnøkkel (ID-en til raden), så et nytt forsøk ikke gir to meldinger. Tilbakemeldingen
// kommer i Dialogporten: workeren slår opp dialogen, henter tilbakemeldingen fra Skatteetaten og
// lagrer status og avvik (uten fødselsnumre), og eier og administrator får varsel.
// https://github.com/Skatteetaten/api-dokumentasjon/blob/main/docs/api/innrapportering-amelding.md

import { alle, en, somSystem } from "./db.js";
import { config } from "./config.js";
import { dekrypter } from "./kryptering.js";
import { adresser, EtatFeil, etatKall, hentToken, SCOPE } from "./maskinporten.js";
import { A_ORDNING } from "./altinn.js";
import { harPakke, hentTilgang, melding, skjulFnr, utdrag } from "./skattekort.js";
import { lagring, leggIKo } from "./tjenester.js";
import { byggLeveranse, hentGrunnlag, kontroller, oppsummer, tilXml, tomtGrunnlag } from "./amelding.js";
import { maanedNavn } from "./lonnsberegning.js";

const logg = (severity: string, message: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ severity, message, ...data }));

type Rad = {
  id: string;
  org_id: string;
  maaned: string;
  meldings_id: string;
  erstatter: string | null;
  innsending: "fil" | "api";
  status: string;
  forsendelse_id: string | null;
  dialog_id: string | null;
  // En 0-melding som erstatter meldingen i erstatter og alt den inneholder (0117).
  nullstilling: boolean;
};

const hentRad = (org: string, id: string) =>
  somSystem((db) =>
    en<Rad>(
      db,
      `select id, org_id, to_char(maaned, 'YYYY-MM-DD') as maaned, meldings_id, erstatter, innsending, status, forsendelse_id, dialog_id, nullstilling
         from faktura.ameldinger where org_id = $1 and id = $2`,
      [org, id],
    ),
  );

async function oppdater(id: string, felt: Record<string, unknown>) {
  const k = Object.keys(felt);
  await somSystem((db) => db.query(`update faktura.ameldinger set ${k.map((x, i) => `${x} = $${i + 2}`).join(", ")} where id = $1`, [id, ...k.map((x) => felt[x])]));
}

// Fødselsnumrene (eller D-numrene) til de ansatte i meldingen.
async function fodselsnumre(org: string, ider: string[]): Promise<Map<string, string>> {
  const rader = await somSystem((db) =>
    alle<{ id: string; fnr_kryptert: Buffer }>(db, "select id, fnr_kryptert from faktura.ansatte where org_id = $1 and id = any($2::uuid[]) and fnr_kryptert is not null", [
      org,
      ider,
    ]),
  );
  const ut = new Map<string, string>();
  for (const r of rader) ut.set(r.id, (await dekrypter(r.fnr_kryptert)).trim());
  return ut;
}

// Navnene feltene i en feil fra Skatteetaten kan ha (kode, melding, sti og angitt verdi).
const FEILFELT = {
  melding: ["melding", "feilmelding", "beskrivelse", "message", "detail", "defaultMessage"],
  kode: ["kode", "feilkode", "feilspesifiseringskode", "code"],
  sti: ["sti", "felt", "field", "path", "pointer"],
  verdi: ["angittVerdi", "verdi", "value", "rejectedValue"],
};
const KJENTE = new Set(Object.values(FEILFELT).flat());
// Feltene i selve svaret som står i hovedfeilen, eller som ikke sier noe om feilen.
const HOVEDFELT = new Set(["kode", "melding", "korrelasjonsid", "status", "error", "timestamp", "title", "type", "instance", "detail", "message", "path"]);

// Detaljene i feilsvaret: feilspesifiseringen (kode, melding, sti og angitt verdi) i selve svaret
// og i lister og objekter inne i det, med de andre feltene i feilen (f.eks. navnet på et hode som
// mangler). Formatet står bare i spesifikasjonen på SwaggerHub, så alt som ser ut som en feil, tas
// med; finnes ingenting kjent, tas de ukjente feltene med som de er.
export function feildetaljer(d: unknown): string[] {
  const ut: string[] = [];
  const enkel = (v: unknown) => (typeof v === "string" && v.trim()) || typeof v === "number" || typeof v === "boolean";
  const felt = (o: Record<string, unknown>, navn: string[]) => {
    for (const n of navn) if (enkel(o[n])) return String(o[n]).trim();
    return null;
  };
  const besok = (v: unknown, rot: boolean, dybde: number) => {
    if (dybde > 5 || ut.length >= 8) return;
    if (typeof v === "string") {
      if (!rot && v.trim()) ut.push(v.trim());
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) besok(x, false, dybde + 1);
      return;
    }
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    // Koden og meldingen i selve svaret er hovedfeilen (står først i feilen).
    const melding = rot ? null : felt(o, FEILFELT.melding);
    const kode = felt(o, rot ? ["feilspesifiseringskode"] : FEILFELT.kode);
    const sti = felt(o, rot ? FEILFELT.sti.filter((n) => n !== "path") : FEILFELT.sti);
    const verdi = felt(o, FEILFELT.verdi);
    const andre = Object.entries(o)
      .filter(([k, x]) => !KJENTE.has(k) && !HOVEDFELT.has(k) && enkel(x))
      .map(([k, x]) => `${k} «${String(x).trim()}»`);
    const deler = [melding && kode ? `${melding} (${kode})` : (melding ?? kode), sti && `sti ${sti}`, verdi && `angitt verdi «${verdi}»`, ...andre].filter(Boolean);
    if (deler.length) ut.push(deler.join(", "));
    for (const x of Object.values(o)) if (x && typeof x === "object") besok(x, false, dybde + 1);
  };
  besok(d, true, 0);
  if (!ut.length && d && typeof d === "object" && !Array.isArray(d)) {
    const ukjente = Object.fromEntries(Object.entries(d).filter(([k]) => !HOVEDFELT.has(k)));
    if (Object.keys(ukjente).length) ut.push(utdrag(JSON.stringify(ukjente)));
  }
  return [...new Set(ut)];
}

// Feilen fra Skatteetaten: koden og meldingen, detaljene og korrelasjons-ID-en (eller starten av
// svaret når det ikke er JSON). Fødselsnumre skjules av melding() når feilen lagres.
export function ameldingFeil(r: { status: number; data: any; tekst: string }): EtatFeil {
  const d = r.data && typeof r.data === "object" && !Array.isArray(r.data) ? (r.data as Record<string, unknown>) : null;
  const kode = (typeof d?.kode === "string" && d.kode.trim()) || r.tekst.match(/AMLD_\d+/)?.[0] || null;
  // Idempotensnøkkelen er brukt: meldingen er sendt før (et forsøk som ble avbrutt etter sendingen).
  if (kode === "AMLD_019")
    return new EtatFeil("Skatteetaten har allerede tatt imot denne meldingen (AMLD_019). Se a-meldingen i Altinn før du sender den på nytt.", r.status, kode);
  const tekst = [d?.melding, d?.detail, d?.title, d?.message].find((x): x is string => typeof x === "string" && x.trim() !== "")?.trim() ?? `Skatteetaten svarte ${r.status}`;
  const detaljer = r.data != null ? feildetaljer(r.data).filter((x) => x !== tekst && x !== kode) : [];
  if (!d && !detaljer.length && r.tekst.trim()) detaljer.push(utdrag(r.tekst));
  const korrelasjonsid = typeof d?.korrelasjonsid === "string" && d.korrelasjonsid.trim() ? d.korrelasjonsid.trim() : null;
  return new EtatFeil(
    `A-meldingen ble ikke tatt imot: ${tekst}${kode ? ` (${kode})` : ""}${detaljer.length ? `: ${detaljer.join("; ")}` : ""}${korrelasjonsid ? ` (korrelasjons-ID ${korrelasjonsid})` : ""}`,
    r.status,
    kode,
  );
}

// Varsel til eier og administrator.
async function varsle(org: string, tittel: string, tekst: string, tag: string) {
  const mottakere = await somSystem((db) =>
    alle<{ bruker_id: string }>(db, "select bruker_id from faktura.medlemmer where org_id = $1 and (rolle in ('eier', 'admin') or faktura.tilpasset_har(org_id, bruker_id, 'lonn'))", [org]),
  );
  if (mottakere.length)
    await leggIKo({ type: "varsel", varsel: { hendelse: "lonn", org_id: org, bruker_ider: mottakere.map((m) => m.bruker_id), tittel, tekst, url: "/lonn?fane=amelding", tag } }).catch(
      () => undefined,
    );
}

const tidspunkt = () => `${new Date().toISOString().slice(0, 19)}Z`;

// Lager fila eller sender meldingen (raden står som «lages»). En nullstilling er en 0-melding
// (tomtGrunnlag): den trenger ingen fødselsnumre, og avvikene i grunnlaget for måneden stopper den
// ikke.
export async function lagAmelding(org: string, ameldingId: string) {
  const m = await hentRad(org, ameldingId);
  if (!m || m.status !== "lages") return;
  const maaned = m.maaned.slice(0, 7);
  const hva = m.nullstilling ? "Nullstillingen" : "A-meldingen";
  try {
    const hele = await somSystem((db) => hentGrunnlag(db, org, maaned));
    const g = m.nullstilling ? tomtGrunnlag(hele) : hele;
    if (!m.nullstilling) {
      const feil = kontroller(g).filter((a) => a.niva === "feil");
      if (feil.length) throw new Error(feil.map((f) => f.tekst).join(" "));
    }
    const fnr = await fodselsnumre(
      org,
      g.arbeidsforhold.map((f) => f.id),
    );
    const leveranse = byggLeveranse(g, { meldingsId: m.meldings_id, erstatter: m.erstatter, tidspunkt: tidspunkt(), fnr: (id) => fnr.get(id) ?? null });
    const oppsummering = oppsummer(g);
    if (m.innsending === "fil") {
      if (!config.filerBucket) throw new Error("Lagringen for filer er ikke satt opp.");
      const sti = `amelding/${org}/${maaned}/${m.meldings_id}.xml`;
      await lagring.lagre(config.filerBucket, sti, new TextEncoder().encode(tilXml(leveranse)), "application/xml");
      await oppdater(m.id, { status: "klar", fil_sti: sti, oppsummering, feil: null });
      logg("INFO", "A-meldingsfila er laget", { org_id: org, maaned, nullstilling: m.nullstilling });
      return;
    }
    if (!config.ameldingInnsending) throw new EtatFeil("Innsending til Skatteetaten er ikke slått på ennå. Last ned fila og last den opp på skatteetaten.no.", 503);
    const t = await hentTilgang(org);
    if (!t?.orgnr || !harPakke(t, A_ORDNING))
      throw new EtatFeil("Tilgangen i Altinn mangler tilgangspakken «A-ordningen». Utvid tilgangen under Innstillinger → Lønn → Skattekort.", 409);
    const token = await hentToken(SCOPE.amelding, t.orgnr);
    // Idempotensnøkkelen er en påkrevd «parameter» uten at dokumentasjonen sier hvor. Med den bare i
    // adressen svarte testmiljøet «Header mangler (AMLD_1028)», så den sendes også som hode, både med
    // parameternavnet og med standardnavnet (Idempotency-Key).
    const r = await etatKall(`${adresser().amelding}/innsending/${maaned}/${t.orgnr}?idempotencyKey=${m.id}`, token, {
      metode: "POST",
      kropp: leveranse,
      hvem: "Skatteetaten",
      hoder: { idempotencyKey: m.id, "Idempotency-Key": m.id },
    });
    if (r.status >= 300) {
      // Hele svaret (uten fødselsnumre) og hva som ble sendt, til feilsøkingen.
      const oppgave = leveranse.leveranse.oppgave as { virksomhet?: { norskIdentifikator: string; inntektsmottaker?: unknown[] }[] };
      logg("WARNING", "Skatteetaten avviste a-meldingen", {
        org_id: org,
        maaned,
        status: r.status,
        svar: skjulFnr(r.tekst).slice(0, 4000),
        sendt: {
          sti: `/innsending/${maaned}/${t.orgnr}`,
          opplysningspliktig: g.org.orgnr,
          virksomheter: (oppgave.virksomhet ?? []).map((v) => ({ orgnr: v.norskIdentifikator, mottakere: v.inntektsmottaker?.length ?? 0 })),
          felt: Object.keys(leveranse.leveranse),
        },
      });
      throw ameldingFeil(r);
    }
    await oppdater(m.id, {
      status: "sendt",
      forsendelse_id: typeof r.data?.forsendelseId === "string" ? r.data.forsendelseId : null,
      dialog_id: typeof r.data?.dialogId === "string" ? r.data.dialogId : null,
      sendt_at: new Date().toISOString(),
      oppsummering,
      feil: null,
    });
    logg("INFO", "A-meldingen er sendt", { org_id: org, maaned, nullstilling: m.nullstilling });
    // Meldingen er sendt: går køen feil, tar hjerteslaget sjekken (planleggAmeldingssjekk).
    await leggIKo({ type: "amelding-status", org_id: org, amelding_id: m.id, forsok: 1 }, 120).catch((e) =>
      logg("WARNING", "Sjekken av tilbakemeldingen ble ikke lagt i kø", { org_id: org, maaned, feil: melding(e) }),
    );
  } catch (e) {
    logg("WARNING", "A-meldingen ble ikke laget eller sendt", { org_id: org, maaned, nullstilling: m.nullstilling, feil: melding(e) });
    await oppdater(m.id, { status: "feil", feil: melding(e) });
    await varsle(org, `${hva} ble ikke sendt`, `${hva} for ${maanedNavn(m.maaned)} ble ikke ${m.innsending === "fil" ? "laget" : "sendt"}: ${melding(e)}`, `amelding-${m.id}`);
  }
}

// --- Tilbakemeldingen -------------------------------------------------------------------------

type Lenke = { url: string; consumerType?: string };

// Lenkene (https) i noe fra Dialogporten, hvor de enn står (vedleggene på en forsendelse).
function lenker(x: unknown): Lenke[] {
  const ut: Lenke[] = [];
  const samle = (y: any) => {
    if (!y || typeof y !== "object") return;
    if (Array.isArray(y)) return y.forEach(samle);
    if (typeof y.url === "string" && /^https:\/\//.test(y.url)) ut.push({ url: y.url, consumerType: y.consumerType });
    for (const v of Object.values(y)) samle(v);
  };
  samle(x);
  return ut;
}

// Lenken for API-et (consumerType «Api»), ellers en lenke til tilbakemeldingen som ikke er for
// innboksen («Gui», under /web/).
const apiLenke = (l: Lenke[]) =>
  l.find((u) => u.consumerType === "Api")?.url ?? l.find((u) => /tilbakemelding/i.test(u.url) && !/\/web\//.test(u.url))?.url ?? null;

const forsendelserI = (dialog: any): any[] | null =>
  Array.isArray(dialog?.transmissions) ? dialog.transmissions.filter((t: unknown) => t && typeof t === "object") : null;

// Lenken til tilbakemeldingen i dialogen. Skatteetaten lager én forsendelse (transmission) for
// innsendingen og en annen for tilbakemeldingen, og begge kan ha en lenke for API-et. Forsendelsen
// for innsendingen (ID-en i svaret på innsendingen, eller typen «Submission») hoppes derfor over,
// og den nyeste av de andre brukes.
export function tilbakemeldingUrl(dialog: any, innsending?: string | null): string | null {
  const forsendelser = forsendelserI(dialog);
  if (!forsendelser) return apiLenke(lenker(dialog));
  const tilbakemeldinger = forsendelser
    .filter((t) => !(innsending && t.id === innsending) && String(t.type ?? "").toLowerCase() !== "submission")
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  for (const t of tilbakemeldinger) {
    const url = apiLenke(lenker(t));
    if (url) return url;
  }
  return null;
}

// Verten og stien i en adresse (til loggen, uten spørringen).
const vertOgSti = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return "ugyldig adresse";
  }
};

// Forsendelsene i dialogen til loggen: ID-en, typen, når og lenkene (verten og stien).
export function forsendelseOversikt(dialog: any) {
  return (forsendelserI(dialog) ?? []).slice(0, 20).map((t) => ({
    id: t.id ?? null,
    type: t.type ?? null,
    opprettet: t.createdAt ?? null,
    lenker: lenker(t.attachments).map((l) => `${l.consumerType ?? "?"} ${vertOgSti(l.url)}`),
  }));
}

const skjul = (x: unknown) => JSON.parse(JSON.stringify(x ?? null).replace(/\b\d{11}\b/g, "•••••••••••"));

// Et avvik i tilbakemeldingen. antall: når det samme avviket står flere ganger.
export type Avvik = { kode: string | null; tekst: string; alvorlighet: string | null; antall?: number };

// Status og avvik fra tilbakemeldingen. Skatteetatens svar gjelder hele måneden: mottak[] har
// mottattLeveranse[] med hver melding for måneden (meldingsId, mottakstatus og avvik) og
// mottattPeriode med avvikene for perioden. Statusen er den for meldingen selv (meldingsId), ikke
// for en annen melding samme måned; står den ikke der ennå, er svaret ikke klart (null). Avvikene for
// perioden tas med når svaret kom etter denne meldingen (tilbakemeldingEtterMottakAvMeldingsId).
// Uten listen over meldinger tolkes svaret forsiktig: status-feltene og avvikene, hvor de enn står.
// Avvik: lister, ett avvik for seg eller bare tekst; Skatteetaten har id, navn (regelen),
// alvorlighetsgrad og detaljer. Er meldingen avvist uten avvik, brukes feltene som sier hvorfor
// (årsak, grunn, feilmelding). navnPaa: navnet på den ansatte med fødselsnummeret (avvikene sier
// hvem de gjelder); ellers skjules det.
export function tolkTilbakemelding(
  data: any,
  valg: { meldingsId?: string | null; navnPaa?: (fnr: string) => string | undefined } = {},
): { status: "mottatt" | "avvist" | null; avvik: Avvik[] } {
  const statuser: string[] = [];
  const avvik: Avvik[] = [];
  const grunner: string[] = [];
  const tekstUtenFnr = (t: string) => t.replace(/\b\d{11}\b/g, (f) => valg.navnPaa?.(f) ?? "•••••••••••");
  const leggTil = (ny: Avvik) => {
    const likt = avvik.find((y) => y.kode === ny.kode && y.tekst === ny.tekst && y.alvorlighet === ny.alvorlighet);
    if (likt) likt.antall = (likt.antall ?? 1) + 1;
    else avvik.push(ny);
  };
  const ettAvvik = (a: any) => {
    if (typeof a === "string" && a.trim()) return leggTil({ kode: null, tekst: tekstUtenFnr(a.trim()), alvorlighet: null });
    if (!a || typeof a !== "object" || Array.isArray(a)) return;
    const regel = typeof a.navn === "string" ? a.navn.trim() : "";
    const detaljer = [a.detaljer, a.beskrivelse, a.melding, a.tekst, a.feilmelding, a.forklaring].find((v) => typeof v === "string" && v.trim());
    const tekst = [regel, detaljer?.trim()].filter(Boolean).join(" ") || JSON.stringify(skjul(a)).slice(0, 300);
    const kode = [a.kode, a.regel, a.regelnummer, a.avvikskode, a.id].find((v) => typeof v === "string" || typeof v === "number");
    const alvorlighet = [a.alvorlighetsgrad, a.alvorlighet, a.niva, a.type].find((v) => typeof v === "string") ?? null;
    leggTil({ kode: kode == null ? null : String(kode), tekst: tekstUtenFnr(tekst), alvorlighet });
  };
  // iAvvik: elementene i en liste med avvik (f.eks. «avvik» eller «avviksliste»). Et avvik tolkes for
  // seg (ikke feltene i det hver for seg). medStatus: false for avvikene i perioden.
  const gjennom = (x: any, nokkel = "", iAvvik = false, medStatus = true) => {
    if (x == null) return;
    if (Array.isArray(x)) return void x.forEach((v) => gjennom(v, nokkel, /avvik/i.test(nokkel), medStatus));
    if (typeof x === "object") {
      if (iAvvik || /^avvik$/i.test(nokkel)) return void ettAvvik(x);
      return void Object.entries(x).forEach(([k, v]) => gjennom(v, k, false, medStatus));
    }
    if (typeof x !== "string") return;
    if (iAvvik || /^avvik$/i.test(nokkel)) ettAvvik(x);
    else if (!medStatus) return;
    else if (/status/i.test(nokkel)) statuser.push(x.toLowerCase());
    else if (/aarsak|årsak|grunn|feilmelding|forklaring/i.test(nokkel) && x.trim()) grunner.push(tekstUtenFnr(x.trim()));
  };
  const liste = (x: unknown): any[] => (Array.isArray(x) ? x : x == null ? [] : [x]);
  const leveranser = liste(data?.mottak).flatMap((m) => liste(m?.mottattLeveranse).map((l) => ({ m, l })));
  if (valg.meldingsId && leveranser.length) {
    const egen = leveranser.find((x) => x.l?.meldingsId === valg.meldingsId);
    if (!egen) return { status: null, avvik: [] };
    gjennom(egen.l);
    if (egen.m?.tilbakemeldingEtterMottakAvMeldingsId === valg.meldingsId) gjennom(egen.m?.mottattPeriode, "", false, false);
  } else gjennom(data);
  // «ikkeMottatt», «underBehandling» og lignende er ikke et svar ennå. En melding som er «erstattet»
  // (av en ny melding eller en nullstilling), ble mottatt før den ble erstattet.
  const mottatt = (s: string) => /mottatt|godkjent|erstattet|^ok$/.test(s) && !/ikke|under|venter/.test(s);
  const status = statuser.some((s) => s.includes("avvist")) ? "avvist" : statuser.some(mottatt) ? "mottatt" : null;
  if (status === "avvist" && !avvik.length) for (const g of grunner) leggTil({ kode: null, tekst: g, alvorlighet: "avvisning" });
  return { status, avvik: avvik.slice(0, 100) };
}

// Feltene (ikke verdiene) i tilbakemeldingen, til loggen når formatet er ukjent.
export function felterI(x: unknown, sti = "", ut: string[] = []): string[] {
  if (ut.length >= 60 || x == null || typeof x !== "object") return ut;
  if (Array.isArray(x)) return x.length ? felterI(x[0], `${sti}[]`, ut) : ut;
  for (const [k, v] of Object.entries(x)) {
    ut.push(`${sti}${sti ? "." : ""}${k}`);
    felterI(v, `${sti}${sti ? "." : ""}${k}`, ut);
  }
  return ut;
}

// Navnene på de ansatte med fødselsnumrene i tilbakemeldingen, så avvikene sier hvem de gjelder
// (bare workeren leser fødselsnumrene). Går det ikke, skjules de.
async function navnForFnr(org: string, data: unknown): Promise<((fnr: string) => string | undefined) | undefined> {
  const fnr = new Set(JSON.stringify(data ?? null).match(/\b\d{11}\b/g) ?? []);
  if (!fnr.size) return undefined;
  try {
    const ansatte = await somSystem((db) =>
      alle<{ id: string; navn: string }>(db, "select id, fornavn || ' ' || etternavn as navn from faktura.ansatte where org_id = $1 and fnr_kryptert is not null", [org]),
    );
    const nr = await fodselsnumre(org, ansatte.map((a) => a.id));
    const navn = new Map(ansatte.flatMap((a): [string, string][] => (fnr.has(nr.get(a.id) ?? "") ? [[nr.get(a.id)!, a.navn]] : [])));
    return (f) => navn.get(f);
  } catch (e) {
    logg("WARNING", "Navnene til avvikene i a-meldingen ble ikke hentet", { org_id: org, feil: melding(e) });
    return undefined;
  }
}

// Henter tilbakemeldingen (raden står som «sendt»). Er den ikke klar, prøves det igjen litt senere
// (lenger mellom hver gang, i to døgn). Hva den venter på, står på meldingen (tilbakemelding.venter,
// vist med når den sist ble sjekket) og i loggen, med forsendelsene i dialogen.
export async function sjekkAmelding(org: string, ameldingId: string, forsok = 1) {
  const m = await hentRad(org, ameldingId);
  if (!m || m.status !== "sendt") return;
  const igjen = async () => {
    if (forsok < 40) await leggIKo({ type: "amelding-status", org_id: org, amelding_id: m.id, forsok: forsok + 1 }, Math.min(3600, 120 * forsok));
  };
  // Ikke klar ennå: grunnen står på meldingen og i loggen, og det prøves igjen senere.
  type Venter = { detaljer?: Record<string, unknown>; tilbakemelding?: Record<string, unknown>; igjen?: boolean };
  const venter = async (grunn: string, o: Venter = {}) => {
    logg("INFO", "Tilbakemeldingen på a-meldingen er ikke klar", { org_id: org, amelding_id: m.id, forsok, grunn, ...o.detaljer });
    await oppdater(m.id, { tilbakemelding: { status: null, avvik: [], ...o.tilbakemelding, venter: grunn }, feil: null });
    if (o.igjen !== false) await igjen();
  };
  try {
    await oppdater(m.id, { sjekket: new Date().toISOString() });
    // Uten dialog-ID-en er det ingenting å slå opp (et nytt forsøk hjelper ikke).
    if (!m.dialog_id)
      return void (await venter("Skatteetaten sendte ingen dialog-ID med kvitteringen, så appen finner ikke tilbakemeldingen. Den står i innboksen i Altinn.", { igjen: false }));
    const t = await hentTilgang(org);
    if (!t?.orgnr)
      return void (await venter("Organisasjonen er ikke koblet til Skatteetaten (systembrukeren i Altinn), så tilbakemeldingen kan ikke hentes.", { igjen: false }));
    const token = await hentToken(SCOPE.dialogporten, t.orgnr);
    const adresse = `${adresser().altinn}/dialogporten/api/v1/enduser/dialogs/${encodeURIComponent(m.dialog_id)}`;
    const dp = await etatKall(adresse, token, { hvem: "Dialogporten" });
    if (dp.status === 404) return void (await venter("Dialogen er ikke i Dialogporten ennå."));
    if (dp.status >= 300) throw new EtatFeil(`Dialogporten svarte ${dp.status}`, dp.status);
    let dialog = dp.data;
    // Står ikke forsendelsene i dialogen, hentes de for seg.
    if (!forsendelserI(dialog)) {
      const f = await etatKall(`${adresse}/transmissions`, token, { hvem: "Dialogporten" });
      if (f.status < 300 && Array.isArray(f.data)) dialog = { ...dialog, transmissions: f.data };
    }
    const url = tilbakemeldingUrl(dialog, m.forsendelse_id);
    if (!url) return void (await venter("Skatteetaten har ikke lagt tilbakemeldingen i Dialogporten ennå.", { detaljer: { forsendelser: forsendelseOversikt(dialog) } }));
    const r = await etatKall(url, await hentToken(SCOPE.amelding, t.orgnr), { hvem: "Skatteetaten" });
    if (r.status === 404 || r.status === 204) return void (await venter("Tilbakemeldingen er ikke klar hos Skatteetaten ennå.", { detaljer: { adresse: vertOgSti(url) } }));
    if (r.status >= 300) throw ameldingFeil(r);
    let tb = tolkTilbakemelding(r.data, { meldingsId: m.meldings_id });
    // Avvik som gjelder en ansatt: med navnet i stedet for det skjulte fødselsnummeret.
    if (tb.avvik.some((a) => a.tekst.includes("•••••••••••")))
      tb = tolkTilbakemelding(r.data, { meldingsId: m.meldings_id, navnPaa: await navnForFnr(org, r.data) });
    // Avvist uten at noe sier hvorfor: feltene i loggen, så formatet kan tolkes (hele svaret, uten
    // fødselsnumre, står på meldingen).
    if (tb.status === "avvist" && !tb.avvik.length)
      logg("WARNING", "A-meldingen er avvist, men tilbakemeldingen har ingen avvik appen kjenner igjen", { org_id: org, amelding_id: m.id, felt: felterI(r.data) });
    if (!tb.status) {
      // Feltene (ikke verdiene) i loggen, så formatet kan sjekkes.
      const felt = r.data && typeof r.data === "object" ? Object.keys(r.data).slice(0, 30) : typeof r.data;
      return void (await venter("Svaret fra Skatteetaten har ingen status for denne meldingen ennå.", { detaljer: { adresse: vertOgSti(url), felt }, tilbakemelding: { avvik: tb.avvik, data: skjul(r.data) } }));
    }
    await oppdater(m.id, { tilbakemelding: { ...tb, data: skjul(r.data) }, status: tb.status, feil: null });
    const mnd = maanedNavn(m.maaned);
    // En nullstilling som er mottatt: meldingen den erstatter, gjelder ikke lenger (0117).
    if (m.nullstilling)
      await varsle(
        org,
        tb.status === "avvist" ? "Nullstillingen er avvist" : "Nullstillingen er mottatt",
        tb.status === "avvist"
          ? `Nullstillingen av a-meldingen for ${mnd} er avvist av Skatteetaten, så meldingen gjelder fortsatt. Se avvikene i appen.`
          : `Nullstillingen av a-meldingen for ${mnd} er mottatt av Skatteetaten. Meldingen den erstatter, gjelder ikke lenger.`,
        `amelding-${m.id}`,
      );
    else
      await varsle(
        org,
        tb.status === "avvist" ? "A-meldingen er avvist" : "A-meldingen er mottatt",
        tb.status === "avvist"
          ? `A-meldingen for ${mnd} er avvist av Skatteetaten. Se avvikene i appen, rett dem og send på nytt.`
          : `A-meldingen for ${mnd} er mottatt av Skatteetaten${tb.avvik.length ? ` med ${tb.avvik.length} avvik` : ""}.`,
        `amelding-${m.id}`,
      );
  } catch (e) {
    logg("WARNING", "Tilbakemeldingen på a-meldingen ble ikke hentet", { org_id: org, feil: melding(e) });
    await oppdater(m.id, { feil: melding(e) });
    await igjen();
  }
}

// Hvert minutt (hjerteslaget): meldinger som venter på tilbakemelding og ikke er sjekket på en
// halvtime (f.eks. når en oppgave ble borte).
export async function planleggAmeldingssjekk(): Promise<number> {
  const rader = await somSystem((db) =>
    alle<{ id: string; org_id: string }>(
      db,
      `update faktura.ameldinger set sjekket = now()
        where status = 'sendt' and innsending = 'api' and sendt_at > now() - interval '7 days'
          and coalesce(sjekket, sendt_at) < now() - interval '30 minutes'
       returning id, org_id`,
    ),
  );
  for (const r of rader) await leggIKo({ type: "amelding-status", org_id: r.org_id, amelding_id: r.id, forsok: 20 });
  return rader.length;
}
