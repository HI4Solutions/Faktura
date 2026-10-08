// Sending av EHF gjennom organisasjonens egen konto hos Recommand. Workeren sender
// fakturaen som EHF når kunden kan ta imot det; går det ikke, sendes e-post som før.
//
// Hver sending logges i faktura.ehf_sendinger (i egne transaksjoner, så loggen står selv
// om resten av utsendingen feiler). Kjøres samme oppgave på nytt, sendes EHF-en ikke
// en gang til.
import { alle, en, somSystem, type Db } from "./db.js";
import { dekrypter } from "./kryptering.js";
import { ehfHindring, lagEhf } from "./ehf.js";
import { finnSelskap, hentDokument, peppolFeil, RecommandFeil, sendEhf, type Leveringsstatus, type RecommandNokkel, type SendtDokument } from "./recommand.js";
import { leggIKo } from "./tjenester.js";
import type { Vedleggsfil } from "./vedlegg.js";

const logg = (severity: string, message: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ severity, message, ...data }));

export type EhfKobling = { selskapId: string; nokkel: RecommandNokkel };

// Organisasjonens kobling med hemmeligheten dekryptert (bare workeren kan dekryptere).
export async function ehfKobling(db: Db, orgId: string): Promise<EhfKobling | null> {
  // Uten funksjonen EHF (Administrasjon → Funksjoner) går fakturaene på e-post.
  const k = await en(
    db,
    "select konfig, hemmelighet_kryptert from faktura.integrasjoner where org_id = $1 and type = 'peppol' and status = 'aktiv' and faktura.har_funksjon(org_id, 'ehf')",
    [orgId],
  );
  if (!k?.hemmelighet_kryptert || k.konfig?.leverandor !== "recommand" || !k.konfig.selskap_id || !k.konfig.nokkel_id) return null;
  return { selskapId: k.konfig.selskap_id, nokkel: { nokkelId: k.konfig.nokkel_id, hemmelighet: await dekrypter(k.hemmelighet_kryptert) } };
}

export type EhfStatus = "sender" | "venter" | "levert" | "feilet";
export type EhfUtfall = { status: EhfStatus; mottaker: string; melding?: string | null };

const fraLevering = (s: Leveringsstatus): EhfStatus => (s === "delivered" ? "levert" : s === "failed" ? "feilet" : "venter");

// Ventetid (sekunder) før hver ny statuskontroll mens mottakerens aksesspunkt ikke har kvittert.
export const VENTETIDER = [120, 600, 1800, 7200, 21600, 43200, 86400];

const oppdater = (id: string, felt: { status: EhfStatus; dokument_id?: string | null; feil_kategori?: string | null; detaljer?: string | null }) =>
  somSystem((db) =>
    db.query(
      `update faktura.ehf_sendinger set status = $2, dokument_id = coalesce($3, dokument_id), feil_kategori = $4, detaljer = $5, oppdatert = now() where id = $1`,
      [id, felt.status, felt.dokument_id ?? null, felt.feil_kategori ?? null, felt.detaljer ?? null],
    ),
  );

// Sender fakturaen som EHF. null: EHF er ikke aktuelt (ingen kobling, kunden kan ikke ta
// imot EHF, eller fakturaen mangler noe EHF krever), og fakturaen sendes på e-post.
export async function sendSomEhf(db: Db, f: any, pdf: { filnavn: string; data: Uint8Array }, vedlegg: Vedleggsfil[], oppgaveId: string): Promise<EhfUtfall | null> {
  const tidligere = await en(db, "select status, mottaker, detaljer from faktura.ehf_sendinger where oppgave_id = $1", [oppgaveId]);
  if (tidligere) return { status: tidligere.status, mottaker: tidligere.mottaker, melding: tidligere.detaljer };

  const kunde = await en(db, "select ehf from faktura.kunder where id = $1", [f.kunde_id]);
  if (kunde?.ehf !== true) return null;
  const hindring = ehfHindring(f);
  if (hindring) {
    logg("INFO", "Fakturaen sendes ikke som EHF", { faktura_id: f.id, grunn: hindring });
    return null;
  }
  const kobling = await ehfKobling(db, f.org_id);
  if (!kobling) return null;

  const kreditnota = f.type === "kreditnota";
  const kreditert = kreditnota ? await en(db, "select fakturanummer as nummer, fakturadato as dato from faktura.fakturaer where id = $1", [f.kreditnota_for]) : null;
  let xml: string;
  try {
    xml = lagEhf(f, { pdf, vedlegg, kreditertFaktura: kreditert ?? undefined });
  } catch (e) {
    // Kan ikke fakturaen lages som EHF, går den på e-post i stedet for at utsendingen stopper.
    logg("ERROR", "Kunne ikke lage EHF; sendes på e-post", { faktura_id: f.id, feil: (e as Error).message });
    return null;
  }
  const mottaker = `0192:${String(f.kunde.orgnr).replace(/\s/g, "")}`;

  const { id } = (await somSystem((d) =>
    en(d, "insert into faktura.ehf_sendinger (org_id, faktura_id, oppgave_id, mottaker) values ($1, $2, $3, $4) returning id", [f.org_id, f.id, oppgaveId, mottaker]),
  ))!;

  let svar: SendtDokument;
  try {
    svar = await sendEhf(kobling.nokkel, kobling.selskapId, mottaker, xml, kreditnota);
  } catch (e) {
    const feil = e instanceof RecommandFeil ? e : new RecommandFeil((e as Error).message, 500);
    if (feil.status === 0) {
      // Uten svar vet vi ikke om den ble sendt. Ingen e-post, så kunden ikke får den to ganger.
      await oppdater(id, { status: "sender", detaljer: feil.message });
      logg("WARNING", "Usikkert om EHF ble sendt", { faktura_id: f.id, feil: feil.message });
      return { status: "sender", mottaker, melding: feil.message };
    }
    if (feil.status === 401 || feil.status === 403) {
      // Nøkkelen er trukket tilbake, eller kontoen kan ikke sende (abonnement eller kvote).
      await somSystem((d) => d.query("update faktura.integrasjoner set siste_feil = $2 where org_id = $1 and type = 'peppol'", [f.org_id, feil.message]));
    }
    await oppdater(id, { status: "feilet", feil_kategori: feil.kategori ?? (feil.status === 400 ? "validation" : null), detaljer: feil.message });
    logg(feil.status === 400 ? "ERROR" : "WARNING", "EHF ble ikke sendt", { faktura_id: f.id, status: feil.status, feil: feil.message });
    return { status: "feilet", mottaker, melding: feil.message };
  }

  const status = svar.sentOverPeppol === false ? "feilet" : fraLevering(svar.deliveryStatus);
  const pf = peppolFeil(svar);
  await oppdater(id, { status, dokument_id: svar.id, feil_kategori: pf.kategori, detaljer: pf.melding });
  if (status === "venter") await leggIKo({ type: "sjekk-ehf", sending_id: id }, VENTETIDER[0]);
  logg("INFO", "EHF sendt", { faktura_id: f.id, status, dokument_id: svar.id });
  return { status, mottaker, melding: pf.melding };
}

