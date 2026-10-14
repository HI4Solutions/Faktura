// Avsenderen i Resend (tjenester.ts): e-posten sendes fra avsenderadressen, og fra reserveadressen
// når Resend sier at avsenderdomenet ikke er verifisert, så fakturaene ikke stopper etter et
// domenebytte. Andre feil sendes videre.
import { describe, expect, it } from "vitest";
import type { Resend } from "resend";
import { avsenderIkkeVerifisert, sendGjennomResend, type EpostMelding } from "../src/tjenester.js";

type Kall = { from: string; idempotencyKey?: string };
const ikkeVerifisert = { name: "validation_error", message: "The adminkonsoll.no domain is not verified. Please, add and verify your domain on https://resend.com/domains" };

// En falsk Resend-klient som svarer med svarene i rekkefølge og husker forespørslene.
function klient(svar: { data: { id: string } | null; error: { name: string; message: string } | null }[]) {
  const kall: Kall[] = [];
  const k = {
    emails: {
      async send(e: { from: string }, valg?: { idempotencyKey?: string }) {
        kall.push({ from: e.from, idempotencyKey: valg?.idempotencyKey });
        return svar.shift() ?? { data: null, error: { name: "application_error", message: "Ingen flere svar" } };
      },
    },
  } as unknown as Pick<Resend, "emails">;
  return { k, kall };
}

const melding: EpostMelding = { fraNavn: 'Nordmann "Eiendom" AS', til: ["kunde@example.no"], emne: "Faktura 1", tekst: "Hei", html: "<p>Hei</p>", idempotensnokkel: "faktura-1" };

describe("avsenderen i Resend", () => {
  it("sender fra avsenderadressen", async () => {
    const { k, kall } = klient([{ data: { id: "re_1" }, error: null }]);
    expect(await sendGjennomResend(k, melding, "post@adminkonsoll.no", "faktura@hi4.no")).toEqual({ id: "re_1" });
    expect(kall).toEqual([{ from: "Nordmann Eiendom AS <post@adminkonsoll.no>", idempotencyKey: "faktura-1" }]);
  });

  it("sender fra reserveadressen når avsenderdomenet ikke er verifisert", async () => {
    const { k, kall } = klient([
      { data: null, error: ikkeVerifisert },
      { data: { id: "re_2" }, error: null },
    ]);
    expect(await sendGjennomResend(k, melding, "post@adminkonsoll.no", "faktura@hi4.no")).toEqual({ id: "re_2" });
    expect(kall).toEqual([
      { from: "Nordmann Eiendom AS <post@adminkonsoll.no>", idempotencyKey: "faktura-1" },
      { from: "Nordmann Eiendom AS <faktura@hi4.no>", idempotencyKey: "faktura-1-reserve" },
    ]);
  });

  it("gir opp når reserveadressen heller ikke virker, og ved andre feil", async () => {
    const begge = klient([
      { data: null, error: ikkeVerifisert },
      { data: null, error: { name: "validation_error", message: "The hi4.no domain is not verified." } },
    ]);
    await expect(sendGjennomResend(begge.k, melding, "post@adminkonsoll.no", "faktura@hi4.no")).rejects.toThrow("Resend: The hi4.no domain is not verified.");
    expect(begge.kall).toHaveLength(2);

    const annen = klient([{ data: null, error: { name: "validation_error", message: "Invalid `to` field." } }]);
    await expect(sendGjennomResend(annen.k, melding, "post@adminkonsoll.no", "faktura@hi4.no")).rejects.toThrow("Resend: Invalid `to` field.");
    expect(annen.kall).toHaveLength(1);

    const utenReserve = klient([{ data: null, error: ikkeVerifisert }]);
    await expect(sendGjennomResend(utenReserve.k, melding, "post@adminkonsoll.no")).rejects.toThrow(/not verified/);
    expect(utenReserve.kall).toHaveLength(1);
  });

  it("kjenner igjen svaret om domenet som ikke er verifisert", () => {
    expect(avsenderIkkeVerifisert(ikkeVerifisert)).toBe(true);
    expect(avsenderIkkeVerifisert({ message: "Rate limit exceeded" })).toBe(false);
    expect(avsenderIkkeVerifisert(null)).toBe(false);
  });
});
