// Kontaktskjemaet på nettstedet (kontakt.ts, landingsside/index.html del 7): henvendelsen legges i
// køen som e-post til post@adminkonsoll.no, med avsenderen som svaradresse. Fra nettsted.js (JSON)
// kommer svaret som JSON; uten skript (vanlig skjema) sendes nettleseren tilbake til forsiden med
// svaret. Roboter som fyller ut det skjulte feltet, får et vanlig svar, men ingenting sendes.
import { beforeEach, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { begrensKontakt, kontaktEpost } from "../src/kontakt.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";

describe("kontaktskjemaet på nettstedet", () => {
  const app = lagApi();
  const ko: any[] = [];
  let nr = 0;
  const nyIp = () => `203.0.113.${++nr}`;

  beforeEach(() => {
    ko.length = 0;
    settLokalOppgavekjorer(async (o) => {
      ko.push(o);
    });
  });

  const somJson = (k: unknown, ip = nyIp()) =>
    app.request("/api/offentlig/kontakt", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `${ip}, 10.0.0.1` },
      body: JSON.stringify(k),
    });
  const somSkjema = (k: Record<string, string>, ip = nyIp()) =>
    app.request("/api/offentlig/kontakt", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip },
      body: new URLSearchParams(k).toString(),
    });
  const feilmelding = async (r: Response) => ((await r.json()) as { error: string }).error;

  const gyldig = {
    navn: "Kari Nordmann",
    epost: "kari@fjordvik.no",
    foretak: "Fjordvik Service AS",
    melding: "Hei! Passer Admin Konsoll for et lite AS med to ansatte?",
    nettsted: "",
  };

  it("legger henvendelsen i køen som e-post til oss, med avsenderen som svaradresse", async () => {
    const r = await somJson(gyldig);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(ko).toHaveLength(1);
    expect(ko[0]).toMatchObject({
      type: "epost",
      til: ["post@adminkonsoll.no"],
      svar_til: "kari@fjordvik.no",
      emne: "Henvendelse fra Kari Nordmann, Fjordvik Service AS",
      fra_navn: "Admin Konsoll – kontaktskjema",
    });
    const linjer = (ko[0].tekst as string).split("\n");
    expect(linjer.slice(0, 7)).toEqual([
      "Henvendelse fra kontaktskjemaet på nettstedet.",
      "",
      "Navn: Kari Nordmann",
      "E-post: kari@fjordvik.no",
      "Foretak: Fjordvik Service AS",
      "",
      "Hei! Passer Admin Konsoll for et lite AS med to ansatte?",
    ]);
    expect(linjer.at(-1)).toMatch(/^Sendt .+\. Svar på denne e-posten, så går svaret til kari@fjordvik\.no\.$/);
  });

  it("navnet og foretaket står på én linje i emnet, og foretaket kan mangle", async () => {
    const r = await somJson({ navn: "  Ola\r\nBcc: x@y.no  ", epost: " ola@eksempel.no ", melding: "Linje én\n\nLinje to, med mer tekst" });
    expect(r.status).toBe(200);
    expect(ko[0]).toMatchObject({ emne: "Henvendelse fra Ola Bcc: x@y.no", svar_til: "ola@eksempel.no" });
    expect(ko[0].tekst).not.toContain("Foretak:");
    expect(ko[0].tekst).toContain("Linje én\n\nLinje to, med mer tekst");
  });

  it("sier fra om felt som mangler eller er feil, og sender ingenting", async () => {
    const tilfeller: [Record<string, unknown>, string][] = [
      [{ ...gyldig, navn: "   " }, "Skriv navnet ditt"],
      [{ ...gyldig, epost: undefined }, "Skriv e-postadressen din"],
      [{ ...gyldig, epost: "kari(at)fjordvik.no" }, "Skriv en gyldig e-postadresse"],
      [{ ...gyldig, melding: "Hei" }, "Skriv litt mer om hva det gjelder (minst 10 tegn)"],
      [{ ...gyldig, melding: "x".repeat(5001) }, "Henvendelsen kan ha høyst 5000 tegn"],
      [{ ...gyldig, foretak: "AS".repeat(80) }, "Foretaksnavnet kan ha høyst 150 tegn"],
      [{ ...gyldig, navn: 42 }, "Skriv navnet ditt"],
    ];
    for (const [k, melding] of tilfeller) {
      const r = await somJson(k);
      expect(r.status, melding).toBe(400);
      expect(await feilmelding(r)).toBe(melding);
    }
    const r = await app.request("/api/offentlig/kontakt", { method: "POST", headers: { "content-type": "application/json" }, body: "{ikke json" });
    expect(r.status).toBe(400);
    expect(ko).toEqual([]);
  });

  it("en robot som fyller ut det skjulte feltet, får et vanlig svar, men ingenting sendes", async () => {
    const r = await somJson({ ...gyldig, nettsted: "https://spam.example" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    const s = await somSkjema({ ...gyldig, nettsted: "https://spam.example" });
    expect(s.status).toBe(303);
    expect(s.headers.get("location")).toBe("/#kontakt-sendt");
    expect(ko).toEqual([]);
  });

  it("uten skript: vanlig skjema, og nettleseren sendes tilbake til forsiden med svaret", async () => {
    const r = await somSkjema(gyldig);
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/#kontakt-sendt");
    expect(ko).toHaveLength(1);
    expect(ko[0]).toMatchObject({ til: ["post@adminkonsoll.no"], svar_til: "kari@fjordvik.no" });

    const f = await somSkjema({ ...gyldig, epost: "ikke en adresse" });
    expect(f.status).toBe(303);
    expect(f.headers.get("location")).toBe("/#kontakt-feil");
    expect(ko).toHaveLength(1);
  });

  it("høyst fem henvendelser i timen fra samme IP-adresse", async () => {
    const ip = nyIp();
    for (let i = 0; i < 5; i++) expect((await somJson(gyldig, ip)).status).toBe(200);
    const r = await somJson(gyldig, ip);
    expect(r.status).toBe(429);
    expect(await feilmelding(r)).toBe("For mange henvendelser på kort tid. Prøv igjen senere, eller skriv til post@adminkonsoll.no.");
    const s = await somSkjema(gyldig, ip);
    expect(s.headers.get("location")).toBe("/#kontakt-feil");
    expect(ko).toHaveLength(5);
    // Andre kan fortsatt skrive.
    expect((await somJson(gyldig)).status).toBe(200);
    expect(ko).toHaveLength(6);
  });

  it("grensen gjelder en time, og høyst 100 i timen i alt", () => {
    // Etter henvendelsene i testene over (de er sendt nå).
    const time = 3_600_000;
    const start = Date.now() + 10 * time;
    for (let i = 0; i < 5; i++) begrensKontakt("198.51.100.1", start + i);
    expect(() => begrensKontakt("198.51.100.1", start + 1000)).toThrow(/For mange henvendelser/);
    expect(() => begrensKontakt("198.51.100.1", start + time + 5)).not.toThrow();
    // I alt: 100 i timen, uansett IP-adresse.
    const senere = start + 2 * time;
    for (let i = 0; i < 100; i++) begrensKontakt(`198.51.100.${(i % 50) + 10}`, senere + i);
    expect(() => begrensKontakt("192.0.2.1", senere + 200)).toThrow(/For mange henvendelser/);
    expect(() => begrensKontakt("192.0.2.1", senere + time + 100)).not.toThrow();
  });

  it("e-posten oppgir tidspunktet i norsk tid", () => {
    const e = kontaktEpost({ ...gyldig, foretak: "" }, new Date("2026-10-17T12:05:00Z"));
    expect(e.emne).toBe("Henvendelse fra Kari Nordmann");
    expect(e.tekst).toContain("Sendt 17. oktober 2026 kl. 14:05.");
  });

  it("for store henvendelser avvises", async () => {
    const r = await somJson({ ...gyldig, melding: "x".repeat(40_000) });
    expect(r.status).toBe(413);
    expect(ko).toEqual([]);
  });
});
