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
  // Lenken som bekrefter e-postadressen til en ny konto (koden er laget av API-et).
  | { type: "epostbekreftelse"; bekreftelse_id: string; kode: string }
  // Bank (Enable Banking): ny BankID-adresse, fullfør koblingen, hent innbetalinger, koble fra.
  | { type: "bank-auth"; org_id: string; kobling_id: string; app_url?: string } // app_url: domenet BankID sender tilbake til
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
  // NAV: sykmeldingene og forespørslene om inntektsmelding, og inntektsmeldingen som sendes.
  | { type: "nav-hent"; org_id: string }
  | { type: "nav-inntektsmelding"; org_id: string; inntektsmelding_id: string }
  // Skatteetaten: kravene og betalingene, og fristene (skatteetatenKrav.ts).
  | { type: "skatteetaten-hent"; org_id: string }
  // Årsregnskapet til Brønnøysundregistrene i Altinn (aarsregnskapInnsending.ts): sendingen til
  // signering, statusen til det er signert, og tilbaketrekkingen.
  | { type: "aarsregnskap-send"; org_id: string; aarsregnskap_id: string }
  | { type: "aarsregnskap-status"; org_id: string; aarsregnskap_id: string }
  | { type: "aarsregnskap-tilbake"; org_id: string; aarsregnskap_id: string }
  // Ansatte fra a-ordningen (aordning.ts): avstemmingsrapporten bestilles og hentes (bestilling:
  // den som er bestilt og ikke var klar; forsok: hvor mange ganger den er hentet).
  | { type: "aordning-hent"; org_id: string; bestilling?: string; forsok?: number; maaned?: string }
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

// Alle oppgavetypene. Cloud Tasks poster dem til /oppgaver/<type> på workeren, som må ha en rute
// for hver av dem (testen i oppgaveruter.test.ts); typesjekken sier fra om en type mangler her.
export const OPPGAVETYPER = [
  "send-faktura",
  "sjekk-ehf",
  "send-purring",
  "disk-synk",
  "disk-slett",
  "varsel",
  "epost",
  "epostbekreftelse",
  "bank-auth",
  "bank-okt",
  "bank-hent",
  "bank-slett",
  "skattekort-tilgang",
  "skattekort-status",
  "skattekort-hent",
  "skattekort-svar",
  "altinn-system",
  "altinn-endring",
  "amelding-lag",
  "amelding-status",
  "nav-hent",
  "nav-inntektsmelding",
  "skatteetaten-hent",
  "aarsregnskap-send",
  "aarsregnskap-status",
  "aarsregnskap-tilbake",
  "aordning-hent",
  "rapport-send",
] as const satisfies readonly Oppgave["type"][];
const alleOppgavetyper: Exclude<Oppgave["type"], (typeof OPPGAVETYPER)[number]> extends never ? true : never = true;
void alleOppgavetyper;

let tasks: CloudTasksClient | undefined;

export type Oppgavekjorer = (o: Oppgave & { oppgave_id: string }) => Promise<void>;
let lokalKjorer: Oppgavekjorer | undefined;

// Lokalt og i tester kjøres oppgaven direkte i stedet for via Cloud Tasks.
export function settLokalOppgavekjorer(k: Oppgavekjorer | undefined) {
  lokalKjorer = k;
}

// Workerens egen adresse. WORKER_URL har bare API-et (Terraform kan ikke gi en tjeneste sin egen
// adresse), så workeren tar den fra forespørslene fra Cloud Scheduler, Cloud Tasks og Pub/Sub
// (worker.ts): de kommer til adressen tjenesten har i Terraform, den samme som API-et legger
// oppgavene på. Uten den ble alt workeren selv la i kø (nye forsøk, hjerteslaget, sendingen av
// gjentakende fakturaer), borte.
let egenAdresse: string | undefined;
export function settWorkerAdresse(url: string) {
  egenAdresse = url.replace(/\/+$/, "");
}
export const workerAdresse = () => config.workerUrl ?? egenAdresse;

