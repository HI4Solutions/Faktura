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
import { harPakke, hentTilgang, melding } from "./skattekort.js";
import { lagring, leggIKo } from "./tjenester.js";
import { byggLeveranse, hentGrunnlag, kontroller, oppsummer, tilXml } from "./amelding.js";
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
  dialog_id: string | null;
};

const hentRad = (org: string, id: string) =>
  somSystem((db) =>
    en<Rad>(
      db,
      `select id, org_id, to_char(maaned, 'YYYY-MM-DD') as maaned, meldings_id, erstatter, innsending, status, dialog_id
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

// Feilen fra Skatteetaten (AMLD_-kode og meldingen; et fødselsnummer skjules av melding()).
function ameldingFeil(r: { status: number; data: any; tekst: string }): EtatFeil {
  const kode = r.tekst.match(/AMLD_\d+/)?.[0] ?? null;
  // Idempotensnøkkelen er brukt: meldingen er sendt før (et forsøk som ble avbrutt etter sendingen).
  if (kode === "AMLD_019")
    return new EtatFeil("Skatteetaten har allerede tatt imot denne meldingen (AMLD_019). Se a-meldingen i Altinn før du sender den på nytt.", r.status, kode);
  const d = r.data;
  const tekst = (typeof d?.melding === "string" && d.melding) || (typeof d?.detail === "string" && d.detail) || (typeof d?.title === "string" && d.title) || `Skatteetaten svarte ${r.status}`;
  return new EtatFeil(`A-meldingen ble ikke tatt imot: ${tekst}${kode ? ` (${kode})` : ""}`, r.status, kode);
}

// Varsel til eier og administrator.
async function varsle(org: string, tittel: string, tekst: string, tag: string) {
  const mottakere = await somSystem((db) =>
    alle<{ bruker_id: string }>(db, "select bruker_id from faktura.medlemmer where org_id = $1 and rolle in ('eier', 'admin')", [org]),
  );
  if (mottakere.length)
    await leggIKo({ type: "varsel", varsel: { hendelse: "lonn", org_id: org, bruker_ider: mottakere.map((m) => m.bruker_id), tittel, tekst, url: "/lonn?fane=amelding", tag } }).catch(
      () => undefined,
    );
}

const tidspunkt = () => `${new Date().toISOString().slice(0, 19)}Z`;

// Lager fila eller sender meldingen (raden står som «lages»).
export async function lagAmelding(org: string, ameldingId: string) {
  const m = await hentRad(org, ameldingId);
  if (!m || m.status !== "lages") return;
  const maaned = m.maaned.slice(0, 7);
  try {
    const g = await somSystem((db) => hentGrunnlag(db, org, maaned));
    const feil = kontroller(g).filter((a) => a.niva === "feil");
    if (feil.length) throw new Error(feil.map((f) => f.tekst).join(" "));
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
      logg("INFO", "A-meldingsfila er laget", { org_id: org, maaned });
      return;
    }
    if (!config.ameldingInnsending) throw new EtatFeil("Innsending til Skatteetaten er ikke slått på ennå. Last ned fila og last den opp på skatteetaten.no.", 503);
    const t = await hentTilgang(org);
    if (!t?.orgnr || !harPakke(t, A_ORDNING))
      throw new EtatFeil("Tilgangen i Altinn mangler tilgangspakken «A-ordningen». Utvid tilgangen under Innstillinger → Ansatte og timer.", 409);
    const token = await hentToken(SCOPE.amelding, t.orgnr);
    const r = await etatKall(`${adresser().amelding}/innsending/${maaned}/${t.orgnr}?idempotencyKey=${m.id}`, token, { metode: "POST", kropp: leveranse, hvem: "Skatteetaten" });
    if (r.status >= 300) throw ameldingFeil(r);
    await oppdater(m.id, {
      status: "sendt",
      forsendelse_id: typeof r.data?.forsendelseId === "string" ? r.data.forsendelseId : null,
      dialog_id: typeof r.data?.dialogId === "string" ? r.data.dialogId : null,
      sendt_at: new Date().toISOString(),
      oppsummering,
      feil: null,
    });
    logg("INFO", "A-meldingen er sendt", { org_id: org, maaned });
    await leggIKo({ type: "amelding-status", org_id: org, amelding_id: m.id, forsok: 1 }, 120);
  } catch (e) {
    logg("WARNING", "A-meldingen ble ikke laget eller sendt", { org_id: org, maaned, feil: melding(e) });
    await oppdater(m.id, { status: "feil", feil: melding(e) });
    await varsle(org, "A-meldingen ble ikke sendt", `A-meldingen for ${maanedNavn(m.maaned)} ble ikke ${m.innsending === "fil" ? "laget" : "sendt"}: ${melding(e)}`, `amelding-${m.id}`);
  }
}

// --- Tilbakemeldingen -------------------------------------------------------------------------

// Lenken til tilbakemeldingen i dialogen (vedlegget for API-et i en forsendelse fra Skatteetaten).
export function tilbakemeldingUrl(dialog: any): string | null {
  const urler: { url: string; consumerType?: string }[] = [];
  const samle = (x: any) => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) return x.forEach(samle);
    if (typeof x.url === "string" && /^https:\/\//.test(x.url)) urler.push({ url: x.url, consumerType: x.consumerType });
    for (const v of Object.values(x)) samle(v);
  };
  samle(dialog?.transmissions ?? dialog);
  return urler.find((u) => u.consumerType === "Api")?.url ?? urler.find((u) => /tilbakemelding/i.test(u.url) && !/\/web\//.test(u.url))?.url ?? null;
}

const skjul = (x: unknown) => JSON.parse(JSON.stringify(x ?? null).replace(/\b\d{11}\b/g, "•••••••••••"));

// Status og avvik fra tilbakemeldingen (formatet tolkes forsiktig: status-feltene og listene med
// avvik, hvor de enn står).
export function tolkTilbakemelding(data: any): { status: "mottatt" | "avvist" | null; avvik: { kode: string | null; tekst: string; alvorlighet: string | null }[] } {
  const statuser: string[] = [];
  const avvik: { kode: string | null; tekst: string; alvorlighet: string | null }[] = [];
  const gjennom = (x: any, nokkel = "") => {
    if (x == null) return;
    if (Array.isArray(x)) {
      if (/avvik/i.test(nokkel))
        for (const a of x) {
          if (!a || typeof a !== "object") continue;
          const tekst = [a.beskrivelse, a.melding, a.tekst, a.feilmelding, a.forklaring].find((v) => typeof v === "string") ?? JSON.stringify(skjul(a)).slice(0, 300);
          const kode = [a.kode, a.regel, a.regelnummer, a.avvikskode, a.id].find((v) => typeof v === "string" || typeof v === "number");
          const alvorlighet = [a.alvorlighetsgrad, a.alvorlighet, a.niva, a.type].find((v) => typeof v === "string");
          avvik.push({ kode: kode == null ? null : String(kode), tekst: String(tekst).replace(/\b\d{11}\b/g, "•••••••••••"), alvorlighet: alvorlighet ?? null });
        }
      x.forEach((v) => gjennom(v, nokkel));
      return;
    }
    if (typeof x === "object") return void Object.entries(x).forEach(([k, v]) => gjennom(v, k));
    if (typeof x === "string" && /status/i.test(nokkel)) statuser.push(x.toLowerCase());
  };
  gjennom(data);
  // «ikkeMottatt», «underBehandling» og lignende er ikke et svar ennå.
  const mottatt = (s: string) => /mottatt|godkjent|^ok$/.test(s) && !/ikke|under|venter/.test(s);
  const status = statuser.some((s) => s.includes("avvist")) ? "avvist" : statuser.some(mottatt) ? "mottatt" : null;
  return { status, avvik: avvik.slice(0, 100) };
}

// Henter tilbakemeldingen (raden står som «sendt»). Er den ikke klar, prøves det igjen litt senere
// (lenger mellom hver gang, i to døgn).
export async function sjekkAmelding(org: string, ameldingId: string, forsok = 1) {
  const m = await hentRad(org, ameldingId);
  if (!m || m.status !== "sendt") return;
  const igjen = async () => {
    if (forsok < 40) await leggIKo({ type: "amelding-status", org_id: org, amelding_id: m.id, forsok: forsok + 1 }, Math.min(3600, 120 * forsok));
  };
  try {
    await oppdater(m.id, { sjekket: new Date().toISOString() });
    if (!m.dialog_id) return;
    const t = await hentTilgang(org);
    if (!t?.orgnr) return;
    const dp = await etatKall(`${adresser().altinn}/dialogporten/api/v1/enduser/dialogs/${encodeURIComponent(m.dialog_id)}`, await hentToken(SCOPE.dialogporten, t.orgnr), {
      hvem: "Dialogporten",
    });
    if (dp.status === 404) return void (await igjen());
    if (dp.status >= 300) throw new EtatFeil(`Dialogporten svarte ${dp.status}`, dp.status);
    const url = tilbakemeldingUrl(dp.data);
    if (!url) return void (await igjen());
    const r = await etatKall(url, await hentToken(SCOPE.amelding, t.orgnr), { hvem: "Skatteetaten" });
    if (r.status === 404 || r.status === 204) return void (await igjen());
    if (r.status >= 300) throw ameldingFeil(r);
    const tb = tolkTilbakemelding(r.data);
    await oppdater(m.id, { tilbakemelding: { ...tb, data: skjul(r.data) }, ...(tb.status ? { status: tb.status } : {}) });
    if (!tb.status) return void (await igjen());
    const mnd = maanedNavn(m.maaned);
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
