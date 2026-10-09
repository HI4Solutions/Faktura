// Tynne grensesnitt mot Google Cloud og Resend, så de kan byttes ut i tester.
import { Storage } from "@google-cloud/storage";
import { CloudTasksClient } from "@google-cloud/tasks";
import { PubSub } from "@google-cloud/pubsub";
import { Resend } from "resend";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import type { Varsel } from "./push.js";

// ---------------------------------------------------------------------------
// Lagring
// ---------------------------------------------------------------------------

let storage: Storage | undefined;
const gcs = () => (storage ??= new Storage());

export interface Lagring {
  hent(bucket: string, sti: string): Promise<Uint8Array | null>;
  lagre(bucket: string, sti: string, data: Uint8Array, type: string): Promise<void>;
  // valg: hele Content-Disposition (ellers «inline» med filnavnet) og Content-Type.
  signertUrl(bucket: string, sti: string, minutter: number, filnavn?: string, valg?: { disposisjon?: string; type?: string }): Promise<string>;
  slett(bucket: string, sti: string): Promise<void>;
}

export const lagring: Lagring = {
  async hent(bucket, sti) {
    const fil = gcs().bucket(bucket).file(sti);
    const [finnes] = await fil.exists();
    if (!finnes) return null;
    const [data] = await fil.download();
    return new Uint8Array(data);
  },
  async lagre(bucket, sti, data, type) {
    // ifGenerationMatch: 0 – fakturabøtta har oppbevaringsregel, og et utstedt
    // dokument skal aldri overskrives.
    await gcs().bucket(bucket).file(sti).save(Buffer.from(data), {
      contentType: type,
      resumable: false,
      preconditionOpts: { ifGenerationMatch: 0 },
    });
  },
  async signertUrl(bucket, sti, minutter, filnavn, valg) {
    const [url] = await gcs()
      .bucket(bucket)
      .file(sti)
      .getSignedUrl({
        version: "v4",
        action: "read",
        expires: Date.now() + minutter * 60_000,
        responseDisposition: valg?.disposisjon ?? (filnavn ? `inline; filename="${filnavn}"` : undefined),
        responseType: valg?.type,
      });
    return url;
  },
  async slett(bucket, sti) {
    await gcs().bucket(bucket).file(sti).delete({ ignoreNotFound: true });
  },
};

// ---------------------------------------------------------------------------
// Oppgaver til workeren (Cloud Tasks)
// ---------------------------------------------------------------------------

export type Oppgave =
  // ehf: send som EHF når kunden kan ta imot det (standard); false: bare e-post
  | { type: "send-faktura"; faktura_id: string; send_epost: boolean; ehf?: boolean }
  | { type: "sjekk-ehf"; sending_id: string }
  | { type: "send-purring"; purring_id: string }
  | { type: "disk-synk"; bruker_id: string; org_id: string }
  | { type: "disk-slett"; org_id: string; faktura_ider: string[] }
  | { type: "varsel"; varsel: Varsel }
  | { type: "epost"; til: string[]; emne: string; tekst: string; fra_navn?: string; svar_til?: string }
  // Bank (Enable Banking): ny BankID-adresse, fullfør koblingen, hent innbetalinger, koble fra.
  | { type: "bank-auth"; org_id: string; kobling_id: string }
  | { type: "bank-okt"; org_id: string; kobling_id: string; kode: string; psu?: { ip: string; agent: string } }
  | { type: "bank-hent"; org_id: string; kobling_id?: string; psu?: { ip: string; agent: string }; kilde?: "automatisk" | "manuell" | "apnet" | "tilkoblet" }
  | { type: "bank-slett"; org_id: string; okt_ider: string[]; alt?: boolean }
  // Skattekort fra Skatteetaten: forespørselen om tilgang i Altinn, statusen på den, hentingen
  // (daglig: endringene), svaret som ikke var klart, og systemet i Altinns systemregister.
  | { type: "skattekort-tilgang"; org_id: string }
  | { type: "skattekort-status"; org_id: string }
  | { type: "skattekort-hent"; org_id: string; ansatt_ider?: string[]; daglig?: boolean; aar?: number; kilde?: "godkjent" | "manuell" | "automatisk" | "ansatt" }
  | { type: "skattekort-svar"; org_id: string; referanse: string; aar: number; forsok: number }
  | { type: "altinn-system" }
  // Flere tilgangspakker for systembrukeren i Altinn (endringsforespørselen).
  | { type: "altinn-endring"; org_id: string }
  // A-meldingen: fila (XML) eller innsendingen til Skatteetaten, og tilbakemeldingen.
  | { type: "amelding-lag"; org_id: string; amelding_id: string }
  | { type: "amelding-status"; org_id: string; amelding_id: string; forsok?: number }
  // Rapportmodulen: rapporter (CSV og PDF) på e-post til regnskapsføreren.
  | {
      type: "rapport-send";
      org_id: string;
      rapporter: { id: string; valg: { fra?: string; til?: string; aar?: number; termin?: number; kjoring?: string } }[];
      til: string[];
      melding?: string | null;
      bruker_id?: string | null;
      automatisk?: "lonn" | "maaned" | null;
    };