// forsinkelse: antall sekunder før oppgaven kjøres (lokalt og i tester kjøres den med en gang).
export async function leggIKo(o: Oppgave, forsinkelse?: number): Promise<void> {
  const oppgave = { ...o, oppgave_id: randomUUID() };
  if (lokalKjorer) return lokalKjorer(oppgave);
  const adresse = workerAdresse();
  if (!config.tasksKo || !adresse || !config.tasksInvokerSa) {
    // I produksjon blir oppgaven borte: det skal synes i loggen (uten innholdet i oppgaven).
    if (config.produksjon)
      console.error(
        JSON.stringify({ severity: "ERROR", message: "Oppgaven ble ikke lagt i kø: Cloud Tasks eller adressen til workeren mangler", type: o.type, rolle: config.rolle }),
      );
    else console.warn("Cloud Tasks er ikke konfigurert; oppgaven ble ikke lagt i kø", oppgave);
    return;
  }
  tasks ??= new CloudTasksClient();
  await tasks.createTask({
    parent: config.tasksKo,
    task: {
      ...(forsinkelse ? { scheduleTime: { seconds: Math.floor(Date.now() / 1000) + forsinkelse } } : {}),
      httpRequest: {
        httpMethod: "POST",
        url: `${adresse}/oppgaver/${o.type}`,
        headers: { "Content-Type": "application/json" },
        body: Buffer.from(JSON.stringify(oppgave)).toString("base64"),
        oidcToken: { serviceAccountEmail: config.tasksInvokerSa, audience: adresse },
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

// Slik svarer Resend når avsenderdomenet ikke er verifisert i kontoen.
export const avsenderIkkeVerifisert = (feil: { message?: string } | null | undefined) => /not verified|verify your domain/i.test(feil?.message ?? "");

// Sender én e-post gjennom Resend. Resend tar bare imot noen få e-poster i sekundet: når mange
// fakturaer sendes samtidig, venter vi litt og prøver igjen (idempotensnøkkelen hindrer dobbel
// sending). Er avsenderdomenet ikke verifisert i Resend (f.eks. etter et domenebytte), sendes
// e-posten fra reserveadressen i stedet, så fakturaene ikke stopper.
export async function sendGjennomResend(klient: Pick<Resend, "emails">, m: EpostMelding, avsender: string, reserve?: string): Promise<{ id: string }> {
  const navn = m.fraNavn.replace(/["<>]/g, "");
  let fra = avsender;
  let nokkel = m.idempotensnokkel;
  for (let forsok = 1; ; forsok++) {
    const { data, error } = await klient.emails.send(
      {
        from: `${navn} <${fra}>`,
        to: m.til,
        replyTo: m.svarTil,
        cc: m.kopi?.length ? m.kopi : undefined,
        bcc: m.blindkopi?.length ? m.blindkopi : undefined,
        subject: m.emne,
        text: m.tekst,
        html: m.html,
        attachments: m.vedlegg?.map((v) => ({ filename: v.filnavn, content: Buffer.from(v.data), contentType: v.type })),
      },
      nokkel ? { idempotencyKey: nokkel } : undefined,
    );
    if (data && !error) return { id: data.id };
    if (error?.name === "rate_limit_exceeded" && forsok < 8) {
      await new Promise((ok) => setTimeout(ok, 600 * forsok + Math.random() * 600));
      continue;
    }
    if (reserve && fra !== reserve && avsenderIkkeVerifisert(error)) {
      console.warn(JSON.stringify({ severity: "WARNING", message: "Avsenderdomenet er ikke verifisert i Resend; sender fra reserveadressen", avsender: fra, reserve, feil: error?.message }));
      fra = reserve;
      // Egen nøkkel: Resend kan ha husket den avviste forespørselen.
      nokkel = nokkel ? `${nokkel}-reserve` : undefined;
      continue;
    }
    throw new Error(`Resend: ${error?.message ?? "ukjent feil"}`);
  }
}

export const resendEpost: Epost = {
  async send(m) {
    if (!config.resendNokkel || config.resendNokkel === "ikke-satt") throw new Error("RESEND_API_KEY er ikke satt");
    resend ??= new Resend(config.resendNokkel);
    return sendGjennomResend(resend, m, config.epostAvsender, config.epostAvsenderReserve);
  },
};

let aktivEpost: Epost = resendEpost;
export const epost = () => aktivEpost;
export function settEpost(e: Epost) {
  aktivEpost = e;
}
