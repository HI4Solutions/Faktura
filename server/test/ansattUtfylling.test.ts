// Den ansatte fyller ut opplysningene sine selv (0113_ansatte_enklere.sql, ansattUtfylling.ts):
// lederen ber om det med invitasjonen, den ansatte sender inn fra Min side, og lederen avviser
// (med grunn) eller godkjenner (opplysningene skrives på den ansatte, og skattekortet hentes).
// Også de nye feltene på den ansatte (nærmeste pårørende og arbeidsforholdID-en) og at
// a-meldingen bruker arbeidsforholdID-en fra det forrige lønnssystemet.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { en, somSystem } from "../src/db.js";
import { settKryptering } from "../src/kryptering.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";
import { utfyllingFelt } from "../src/ansattUtfylling.js";
import { arbeidsforholdId } from "../src/amelding.js";

describe("utfyllingen (uten database)", () => {
  it("tomme felt er ikke med, og fødselsdatoen følger fødselsnummeret", () => {
    expect(utfyllingFelt({ fnr: "15038510190", telefon: null, adresse: "Storgata 1", kontonr: "86011117947" })).toEqual({
      adresse: "Storgata 1",
      kontonr: "86011117947",
      fodselsdato: "1985-03-15",
    });
    expect(utfyllingFelt({ fodselsdato: "1990-01-02" })).toEqual({ fodselsdato: "1990-01-02" });
    expect(() => utfyllingFelt({ fodselsdato: "2999-01-01" })).toThrow("Fødselsdatoen kan ikke være fram i tid");
  });

  it("a-meldingen bruker arbeidsforholdID-en fra det forrige lønnssystemet, ellers ansattnummeret", () => {
    expect(arbeidsforholdId({ ansattnummer: 3, arbeidsforhold_id: null })).toBe("3");
    expect(arbeidsforholdId({ ansattnummer: 3 })).toBe("3");
    expect(arbeidsforholdId({ ansattnummer: 3, arbeidsforhold_id: "AF-17" })).toBe("AF-17");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("den ansatte fyller ut selv", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-utfyll-eier:utfyll-eier@server.test:mfa";
  const kari = "Bearer test:uid-utfyll-kari:kari.utfyll@server.test";
  const ko: Oppgave[] = [];
  let org: string;
  let kariId: string;
  let eierBruker: string;
  let kariBruker: string;

  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : null };
  };
  const tom = () => ko.splice(0, ko.length);
  const varsler = (liste: Oppgave[]) => liste.filter((o): o is Extract<Oppgave, { type: "varsel" }> => o.type === "varsel").map((o) => o.varsel);
  const eposter = (liste: Oppgave[]) => liste.filter((o): o is Extract<Oppgave, { type: "epost" }> => o.type === "epost");

  beforeAll(async () => {
    settLokalOppgavekjorer(async (o) => void ko.push(o));
    settKryptering(async (t) => Buffer.from(`kryptert:${t}`), async (b) => b.toString().replace("kryptert:", ""));
    org = (await kall("POST", "/api/organisasjoner", { navn: "Utfylling Test AS" })).data.id;
    eierBruker = (await kall("GET", "/api/meg")).data.bruker.id;
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true })).status).toBe(200);
    const a = await kall("POST", `/api/org/${org}/ansatte`, { fornavn: "Kari", etternavn: "Utfyll", epost: "kari.utfyll@server.test", ansatt_fra: "2026-01-01" });
    expect(a.status).toBe(201);
    expect(a.data).toMatchObject({ utfylling: null, utfylling_bedt: null, parorende_navn: null, arbeidsforhold_id: null });
    kariId = a.data.id;
  });

  it("lederen ber den ansatte fylle ut med invitasjonen", async () => {
    tom();
    const inv = await kall("POST", `/api/org/${org}/ansatte/${kariId}/inviter`, { utfylling: true });
    expect(inv.data).toMatchObject({ koblet: false, sendt_til: "kari.utfyll@server.test" });
    const [e] = eposter(tom());
    expect(e!.emne).toBe("Du er invitert til Utfylling Test AS i Admin Konsoll");
    expect(e!.tekst).toContain("fødselsnummer, kontonummer for lønnen, adresse og nærmeste pårørende");
    expect(e!.tekst).toContain(inv.data.lenke);
    expect((await kall("GET", `/api/org/${org}/ansatte/${kariId}`)).data.utfylling_bedt).toBeTruthy();
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.data.lenke.split("/").pop() }, kari)).status).toBe(200);
    kariBruker = (await kall("GET", "/api/meg", undefined, kari)).data.bruker.id;
    expect((await kall("GET", `/api/org/${org}/ansatte/meg`, undefined, kari)).data).toMatchObject({ id: kariId, utfylling: null });
    expect((await kall("GET", `/api/org/${org}/ansatte/meg`, undefined, kari)).data.utfylling_bedt).toBeTruthy();
  });

  it("den ansatte sender inn; lederne får varsel, og den ansatte endrer ikke ansattraden selv", async () => {
    tom();
    expect((await kall("POST", `/api/org/${org}/ansatte/meg/utfylling`, { kontonr: "1234.56.78901" }, kari)).data.error).toBe("Kontonummeret er ikke gyldig (sjekk sifrene)");
    expect((await kall("POST", `/api/org/${org}/ansatte/meg/utfylling`, { telefon: " " }, kari)).data.error).toBe("Fyll ut minst ett felt");
    const r = await kall(
      "POST",
      `/api/org/${org}/ansatte/meg/utfylling`,
      {
        fnr: "150385 10190",
        kontonr: "8601.11.17947",
        adresse: "Storgata 1",
        postnr: "0150",
        poststed: "Oslo",
        telefon: "",
        parorende_navn: "Ola Utfyll",
        parorende_telefon: "99 88 77 66",
      },
      kari,
    );
    expect(r.status).toBe(200);
    expect(r.data.utfylling).toMatchObject({
      status: "levert",
      har_fnr: true,
      avvist_grunn: null,
      felt: { kontonr: "86011117947", adresse: "Storgata 1", postnr: "0150", poststed: "Oslo", parorende_navn: "Ola Utfyll", parorende_telefon: "99 88 77 66", fodselsdato: "1985-03-15" },
    });
    expect(r.data.utfylling.felt.telefon).toBeUndefined();
    // Ikke skrevet på den ansatte før lederen godkjenner.
    expect(r.data).toMatchObject({ kontonr: null, adresse: null, har_fnr: false });
    expect(varsler(tom())).toEqual([
      {
        hendelse: "ansatte",
        org_id: org,
        bruker_ider: [eierBruker],
        tittel: "Opplysninger fra en ansatt",
        tekst: "Kari Utfyll har fylt ut opplysningene sine. Se over og godkjenn dem.",
        url: `/ansatte?ansatt=${kariId}`,
        tag: `utfylling-${kariId}`,
      },
    ]);
    // Den ansatte kan ikke godkjenne selv eller se de andre, og fødselsnummeret er ikke lesbart.
    expect((await kall("POST", `/api/org/${org}/ansatte/${kariId}/utfylling/godkjenn`, undefined, kari)).status).toBe(403);
    expect((await kall("GET", `/api/org/${org}/ansatte`, undefined, kari)).status).toBe(403);
    expect((await kall("GET", `/api/org/${org}/ansatte`)).data.find((a: any) => a.id === kariId).utfylling.status).toBe("levert");
    // Eieren er ikke ansatt og kan ikke sende inn for seg selv.
    expect((await kall("POST", `/api/org/${org}/ansatte/meg/utfylling`, { telefon: "1" })).data.error).toBe("Du er ikke registrert som ansatt i organisasjonen");
  });

  it("lederen avviser med en grunn; den ansatte ser den og får varsel", async () => {
    tom();
    expect((await kall("POST", `/api/org/${org}/ansatte/${kariId}/utfylling/avvis`, { grunn: "" })).data.error).toBe("Skriv hva som må rettes, så den ansatte vet det");
    const r = await kall("POST", `/api/org/${org}/ansatte/${kariId}/utfylling/avvis`, { grunn: "Feil kontonummer" });
    expect(r.status).toBe(200);
    // Fødselsnummeret i innsendingen er fjernet; resten står så den ansatte kan rette det.
    expect(r.data.utfylling).toMatchObject({ status: "avvist", avvist_grunn: "Feil kontonummer", har_fnr: false, felt: { kontonr: "86011117947" } });
    expect(r.data.kontonr).toBeNull();
    expect(varsler(tom())).toEqual([
      expect.objectContaining({ hendelse: "ansatte", bruker_ider: [kariBruker], tittel: "Opplysningene dine må rettes", url: "/meg", tekst: "«Feil kontonummer» Rett dem og send på nytt under Min side." }),
    ]);
    expect((await kall("GET", `/api/org/${org}/ansatte/meg`, undefined, kari)).data.utfylling).toMatchObject({ status: "avvist", avvist_grunn: "Feil kontonummer" });
    expect((await kall("POST", `/api/org/${org}/ansatte/${kariId}/utfylling/godkjenn`)).status).toBe(404);
  });

  it("lederen godkjenner: opplysningene skrives på den ansatte, og skattekortet hentes", async () => {
    await somSystem((db) => db.query("insert into faktura.skattekort_tilgang (org_id, status) values ($1, 'godkjent')", [org]));
    const s = await kall("POST", `/api/org/${org}/ansatte/meg/utfylling`, { fnr: "15038510190", kontonr: "86011117947", adresse: "Storgata 1", parorende_navn: "Ola Utfyll" }, kari);
    expect(s.data.utfylling).toMatchObject({ status: "levert", har_fnr: true, avvist_grunn: null });
    tom();
    const r = await kall("POST", `/api/org/${org}/ansatte/${kariId}/utfylling/godkjenn`);
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({
      kontonr: "86011117947",
      adresse: "Storgata 1",
      parorende_navn: "Ola Utfyll",
      fodselsdato: "1985-03-15",
      har_fnr: true,
      utfylling: null,
      utfylling_bedt: null,
      fornavn: "Kari",
    });
    const lagret = await somSystem((db) => en(db, "select fnr_kryptert from faktura.ansatte where id = $1", [kariId]));
    expect(lagret!.fnr_kryptert.toString()).toBe("kryptert:15038510190");
    const liste = tom();
    expect(liste.filter((o) => o.type === "skattekort-hent")).toEqual([expect.objectContaining({ type: "skattekort-hent", org_id: org, ansatt_ider: [kariId], kilde: "ansatt" })]);
    expect(varsler(liste)).toEqual([expect.objectContaining({ bruker_ider: [kariBruker], tittel: "Opplysningene dine er godkjent" })]);
    expect((await kall("POST", `/api/org/${org}/ansatte/${kariId}/utfylling/godkjenn`)).data.error).toBe("Fant ingen opplysninger som venter på godkjenning");
  });

  it("en ansatt som alt er koblet, får e-post og varsel om å fylle ut", async () => {
    tom();
    const r = await kall("POST", `/api/org/${org}/ansatte/${kariId}/inviter`, { utfylling: true });
    expect(r.data).toEqual({ koblet: true, lenke: null, sendt_til: "kari.utfyll@server.test" });
    const liste = tom();
    const [e] = eposter(liste);
    expect(e!.emne).toBe("Fyll ut opplysningene dine for Utfylling Test AS");
    expect(e!.tekst).toContain(`/meg?org=${org}`);
    expect(varsler(liste)).toEqual([expect.objectContaining({ bruker_ider: [kariBruker], tittel: "Fyll ut opplysningene dine", url: "/meg" })]);
    expect((await kall("GET", `/api/org/${org}/ansatte/${kariId}`)).data.utfylling_bedt).toBeTruthy();
    // Uten utfylling: bare svaret om at den ansatte alt er koblet.
    expect((await kall("POST", `/api/org/${org}/ansatte/${kariId}/inviter`)).data).toEqual({ koblet: true, lenke: null, sendt_til: null });
    expect(tom()).toEqual([]);
    // Den ansatte kan ikke be om det selv, og en som har sluttet, bes ikke om noe.
    expect((await kall("POST", `/api/org/${org}/ansatte/${kariId}/inviter`, { utfylling: true }, kari)).status).toBe(403);
    const per = (await kall("POST", `/api/org/${org}/ansatte`, { fornavn: "Per", etternavn: "Sluttet", epost: "per.sluttet@server.test", ansatt_fra: "2026-01-01", aktiv: false })).data;
    expect((await kall("POST", `/api/org/${org}/ansatte/${per.id}/inviter`, { utfylling: true })).data.error).toBe("Den ansatte har sluttet");
  });

  it("lederen fører pårørende og arbeidsforholdID-en fra det forrige lønnssystemet", async () => {
    expect((await kall("PATCH", `/api/org/${org}/ansatte/${kariId}`, { arbeidsforhold_id: "AF 1" })).data.error).toBe("ArbeidsforholdID-en kan ha høyst 50 tegn, uten mellomrom");
    const r = await kall("PATCH", `/api/org/${org}/ansatte/${kariId}`, { arbeidsforhold_id: "abc-123", parorende_telefon: "12345678" });
    expect(r.data).toMatchObject({ arbeidsforhold_id: "abc-123", parorende_telefon: "12345678", parorende_navn: "Ola Utfyll" });
    expect((await kall("PATCH", `/api/org/${org}/ansatte/${kariId}`, { arbeidsforhold_id: "" })).data.arbeidsforhold_id).toBeNull();
  });
});
