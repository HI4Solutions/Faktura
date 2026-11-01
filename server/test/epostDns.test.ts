// E-post fra domenet (epostDns.ts): DKIM-nøkkelen fra Resend og DMARC-oppføringen for
// avsenderdomenet, med DNS byttet ut, og ruten under Plattform → Drift.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { config } from "../src/config.js";
import { settDnsOppslag, sjekkEpostdomene, sjekkEpostdomener } from "../src/epostDns.js";
import { resolveTxt } from "node:dns/promises";

const ikkeFunnet = () => Object.assign(new Error("queryTxt ENOTFOUND"), { code: "ENOTFOUND" });
const DKIM = [["p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC", "abcdef123"]];

// DNS som svarer fra en tabell; navn som ikke står der, finnes ikke.
function dns(tabell: Record<string, string[][] | Error>) {
  settDnsOppslag(async (navn) => {
    const svar = tabell[navn];
    if (!svar) throw ikkeFunnet();
    if (svar instanceof Error) throw svar;
    return svar;
  });
}

describe("e-post fra domenet", () => {
  afterAll(() => settDnsOppslag(resolveTxt));

  it("DKIM og DMARC er på plass", async () => {
    dns({ "resend._domainkey.adminkonsoll.no": DKIM, "_dmarc.adminkonsoll.no": [["v=DMARC1; p=none; rua=mailto:post@adminkonsoll.no; adkim=r; aspf=r"]] });
    expect(await sjekkEpostdomene("post@adminkonsoll.no")).toEqual({
      domene: "adminkonsoll.no",
      adresse: "post@adminkonsoll.no",
      dkim: { ok: true, navn: "resend._domainkey.adminkonsoll.no", feil: null },
      dmarc: {
        ok: true,
        navn: "_dmarc.adminkonsoll.no",
        verdi: "v=DMARC1; p=none; rua=mailto:post@adminkonsoll.no; adkim=r; aspf=r",
        policy: "none",
        feil: null,
        forslag: "v=DMARC1; p=none; rua=mailto:post@adminkonsoll.no; adkim=r; aspf=r",
      },
    });
  });

  it("DMARC mangler: forslaget til oppføringen", async () => {
    dns({ "resend._domainkey.adminkonsoll.no": DKIM, "_dmarc.adminkonsoll.no": [["google-site-verification=abc"]] });
    const s = await sjekkEpostdomene("post@adminkonsoll.no");
    expect(s.dkim.ok).toBe(true);
    expect(s.dmarc).toMatchObject({ ok: false, verdi: null, policy: null, feil: null, forslag: "v=DMARC1; p=none; rua=mailto:post@adminkonsoll.no; adkim=r; aspf=r" });
    dns({ "resend._domainkey.adminkonsoll.no": DKIM });
    expect((await sjekkEpostdomene("post@adminkonsoll.no")).dmarc).toMatchObject({ ok: false, verdi: null, feil: null });
  });

  it("to DMARC-oppføringer, eller en uten policy, er ikke gyldig; quarantine og reject er det", async () => {
    dns({ "_dmarc.adminkonsoll.no": [["v=DMARC1; p=none"], ["v=DMARC1; p=reject"]] });
    expect((await sjekkEpostdomene("post@adminkonsoll.no")).dmarc).toMatchObject({ ok: false, verdi: "2 DMARC-oppføringer (det skal bare være én)", policy: null });
    dns({ "_dmarc.adminkonsoll.no": [["v=DMARC1; rua=mailto:post@adminkonsoll.no"]] });
    expect((await sjekkEpostdomene("post@adminkonsoll.no")).dmarc).toMatchObject({ ok: false, policy: null });
    dns({ "_dmarc.adminkonsoll.no": [["v=DMARC1;p=Quarantine;pct=100"]] });
    expect((await sjekkEpostdomene("post@adminkonsoll.no")).dmarc).toMatchObject({ ok: true, policy: "quarantine" });
    dns({ "_dmarc.adminkonsoll.no": [["v=DMARC1; p=reject"]] });
    expect((await sjekkEpostdomene("post@adminkonsoll.no")).dmarc).toMatchObject({ ok: true, policy: "reject" });
  });

  it("DKIM mangler, og DNS som ikke svarer, sies fra om", async () => {
    dns({ "resend._domainkey.adminkonsoll.no": [["v=DKIM1; k=rsa; p="]], "_dmarc.adminkonsoll.no": Object.assign(new Error("queryTxt ETIMEOUT"), { code: "ETIMEOUT" }) });
    const s = await sjekkEpostdomene("post@adminkonsoll.no");
    expect(s.dkim).toMatchObject({ ok: false, feil: null });
    expect(s.dmarc).toMatchObject({ ok: false, feil: "queryTxt ETIMEOUT" });
  });

  it("avsenderadressen og reserveadressen, ett domene én gang", async () => {
    dns({});
    const s = await sjekkEpostdomener(["post@adminkonsoll.no", "faktura@hi4.no", "kopi@adminkonsoll.no", undefined]);
    expect(s.map((d) => [d.domene, d.adresse])).toEqual([
      ["adminkonsoll.no", "post@adminkonsoll.no"],
      ["hi4.no", "faktura@hi4.no"],
    ]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("e-post fra domenet under Plattform → Drift", () => {
  const app = lagApi();
  const admin = "Bearer test:uid-dns-admin:dns-admin@server.test:mfa";
  const vanlig = "Bearer test:uid-dns-vanlig:dns-vanlig@server.test:mfa";
  const kall = async (hvem: string) => {
    const r = await app.request("/api/admin/epost-dns", { headers: { authorization: hvem } });
    return { status: r.status, data: (await r.json().catch(() => null)) as any };
  };
  beforeAll(() => {
    config.adminEposter.push("dns-admin@server.test");
    dns({ "resend._domainkey.adminkonsoll.no": DKIM });
  });
  afterAll(() => settDnsOppslag(resolveTxt));

  it("bare plattformadministratoren ser den", async () => {
    expect((await kall(vanlig)).status).toBe(403);
    const r = await kall(admin);
    expect(r.status).toBe(200);
    expect(r.data.map((d: any) => d.domene)).toEqual([config.epostAvsender.split("@")[1], config.epostAvsenderReserve.split("@")[1]]);
    expect(r.data[0]).toMatchObject({ dkim: { ok: true }, dmarc: { ok: false, forslag: expect.stringContaining("v=DMARC1; p=none") } });
  });
});
