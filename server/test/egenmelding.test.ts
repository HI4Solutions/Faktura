// Egenmelding (0071_egenmelding.sql, fravaer.ts): den ansatte sender egenmelding når sykdommen
// meldes eller etterpå (med erklæringen), og lederen får beskjed; reglene gir tydelige feil;
// statusen (reglene, retten etter to måneder, det som er brukt i løpet av 12 måneder og sykt barn
// i år); lederen registrerer sykmelding; regnskap ser ikke dokumentasjonen; reglene i
// innstillingene; og rapporten «Sykefravær og egenmeldinger».
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";
import { virkedag } from "../src/lonnsberegning.js";

const iDag = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());
const dag = (n: number) => new Date(Date.parse(`${iDag()}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!process.env.DATABASE_URL)("egenmelding", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-egm-eier:egm-eier@server.test:mfa";
  const regnskap = "Bearer test:uid-egm-regn:egm-regn@server.test:mfa";
  const ola = "Bearer test:uid-egm-ola:ola.egm@server.test";
  const ko: Oppgave[] = [];
  let org: string;
  let olaId: string;
  let kariId: string;
  let forste: string;
  let papir: string;

  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : null };
  };
  const status = (hvem = ola, ansatt?: string) => kall("GET", `/api/org/${org}/egenmelding${ansatt ? `?ansatt=${ansatt}` : ""}`, undefined, hvem);
  const varsler = () => ko.filter((o) => o.type === "varsel").map((o: any) => o.varsel);

  beforeAll(async () => {
    settLokalOppgavekjorer(async (o) => void ko.push(o));
    org = (await kall("POST", "/api/organisasjoner", { navn: "Egenmelding Test AS" })).data.id;
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true })).status).toBe(200);
    olaId = (await kall("POST", `/api/org/${org}/ansatte`, { fornavn: "Ola", etternavn: "Syk", ansatt_fra: "2025-01-01", epost: "ola.egm@server.test" })).data.id;
    kariId = (await kall("POST", `/api/org/${org}/ansatte`, { fornavn: "Kari", etternavn: "Ny", ansatt_fra: dag(-20) })).data.id;
    const inv = await kall("POST", `/api/org/${org}/ansatte/${olaId}/inviter`);
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.data.lenke.split("/").pop() }, ola)).status).toBe(200);
    const r = await kall("POST", `/api/org/${org}/invitasjoner`, { epost: "egm-regn@server.test", rolle: "regnskap" });
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: r.data.lenke.split("/").pop() }, regnskap)).status).toBe(200);
  });

  it("statusen: reglene, retten etter to måneder og det som er brukt", async () => {
    expect((await status()).data).toEqual({
      ansatt_id: olaId,
      regler: { dager: 3, ganger: 4, dager_aar: null, barn_dager: 3 },
      ansatt_fra: "2025-01-01",
      opptjent_fra: "2025-03-01",
      brukt: { ganger: 0, dager: 0 },
      tilfeller: [],
      sykt_barn: { aar: Number(iDag().slice(0, 4)), dager: 0 },
    });
    // Lederen og regnskap ser statusen til de ansatte; den ansatte bare sin egen.
    expect((await status(eier, kariId)).data).toMatchObject({ ansatt_id: kariId, opptjent_fra: expect.any(String) });
    expect((await status(regnskap, olaId)).status).toBe(200);
    expect((await status(ola, kariId)).status).toBe(404);
    expect((await status(eier)).data.error).toBe("Du er ikke registrert som ansatt her");
  });

  it("den ansatte sender egenmelding når sykdommen meldes, og lederen får beskjed", async () => {
    const ny = { type: "syk", fra: dag(-1), til: iDag(), dokumentasjon: "egenmelding", arbeidsrelatert: false };
    expect((await kall("POST", `/api/org/${org}/fravaer`, ny, ola)).data.error).toBe("Bekreft erklæringen for å sende egenmeldingen");
    ko.length = 0;
    const r = await kall("POST", `/api/org/${org}/fravaer`, { ...ny, erklaering: true }, ola);
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data).toMatchObject({ type: "syk", dokumentasjon: "egenmelding", arbeidsrelatert: false, egenmeldt_selv: true, egenmeldt: expect.any(String) });
    forste = r.data.id;
    expect(varsler()).toEqual([expect.objectContaining({ hendelse: "fravaer", tittel: "Ola Syk er syk", tekst: expect.stringContaining("Egenmelding er sendt.") })]);

    // Fire dager på rad går ikke (lovens tre).
    expect((await kall("PATCH", `/api/org/${org}/fravaer/${forste}`, { til: dag(2) }, ola)).data.error).toBe(
      "En egenmelding kan gjelde høyst 3 dager på rad (kalenderdager, også helg). Lengre sykefravær trenger sykmelding fra lege.",
    );
    // Eldre enn 16 dager kan ikke den ansatte sende.
    expect((await kall("POST", `/api/org/${org}/fravaer`, { ...ny, fra: dag(-30), til: dag(-30), erklaering: true }, ola)).data.error).toBe(
      "Egenmelding kan sendes for sykdom de siste 16 dagene. Snakk med lederen din om eldre fravær.",
    );
    // Og sykmelding registrerer lederen.
    expect((await kall("POST", `/api/org/${org}/fravaer`, { type: "syk", fra: dag(5), til: dag(9), dokumentasjon: "sykmelding" }, ola)).data.error).toBe(
      "Sykmelding fra lege registreres av lederen din",
    );
    const s = (await status()).data;
    expect(s.brukt).toEqual({ ganger: 1, dager: 2 });
    expect(s.tilfeller).toEqual([{ fra: dag(-1), til: iDag(), dager: 2 }]);
  });

  it("egenmelding etterpå, for sykdom lederen har registrert", async () => {
    papir = (await kall("POST", `/api/org/${org}/fravaer`, { ansatt_id: olaId, type: "syk", fra: dag(-8), til: dag(-7) })).data.id;
    const liste = (await kall("GET", `/api/org/${org}/fravaer?fra=${dag(-8)}&til=${dag(-7)}`, undefined, ola)).data;
    expect(liste).toMatchObject([{ id: papir, dokumentasjon: null, egenmeldt: null, egenmeldt_selv: null }]);
    expect((await kall("PATCH", `/api/org/${org}/fravaer/${papir}`, { dokumentasjon: "egenmelding" }, ola)).data.error).toBe(
      "Bekreft erklæringen for å sende egenmeldingen",
    );
    ko.length = 0;
    const r = await kall("PATCH", `/api/org/${org}/fravaer/${papir}`, { dokumentasjon: "egenmelding", erklaering: true, arbeidsrelatert: true }, ola);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ dokumentasjon: "egenmelding", arbeidsrelatert: true, egenmeldt_selv: true });
    expect(varsler()).toEqual([expect.objectContaining({ tittel: "Egenmelding fra Ola Syk", tekst: expect.stringMatching(/^Syk, .+\.$/), url: `/ansatte/${olaId}` })]);
    expect((await status()).data.brukt).toEqual({ ganger: 2, dager: 4 });
    // Den ansatte kan ikke endre den igjen.
    expect((await kall("PATCH", `/api/org/${org}/fravaer/${papir}`, { dokumentasjon: null }, ola)).data.error).toBe("Sykmelding fra lege registreres av lederen din");
  });

  it("lederen registrerer sykmelding, og regnskap ser ikke dokumentasjonen", async () => {
    const r = await kall("PATCH", `/api/org/${org}/fravaer/${papir}`, { dokumentasjon: "sykmelding" });
    expect(r.data).toMatchObject({ dokumentasjon: "sykmelding", egenmeldt: null, egenmeldt_selv: null });
    expect((await status(eier, olaId)).data.brukt).toEqual({ ganger: 1, dager: 2 });
    const hos = (await kall("GET", `/api/org/${org}/fravaer?fra=${dag(-8)}&til=${iDag()}`, undefined, regnskap)).data;
    expect(hos).toHaveLength(2);
    expect(hos.every((f: any) => f.type === "fravaer" && f.dokumentasjon === null && f.arbeidsrelatert === null && f.egenmeldt === null)).toBe(true);
  });

  it("sykt barn, opptjeningen, og reglene i innstillingene", async () => {
    const barn = await kall("POST", `/api/org/${org}/fravaer`, { type: "sykt_barn", fra: dag(-5), til: dag(-4), dokumentasjon: "egenmelding", erklaering: true }, ola);
    expect(barn.status, JSON.stringify(barn.data)).toBe(201);
    const virkedager = [dag(-5), dag(-4)].filter((d) => d.slice(0, 4) === iDag().slice(0, 4) && virkedag(d)).length;
    expect((await status()).data).toMatchObject({ brukt: { ganger: 1, dager: 2 }, sykt_barn: { dager: virkedager } });

    // Kari har vært ansatt i under to måneder (lederen registrerer en egenmelding på papir).
    expect((await kall("POST", `/api/org/${org}/fravaer`, { ansatt_id: kariId, type: "syk", fra: iDag(), til: iDag(), dokumentasjon: "egenmelding" })).data.error).toMatch(
      /^Egenmelding kan brukes etter to måneder i jobben \(fra \d{2}\.\d{2}\.\d{4}\)\. Før det trengs sykmelding fra lege\.$/,
    );

    // Arbeidsgiverens ordning: aldri under loven.
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { egenmelding_dager: 2 })).data.error).toBe("Egenmelding gjelder minst 3 dager per gang (loven)");
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { egenmelding_ganger: 3 })).data.error).toBe("Loven gir minst 4 ganger i løpet av 12 måneder");
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { egenmelding_dager: 8 }, ola)).status).toBe(403);
    const o = await kall("PUT", `/api/org/${org}/lonn-oppsett`, { egenmelding_dager: 8, egenmelding_ganger: null, egenmelding_dager_aar: 24, egenmelding_barn_dager: 5 });
    expect(o.data).toMatchObject({ egenmelding_dager: 8, egenmelding_ganger: null, egenmelding_dager_aar: 24, egenmelding_barn_dager: 5 });
    expect((await status()).data.regler).toEqual({ dager: 8, ganger: null, dager_aar: 24, barn_dager: 5 });
    // Nå går fire dager på rad.
    expect((await kall("PATCH", `/api/org/${org}/fravaer/${forste}`, { til: dag(2) }, ola)).status).toBe(200);
    expect((await status()).data.tilfeller).toEqual([{ fra: dag(-1), til: dag(2), dager: 4 }]);
  });

  it("rapporten «Sykefravær og egenmeldinger»", async () => {
    const r = await kall("GET", `/api/org/${org}/rapportmodul/personal.sykefravaer?fra=${dag(-30)}&til=${dag(5)}`);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.rader).toEqual([
      expect.objectContaining({ navn: "Ola Syk", egenmeldinger: 1, egenmeldt: 4, sykmeldt: 2, udokumentert: 0, sykt_barn: 2, ganger_12: 1, dager_12: 4 }),
    ]);
    expect(r.data.sum).toMatchObject({ egenmeldinger: 1, egenmeldt: 4, sykmeldt: 2, sykt_barn: 2 });
    // Helseopplysninger: bare eier og administrator.
    expect((await kall("GET", `/api/org/${org}/rapportmodul/personal.sykefravaer`, undefined, regnskap)).status).toBe(403);
  });
});
