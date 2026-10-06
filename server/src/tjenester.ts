// Tynne grensesnitt mot Google Cloud og Resend, så de kan byttes ut i tester.
import { Storage } from "@google-cloud/storage";
import { CloudTasksClient } from "@google-cloud/tasks";
import { PubSub } from "@google-cloud/pubsub";
import { Resend } from "resend";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

// ---------------------------------------------------------------------------
// Lagring
// ---------------------------------------------------------------------------

let storage: Storage | undefined;
const gcs = () => (storage ??= new Storage());

export interface Lagring {
  hent(bucket: string, sti: string): Promise<Uint8Array | null>;
  lagre(bucket: string, sti: string, data: Uint8Array, type: string): Promise<void>;
  signertUrl(bucket: string, sti: string, minutter: number, filnavn?: string): Promise<string>;
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
  async signertUrl(bucket, sti, minutter, filnavn) {
    const [url] = await gcs()
      .bucket(bucket)
      .file(sti)
      .getSignedUrl({
        version: "v4",
        action: "read",
        expires: Date.now() + minutter * 60_000,
        responseDisposition: filnavn ? `inline; filename="${filnavn}"` : undefined,
      });
    return url;
  },
};

// ---------------------------------------------------------------------------
// Oppgaver til workeren (Cloud Tasks)
// ---------------------------------------------------------------------------

export type Oppgave =
  | { type: "send-faktura"; faktura_id: string; send_epost: boolean }
  | { type: "send-purring"; purring_id: string }
  | { type: "epost"; til: string[]; emne: string; tekst: string; fra_navn?: string; svar_til?: string };

let tasks: CloudTasksClient | undefined;

export type Oppgavekjorer = (o: Oppgave & { oppgave_id: string }) => Promise<void>;
let lokalKjorer: Oppgavekjorer | undefined;

// Lokalt og i tester kjøres oppgaven direkte i stedet for via Cloud Tasks.
export function settLokalOppgavekjorer(k: Oppgavekjorer | undefined) {
  lokalKjorer = k;
}

export async function leggIKo(o: Oppgave): Promise<void> {
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
  kopi?: string[];
  emne: string;
  tekst: string;
  html: string;
  vedlegg?: { filnavn: string; data: Uint8Array }[];
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
    const { data, error } = await resend.emails.send(
      {
        from: `${navn} <${config.epostAvsender}>`,
        to: m.til,
        replyTo: m.svarTil,
        bcc: m.kopi,
        subject: m.emne,
        text: m.tekst,
        html: m.html,
        attachments: m.vedlegg?.map((v) => ({ filename: v.filnavn, content: Buffer.from(v.data) })),
      },
      m.idempotensnokkel ? { idempotencyKey: m.idempotensnokkel } : undefined,
    );
    if (error || !data) throw new Error(`Resend: ${error?.message ?? "ukjent feil"}`);
    return { id: data.id };
  },
};

let aktivEpost: Epost = resendEpost;
export const epost = () => aktivEpost;
export function settEpost(e: Epost) {
  aktivEpost = e;
}
