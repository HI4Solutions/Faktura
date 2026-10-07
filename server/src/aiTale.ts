// Tale til tekst: lydopptaket skrives ned ordrett av Gemini, og teksten går tilbake til
// appen. Brukeren ser (og kan rette) teksten før den sendes som et fakturautkast eller en
// kommando til assistenten, så ingenting skjer ut fra noe modellen tror den hørte. Er det
// ingen tale i opptaket (stillhet, støy), sier modellen det i stedet for å gjette.
import type { Context } from "hono";
import { z } from "zod";
import { somBruker } from "./db.js";
import { ApiFeil } from "./feil.js";
import { aiPaa, generer, medKvote, type Del, type Funksjon, type Skjema } from "./ai.js";

// Lydformatene nettlesere tar opp i (MediaRecorder) og Gemini forstår.
export const LYDTYPER: Record<string, string> = {
  "audio/webm": "audio/webm",
  "audio/mp4": "audio/mp4",
  "audio/m4a": "audio/m4a",
  "audio/x-m4a": "audio/m4a",
  "audio/aac": "audio/aac",
  "audio/mpeg": "audio/mpeg",
  "audio/mp3": "audio/mp3",
  "audio/ogg": "audio/ogg",
  "audio/wav": "audio/wav",
  "audio/x-wav": "audio/wav",
  "audio/flac": "audio/flac",
};
export const MAKS_LYD = 4_000_000; // rundt fire minutter tale
const forLangt = () => new ApiFeil(413, "Opptaket er for langt. Hold det under to minutter.");

export type Tale = { tale: boolean; tekst: string };

export const taleSkjema: Skjema = {
  type: "OBJECT",
  properties: {
    tale: { type: "BOOLEAN", description: "true bare når det er tydelig tale i opptaket" },
    tekst: { type: "STRING", description: "Ordrett det som blir sagt, eller tom tekst når det ikke er tale" },
  },
  required: ["tale", "tekst"],
  propertyOrdering: ["tale", "tekst"],
};

export const taleSystem = [
  "Du skriver ned tale på norsk, ordrett. Opptaket er en beskrivelse av en faktura eller en kommando til fakturaprogrammet HI4 Faktura. Svar bare med JSON etter skjemaet.",
  "",
  "- Skriv nøyaktig det som blir sagt, med vanlig tegnsetting. Skriv tall, beløp, datoer og fakturanumre med sifre («1043», «14 500 kroner», «15. oktober»).",
  "- Ikke svar på det som blir sagt, ikke rett på innholdet og ikke legg til noe.",
  "- Er det ingen tydelig tale i opptaket (stillhet, støy, musikk, pust eller bare noen lyder), sett tale til false og tekst til tom tekst. Ikke gjett hva som kanskje ble sagt.",
].join("\n");

// Forespørselen til modellen (ruten under og «Test AI» på adminsiden).
export const taleForesporsel = (lyd: { mimeType: string; data: string }): { system: string; deler: Del[]; skjema: Skjema } => ({
  system: taleSystem,
  deler: [{ text: "Skriv ned det som blir sagt i lydopptaket." }, { inlineData: lyd }],
  skjema: taleSkjema,
});

// Teksten fra modellen, uten merknader som «[stillhet]» og «[uklart]». Tom: ingen tale.
export function talefra(s: Tale): string {
  const tekst = String(s?.tekst ?? "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
  return s?.tale === true && /[\p{L}\p{N}]/u.test(tekst) ? tekst : "";
}

const orgId = (c: Context) => z.string().uuid().parse(c.req.param("org"));

// Ruten for et lydopptak (rå lyd i kroppen, med lydtypen): gir { tekst }. Bruken telles på
// funksjonen opptaket er til, og tilgangen er den samme (skriv for fakturautkast, les for
// assistenten).
export function taleRute(funksjon: Funksjon) {
  return async (c: Context) => {
    if (!aiPaa()) throw new ApiFeil(503, "AI er ikke satt opp");
    const type = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const mime = LYDTYPER[type];
    if (!mime) throw new ApiFeil(400, "Appen kjenner ikke lydformatet. Skriv i stedet.");
    if (Number(c.req.header("content-length") ?? 0) > MAKS_LYD) throw forLangt();
    const data = new Uint8Array(await c.req.arrayBuffer());
    if (data.length < 500) throw new ApiFeil(422, "Opptaket er tomt. Prøv igjen og snakk litt lenger.");
    if (data.length > MAKS_LYD) throw forLangt();
    const svar = await medKvote(
      (fn) => somBruker(c.get("bruker").id, fn),
      orgId(c),
      funksjon,
      () => generer<Tale>(taleForesporsel({ mimeType: mime, data: Buffer.from(data).toString("base64") })),
    );
    const tekst = talefra(svar.data);
    if (!tekst) throw new ApiFeil(422, "Hørte ingen tale. Prøv igjen, eller skriv i stedet.");
    return c.json({ tekst });
  };
}

// Eldre versjoner av appen sendte lyden rett til utkastet eller assistenten.
export const gammelApp = () => new ApiFeil(400, "Appen er oppdatert. Last inn siden på nytt for å bruke tale.");