// Mens mottakerens aksesspunkt ikke har kvittert: sjekk status igjen, med lengre og lengre
// mellomrom. Feilet den, sendes fakturaen på e-post i stedet.
export async function sjekkEhfLevering(o: { sending_id: string }) {
  const s = await somSystem((db) => en(db, "select * from faktura.ehf_sendinger where id = $1", [o.sending_id]));
  if (!s || s.status !== "venter" || !s.dokument_id) return;
  const kobling = await somSystem((db) => ehfKobling(db, s.org_id));
  if (!kobling) return;
  const d = await hentDokument(kobling.nokkel, s.dokument_id); // uten svar: oppgaven prøves igjen
  const status = fraLevering(d.deliveryStatus);
  if (status === "venter") {
    const sjekket = s.sjekket + 1;
    await somSystem((db) => db.query("update faktura.ehf_sendinger set sjekket = $2, oppdatert = now() where id = $1", [s.id, sjekket]));
    if (sjekket < VENTETIDER.length) await leggIKo({ type: "sjekk-ehf", sending_id: s.id }, VENTETIDER[sjekket]);
    return;
  }
  const pf = peppolFeil(d);
  await oppdater(s.id, { status, feil_kategori: pf.kategori, detaljer: pf.melding });
  if (status === "feilet") {
    logg("WARNING", "EHF kom ikke fram; sendes på e-post", { faktura_id: s.faktura_id, kategori: pf.kategori });
    await leggIKo({ type: "send-faktura", faktura_id: s.faktura_id, send_epost: true, ehf: false });
  }
}

// Daglig: selskapets status hos Recommand (navn, verifisert, tar imot EHF), og om nøkkelen
// fortsatt virker. Det appen viser under Innstillinger, holdes da oppdatert.
export async function oppdaterEhfKoblinger(): Promise<number> {
  const rader = await somSystem((db) => alle<{ org_id: string; konfig: any }>(db, "select org_id, konfig from faktura.integrasjoner where type = 'peppol' and status = 'aktiv'"));
  let oppdatert = 0;
  for (const r of rader) {
    let feil: string | null = null;
    let konfig = r.konfig;
    try {
      const kobling = await somSystem((db) => ehfKobling(db, r.org_id));
      if (!kobling) continue;
      const s = await finnSelskap(kobling.nokkel, r.konfig.orgnr);
      if (s) konfig = { ...r.konfig, selskap_id: s.id, selskap_navn: s.name, verifisert: s.isVerified, tar_imot: s.isSmpRecipient };
      else feil = `Fant ikke selskapet med org.nr. ${r.konfig.orgnr} på Recommand-kontoen`;
    } catch (e) {
      const f = e as RecommandFeil;
      if (f.status !== 401 && f.status !== 403) continue; // midlertidig feil: prøv i morgen
      feil = f.message;
    }
    await somSystem((db) =>
      db.query("update faktura.integrasjoner set konfig = $2, siste_feil = $3 where org_id = $1 and type = 'peppol'", [r.org_id, JSON.stringify(konfig), feil]),
    );
    oppdatert++;
  }
  return oppdatert;
}
