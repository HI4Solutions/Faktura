// Kontaktskjemaet på nettstedet (landingsside/index.html, del 8). Henvendelsen sendes på e-post til
// oss (KONTAKT_EPOST, post@adminkonsoll.no) med avsenderens e-postadresse som svaradresse, så vi
// svarer rett fra innboksen. Ingenting lagres i databasen, og innholdet havner ikke i loggen.
//
// nettsted.js sender skjemaet som JSON og får JSON tilbake. Uten skript sendes det som et vanlig
// skjema, og nettleseren sendes tilbake til forsiden med svaret (#kontakt-sendt eller #kontakt-feil).
// Et skjult felt (nettsted) fanger roboter: de får et vanlig svar, men ingenting sendes.
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { config } from "./config.js";
import { ApiFeil, tilHttp } from "./feil.js";
import { leggIKo } from "./tjenester.js";

const logg = (severity: string, message: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ severity, message, ...data }));

const enLinje = (s: string) => s.replace(/\s+/g, " ").trim();

const FELT = ["navn", "epost", "foretak", "melding", "nettsted"] as const;

export const kontaktSkjema = z.object({
  navn: z.string().transform(enLinje).pipe(z.string().min(1, "Skriv navnet ditt").max(100, "Navnet kan ha høyst 100 tegn")),
  epost: z.string().trim().min(1, "Skriv e-postadressen din").max(254, "E-postadressen er for lang").email("Skriv en gyldig e-postadresse"),
  foretak: z.string().transform(enLinje).pipe(z.string().max(150, "Foretaksnavnet kan ha høyst 150 tegn")),
  melding: z.string().trim().min(10, "Skriv litt mer om hva det gjelder (minst 10 tegn)").max(5000, "Henvendelsen kan ha høyst 5000 tegn"),
  nettsted: z.string(),
});
export type Kontakt = z.infer<typeof kontaktSkjema>;

// Bare feltene i skjemaet, som tekst (et felt som mangler, er tomt).
function felter(kropp: unknown): Record<(typeof FELT)[number], string> {
  const k = (kropp && typeof kropp === "object" ? kropp : {}) as Record<string, unknown>;
  return Object.fromEntries(FELT.map((f) => [f, typeof k[f] === "string" ? k[f] : ""])) as Record<(typeof FELT)[number], string>;
}

// Høyst 5 henvendelser i timen fra samme IP-adresse og 100 i timen i alt (per instans), så skjemaet
// ikke kan brukes til å fylle innboksen.
const PER_IP = 5;
const I_ALT = 100;
const TIME = 3_600_000;
const sendinger = new Map<string, number[]>();
let alleSendinger: number[] = [];

export function begrensKontakt(ip: string, na = Date.now()) {
  const egne = (sendinger.get(ip) ?? []).filter((t) => na - t < TIME);
  alleSendinger = alleSendinger.filter((t) => na - t < TIME);
  if (egne.length >= PER_IP || alleSendinger.length >= I_ALT)
    throw new ApiFeil(429, "For mange henvendelser på kort tid. Prøv igjen senere, eller skriv til post@adminkonsoll.no.");
  egne.push(na);
  alleSendinger.push(na);
  sendinger.set(ip, egne);
  if (sendinger.size > 10_000) sendinger.clear();
}

const ipFra = (c: Context) => c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "ukjent";

export function kontaktEpost(k: Kontakt, na = new Date()) {
  const tid = new Intl.DateTimeFormat("nb-NO", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Oslo" }).format(na);
  const tekst = [
    "Henvendelse fra kontaktskjemaet på nettstedet.",
    "",
    `Navn: ${k.navn}`,
    `E-post: ${k.epost}`,
    ...(k.foretak ? [`Foretak: ${k.foretak}`] : []),
    "",
    k.melding,
    "",
    "--",
    `Sendt ${tid}. Svar på denne e-posten, så går svaret til ${k.epost}.`,
  ].join("\n");
  return {
    til: [config.kontaktEpost],
    emne: `Henvendelse fra ${k.navn}${k.foretak ? `, ${k.foretak}` : ""}`.slice(0, 160),
    tekst,
    fra_navn: "Admin Konsoll – kontaktskjema",
    svar_til: k.epost,
  };
}

// Monteres under /api/offentlig/kontakt (uten innlogging).
export function kontaktRuter() {
  const r = new Hono();
  r.post(
    "/",
    bodyLimit({
      maxSize: 32 * 1024,
      onError: () => {
        throw new ApiFeil(413, "Henvendelsen er for lang");
      },
    }),
    async (c) => {
      const somJson = (c.req.header("content-type") ?? "").toLowerCase().includes("application/json");
      try {
        const kropp = somJson ? await c.req.json().catch(() => ({})) : await c.req.parseBody();
        const k = kontaktSkjema.parse(felter(kropp));
        if (k.nettsted) logg("INFO", "Kontaktskjemaet: en robot fylte ut det skjulte feltet; ingenting ble sendt");
        else {
          begrensKontakt(ipFra(c));
          await leggIKo({ type: "epost", ...kontaktEpost(k) });
          logg("INFO", "Kontaktskjemaet: henvendelsen er lagt i kø som e-post");
        }
        return somJson ? c.json({ ok: true }) : c.redirect("/#kontakt-sendt", 303);
      } catch (e) {
        if (somJson) throw e;
        const { status, error } = tilHttp(e);
        if (status >= 500) console.error(JSON.stringify({ severity: "ERROR", message: (e as Error).message, stack: (e as Error).stack }));
        else logg("INFO", "Kontaktskjemaet: henvendelsen ble ikke sendt", { status, feil: error });
        return c.redirect("/#kontakt-feil", 303);
      }
    },
  );
  return r;
}
