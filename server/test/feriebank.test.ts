// Feriebank: retten, avviklet og planlagt ferie (regnet av fraværet), og hva som er igjen. Den
// ansatte søker om å overføre dager til neste år, eier og administrator får varsel og godkjenner
// eller avslår, og den ansatte får svar. Regnskap ser ikke feriebanken.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { settKryptering } from "../src/kryptering.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";

describe.skipIf(!process.env.DATABASE_URL)("feriebank", () => {
  const app = lagApi();
  const ko: Oppgave[] = [];
  const eier = "Bearer test:uid-fb-eier:fb-eier@server.test:mfa";
  const regnskap = "Bearer test:uid-fb-regn:fb-regn@server.test:mfa";
  const kari = "Bearer test:uid-fb-kari:kari.fb@server.test";
  const iAar = new Date().getFullYear();
  let org: string;
  let kariId: string;
  let perId: string;

  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : null };
  };
  const varsler = () => ko.flatMap((o) => (o.type === "varsel" ? [o.varsel] : []));

  beforeAll(async () => {
    settLokalOppgavekjorer(async (o) => {
      ko.push(o);
    });
    settKryptering(async (t) => Buffer.from(`kryptert:${t}`), async (b) => b.toString().replace("kryptert:", ""));
    org = (await kall("POST", "/api/organisasjoner", { navn: "Feriebank AS" })).data.id;
    await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true });
    kariId = (await kall("POST", `/api/org/${org}/ansatte`, { fornavn: "Kari", etternavn: "Kake", epost: "kari.fb@server.test", ansatt_fra: "2020-01-01" })).data.id;
    perId = (await kall("POST", `/api/org/${org}/ansatte`, { fornavn: "Per", etternavn: "Pedersen", ansatt_fra: "2020-01-01" })).data.id;
    const inv = await kall("POST", `/api/org/${org}/ansatte/${kariId}/inviter`);
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.data.lenke.split("/").pop() }, kari)).status).toBe(200);
    const r = await kall("POST", `/api/org/${org}/invitasjoner`, { epost: "fb-regn@server.test", rolle: "regnskap" });
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: r.data.lenke.split("/").pop() }, regnskap)).status).toBe(200);
  });

  it("feriedagene per år står i oppsettet og kan settes for den enkelte", async () => {
    expect((await kall("GET", `/api/org/${org}/lonn-oppsett`)).data.ferie_dager).toBe(25);
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { ferie_dager: 21 })).data.ferie_dager).toBe(21);
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { ferie_dager: 20.3 })).status).toBe(400);
    await kall("PUT", `/api/org/${org}/lonn-oppsett`, { ferie_dager: 25 });
    expect((await kall("PATCH", `/api/org/${org}/ansatte/${perId}`, { ferie_dager: 30 })).data.ferie_dager).toBe(30);
    const bank = (await kall("GET", `/api/org/${org}/feriebank?aar=2025`)).data;
    expect(bank.map((b: any) => [b.navn, b.rett, b.egen_rett])).toEqual([
      ["Kari Kake", 25, false],
      ["Per Pedersen", 30, true],
    ]);
  });

  it("ferie som registreres, trekkes fra av seg selv", async () => {
    // Tre uker i juli 2025 og uka med Kristi himmelfartsdag (fire arbeidsdager).
    expect((await kall("POST", `/api/org/${org}/fravaer`, { ansatt_id: kariId, type: "ferie", fra: "2025-07-07", til: "2025-07-25" })).status).toBe(201);
    const f = await kall("POST", `/api/org/${org}/fravaer`, { ansatt_id: kariId, type: "ferie", fra: "2025-05-26", til: "2025-05-30" });
    let k = (await kall("GET", `/api/org/${org}/feriebank/${kariId}?aar=2025`)).data;
    expect([k.saldo.avviklet, k.saldo.igjen]).toEqual([19, 6]);
    expect(k.perioder.map((p: any) => [p.fra, p.dager])).toEqual([
      ["2025-05-26", 4],
      ["2025-07-07", 15],
    ]);
    await kall("DELETE", `/api/org/${org}/fravaer/${f.data.id}`);
    k = (await kall("GET", `/api/org/${org}/feriebank/${kariId}?aar=2025`)).data;
    expect([k.saldo.avviklet, k.saldo.igjen]).toEqual([15, 10]);
  });

  it("den ansatte søker om overføring, eieren får varsel og godkjenner, og den ansatte får svar", async () => {
    // Kari ser bare seg selv.
    expect((await kall("GET", `/api/org/${org}/feriebank`, undefined, kari)).data.map((b: any) => b.navn)).toEqual(["Kari Kake"]);
    expect((await kall("GET", `/api/org/${org}/feriebank/${perId}`, undefined, kari)).status).toBe(404);
    const for_mye = await kall("POST", `/api/org/${org}/ferie/overforinger`, { dager: 26 }, kari);
    expect(for_mye.status).toBe(400);
    expect(for_mye.data.error).toBe(`Det er bare 25 feriedager igjen å overføre fra ${iAar}`);
    expect((await kall("POST", `/api/org/${org}/ferie/overforinger`, { dager: 5, godkjent: true }, kari)).status).toBe(403);

    const s = await kall("POST", `/api/org/${org}/ferie/overforinger`, { dager: 5, begrunnelse: "Travel høst" }, kari);
    expect(s.status).toBe(201);
    expect(s.data).toMatchObject({ ansatt_id: kariId, fra_aar: iAar, dager: 5, status: "venter", min: true });
    const v = varsler().at(-1)!;
    expect(v).toMatchObject({ hendelse: "fravaer", tittel: "Kari Kake søker om å overføre ferie", url: `/ferie?aar=${iAar}` });
    expect(v.tekst).toBe(`5 feriedager fra ${iAar} til ${iAar + 1}. «Travel høst»`);
    expect((await kall("GET", `/api/org/${org}/ferie/overforinger?status=venter`)).data.map((o: any) => o.id)).toEqual([s.data.id]);

    // Bare eier og administrator behandler.
    expect((await kall("POST", `/api/org/${org}/ferie/overforinger/${s.data.id}/behandle`, { godkjent: true }, kari)).status).toBe(403);
    const g = await kall("POST", `/api/org/${org}/ferie/overforinger/${s.data.id}/behandle`, { godkjent: true, svar: "Greit" });
    expect(g.data).toMatchObject({ status: "godkjent", svar: "Greit" });
    expect(varsler().at(-1)).toMatchObject({ tittel: "Ferieoverføring godkjent", tekst: `5 feriedager er overført fra ${iAar} til ${iAar + 1}. «Greit»` });
    expect((await kall("POST", `/api/org/${org}/ferie/overforinger/${s.data.id}/behandle`, { godkjent: false })).status).toBe(409);

    const naa = (await kall("GET", `/api/org/${org}/feriebank/${kariId}?aar=${iAar}`, undefined, kari)).data;
    expect([naa.saldo.overfort_ut, naa.saldo.igjen]).toEqual([5, 20]);
    expect(naa.overforinger.map((o: any) => o.status)).toEqual(["godkjent"]);
    const neste = (await kall("GET", `/api/org/${org}/feriebank/${kariId}?aar=${iAar + 1}`, undefined, kari)).data;
    expect([neste.saldo.overfort_inn, neste.saldo.igjen]).toEqual([5, 30]);
  });

  it("avslag, å trekke en søknad, og eierens egen overføring", async () => {
    const s = (await kall("POST", `/api/org/${org}/ferie/overforinger`, { dager: 2 }, kari)).data;
    const a = await kall("POST", `/api/org/${org}/ferie/overforinger/${s.id}/behandle`, { godkjent: false });
    expect(a.data.status).toBe("avslatt");
    expect(varsler().at(-1)).toMatchObject({ tittel: "Ferieoverføring avslått", tekst: `Søknaden om å overføre 2 feriedager fra ${iAar} er avslått.` });
    const t = (await kall("POST", `/api/org/${org}/ferie/overforinger`, { dager: 1 }, kari)).data;
    expect((await kall("DELETE", `/api/org/${org}/ferie/overforinger/${t.id}`, undefined, kari)).status).toBe(204);
    expect((await kall("DELETE", `/api/org/${org}/ferie/overforinger/${s.id}`, undefined, kari)).status).toBe(404);

    // Eieren overfører for Per med en gang; Per har ingen innlogging, så ingen får varsel.
    const antall = varsler().length;
    const e = await kall("POST", `/api/org/${org}/ferie/overforinger`, { ansatt_id: perId, fra_aar: 2025, dager: 10, godkjent: true });
    expect(e.data).toMatchObject({ status: "godkjent", fra_aar: 2025, min: true });
    expect(varsler().length).toBe(antall);
    expect((await kall("GET", `/api/org/${org}/feriebank?aar=2026`)).data.find((b: any) => b.ansatt_id === perId).overfort_inn).toBe(10);
  });

  it("regnskap ser ikke feriebanken", async () => {
    expect((await kall("GET", `/api/org/${org}/feriebank?aar=2025`, undefined, regnskap)).data).toEqual([]);
    expect((await kall("GET", `/api/org/${org}/ferie/overforinger`, undefined, regnskap)).data).toEqual([]);
    expect((await kall("GET", `/api/org/${org}/feriebank/${kariId}?aar=2025`, undefined, regnskap)).status).toBe(404);
  });
});