let tasks: CloudTasksClient | undefined;

export type Oppgavekjorer = (o: Oppgave & { oppgave_id: string }) => Promise<void>;
let lokalKjorer: Oppgavekjorer | undefined;

// Lokalt og i tester kjøres oppgaven direkte i stedet for via Cloud Tasks.
export function settLokalOppgavekjorer(k: Oppgavekjorer | undefined) {
  lokalKjorer = k;
}

// forsinkelse: antall sekunder før oppgaven kjøres (lokalt og i tester kjøres den med en gang).
export async function leggIKo(o: Oppgave, forsinkelse?: number): Promise<void> {
  const oppgave = { ...o, oppgave_id: randomUUID() };
  if (lokalKjorer) return lokalKjorer(oppgave);
  if (!config.tasksKo || !config.workerUrl || !config.tasksInvokerSa) {
    console.warn("Cloud Tasks er ikke konfigurert; oppgaven ble ikke lagt i kø", oppgave);
    return;
  }
  tasks ??= new CloudTasksClient();
  await tasks.createTask({
    parent: config.tasksKo,
    task: {
      ...(forsinkelse ? { scheduleTime: { seconds: Math.floor(Date.now() / 1000) + forsinkelse } } : {}),
      httpRequest: {
        httpMethod: "POST",
        url: `${config.workerUrl}/oppgaver/${o.type}`,
        headers: { "Content-Type": "application/json" },
        body: Buffer.from(JSON.stringify(oppgave)).toString("base64"),
        oidcToken: { serviceAccountEmail: config.tasksInvokerSa, audience: config.workerUrl },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Hendelser (Pub/Sub)
// ---------------------------------------------------------------------------

let pubsub: PubSub | undefined;

export async function publiser(hendelse: string, orgId: string, data: unknown, id: string): Promise<void> {
  if (!config.pubsubTopic) return;
  pubsub ??= new PubSub();
  await pubsub.topic(config.pubsubTopic).publishMessage({
    json: data,
    attributes: { hendelse, org_id: orgId, utboks_id: id },
  });
}

// ---------------------------------------------------------------------------
// E-post (Resend). Byttes ut ved å implementere Epost på nytt.
// ---------------------------------------------------------------------------

export interface EpostMelding {
  fraNavn: string;
  til: string[];
  svarTil?: string;
  kopi?: string[]; // synlig kopi (cc)
  blindkopi?: string[]; // bcc
  emne: string;
  tekst: string;
  html: string;
  vedlegg?: { filnavn: string; data: Uint8Array; type?: string }[];
  idempotensnokkel?: string;
}

export interface Epost {
  send(m: EpostMelding): Promise<{ id: string }>;
}

let resend: Resend | undefined;

export const resendEpost: Epost = {
  async send(m) {
    if (!config.resendNokkel || config.resendNokkel === "ikke-satt") throw new Error("RESEND_API_KEY er ikke satt");
    resend ??= new Resend(config.resendNokkel);
    const navn = m.fraNavn.replace(/["<>]/g, "");
    // Resend tar bare imot noen få e-poster i sekundet. Når mange fakturaer sendes samtidig,
    // venter vi litt og prøver igjen (idempotensnøkkelen hindrer dobbel sending).
    for (let forsok = 1; ; forsok++) {
      const { data, error } = await resend.emails.send(
        {
          from: `${navn} <${config.epostAvsender}>`,
          to: m.til,
          replyTo: m.svarTil,
          cc: m.kopi?.length ? m.kopi : undefined,
          bcc: m.blindkopi?.length ? m.blindkopi : undefined,
          subject: m.emne,
          text: m.tekst,
          html: m.html,
          attachments: m.vedlegg?.map((v) => ({ filename: v.filnavn, content: Buffer.from(v.data), contentType: v.type })),
        },
        m.idempotensnokkel ? { idempotencyKey: m.idempotensnokkel } : undefined,
      );
      if (data && !error) return { id: data.id };
      if (error?.name === "rate_limit_exceeded" && forsok < 8) {
        await new Promise((ok) => setTimeout(ok, 600 * forsok + Math.random() * 600));
        continue;
      }
      throw new Error(`Resend: ${error?.message ?? "ukjent feil"}`);
    }
  },
};

let aktivEpost: Epost = resendEpost;
export const epost = () => aktivEpost;
export function settEpost(e: Epost) {
  aktivEpost = e;
}
