// Bekreftelsen av e-postadressen (0105_epostbekreftelse.sql, epostbekreftelse.ts): en ny konto ber
// om lenken før adressen er bekreftet, API-et lager koden og workeren sender den fra Admin Konsoll.
// Statusen fra Resend følger lenken, og plattformadministratoren ser den, kan sende en ny lenke og
// bekrefte adressen for brukeren.
import { beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { lagApi } from "../src/api.js";
import { settIdentitet } from "../src/auth.js";
import { config } from "../src/config.js";
import { bekreftelsesEpost, sendEpostbekreftelse } from "../src/epostbekreftelse.js";
import { settEpost, settLokalOppgavekjorer, type EpostMelding, type Oppgave } from "../src/tjenester.js";

const hemmelighet = "whsec_" + Buffer.from("bekreftelse-hemmelighet-32-byte!").toString("base64");
function signer(id: string, ts: string, kropp: string) {
  const sig = createHmac("sha256", Buffer.from(hemmelighet.slice(6), "base64")).update(`${id}.${ts}.${kropp}`).digest("base64");
  return `v1,${sig}`;
}

describe.skipIf(!process.env.DATABASE_URL)("bekreftelse av e-postadressen", () => {
  const app = lagApi();
  const ko: Oppgave[] = [];
  const sendt: EpostMelding[] = [];
  // Id-ene den falske e-posttjenesten ga (som hos Resend), i samme rekkefølge.
  const ider: string[] = [];
  const bekreftetHos: string[] = [];
  let koder = 0;
  let identitetFeiler: string | null = null;
  const admin = "Bearer test:uid-bek-admin:bek-admin@server.test:mfa";
  // Rett fra registreringen: e-postadressen er ikke bekreftet.
  const unni = "Bearer test:uid-bek-unni:unni.bek@server.test:mfa:Unni%20Ung:venter:ubekreftet";
  const per = "Bearer test:uid-bek-per:per.bek@server.test:mfa:Per%20Pedersen:venter:ubekreftet";
  const perBekreftet = "Bearer test:uid-bek-per:per.bek@server.test:mfa:Per%20Pedersen:venter";
  const kari = "Bearer test:uid-bek-kari:kari.bek@server.test:mfa:Kari%20Kvikk:venter:ubekreftet";

  const kall = async (m: string, sti: string, hvem: string | null, k?: unknown) => {
    const r = await app.request(sti, {
      method: m,
      headers: { ...(hvem ? { authorization: hvem } : {}), "content-type": "application/json" },
      body: k === undefined ? undefined : JSON.stringify(k),
    });
    return { status: r.status, data: (await r.json().catch(() => null)) as any };
  };
  const lenker = () => ko.filter((o): o is Extract<Oppgave, { type: "epostbekreftelse" }> => o.type === "epostbekreftelse");
  const venter = async (epost: string) => ((await kall("GET", "/api/admin/kontoer", admin)).data as any[]).find((k) => k.epost === epost);
  const send = (o: Extract<Oppgave, { type: "epostbekreftelse" }>) => sendEpostbekreftelse({ ...o, oppgave_id: `oppgave-${o.bekreftelse_id}` });

  beforeAll(() => {
    settLokalOppgavekjorer(async (o) => {
      ko.push(o);
    });
    settEpost({
      async send(m) {
        sendt.push(m);
        ider.push(`re_bek_${sendt.length}_${Math.random().toString(36).slice(2)}`);
        return { id: ider.at(-1)! };
      },
    });
    settIdentitet({
      async bekreftelseskode(epost) {
        if (identitetFeiler) throw new Error(identitetFeiler);
        return `kode-${++koder}-${epost.split("@")[0]}`;
      },
      async bekreftEpost(uid) {
        if (identitetFeiler) throw new Error(identitetFeiler);
        bekreftetHos.push(uid);
      },
    });
    config.adminEposter.push("bek-admin@server.test");
    (config as { resendWebhookHemmelighet?: string }).resendWebhookHemmelighet = hemmelighet;
  });

  it("en ny konto får lenken før adressen er bekreftet, høyst én i minuttet", async () => {
    const r = await kall("POST", "/api/meg/bekreftelse", unni);
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ bekreftet: false, sendt: true, til: "unni.bek@server.test" });
    expect(lenker()).toHaveLength(1);
    expect(lenker()[0]!.kode).toMatch(/^kode-\d+-unni\.bek$/);
    const igjen = await kall("POST", "/api/meg/bekreftelse", unni);
    expect(igjen.status).toBe(429);
    expect(igjen.data.error).toBe("Vi sendte en lenke for under ett minutt siden. Vent litt før du ber om en ny.");
    expect(lenker()).toHaveLength(1);
    // Ellers er alt annet stengt til adressen er bekreftet.
    expect((await kall("POST", "/api/organisasjoner", unni, { navn: "Unnis firma AS", orgnr: "811000248" })).data.error).toBe("Bekreft e-postadressen din først");
  });

  it("workeren sender lenken fra Admin Konsoll, én gang", async () => {
    const o = lenker()[0]!;
    await send(o);
    expect(sendt).toHaveLength(1);
    const e = sendt[0]!;
    expect(e).toMatchObject({ fraNavn: "Admin Konsoll", til: ["unni.bek@server.test"], emne: "Bekreft e-postadressen din i Admin Konsoll" });
    expect(e.idempotensnokkel).toBe(`epostbekreftelse-${o.bekreftelse_id}`);
    const lenke = `${config.appUrl}/bekreft-epost?kode=${o.kode}`;
    expect(e.tekst).toContain("Hei Unni,");
    expect(e.tekst).toContain(lenke);
    expect(e.html).toContain(`href="${lenke}"`);
    expect(e.html).toContain("Bekreft e-postadressen</a>");
    // Kjøres oppgaven igjen (Cloud Tasks prøver på nytt), sendes den ikke en gang til.
    await send(o);
    expect(sendt).toHaveLength(1);
    expect((await venter("unni.bek@server.test")).bekreftelse).toMatchObject({ status: "sendt", av_admin: false, antall: 1 });
  });

  it("hilsenen tar bare med fornavnet når det ser ut som et navn", () => {
    expect(bekreftelsesEpost("Åse-Marie O'Neil", "https://x/l").tekst).toMatch(/^Hei Åse-Marie,/);
    expect(bekreftelsesEpost("https://svindel.example/logg-inn Ola", "https://x/l").tekst).toMatch(/^Hei,\n/);
    expect(bekreftelsesEpost("svindel.example Ola", "https://x/l").tekst).toMatch(/^Hei,\n/);
    expect(bekreftelsesEpost("<b>Ola</b>", "https://x/l").html).not.toContain("<b>Ola");
    expect(bekreftelsesEpost(null, "https://x/l").tekst).toMatch(/^Hei,\n/);
  });

  it("statusen fra Resend følger lenken", async () => {
    const hendelse = async (type: string, data: Record<string, unknown>) => {
      const kropp = JSON.stringify({ type, data });
      const ts = String(Math.floor(Date.now() / 1000));
      const id = `msg_${Math.random().toString(36).slice(2)}`;
      const r = await app.request("/api/offentlig/resend", {
        method: "POST",
        body: kropp,
        headers: { "svix-id": id, "svix-timestamp": ts, "svix-signature": signer(id, ts, kropp) },
      });
      expect(r.status).toBe(200);
    };
    const id = ider[sendt.map((m) => m.til[0]).lastIndexOf("unni.bek@server.test")]!;
    await hendelse("email.delivered", { email_id: id });
    expect((await venter("unni.bek@server.test")).bekreftelse.status).toBe("levert");
    await hendelse("email.bounced", { email_id: id, bounce: { message: "Mailbox full" } });
    expect((await venter("unni.bek@server.test")).bekreftelse).toMatchObject({ status: "sprett", detaljer: "Mailbox full" });
  });

  it("går det ikke å lage lenken, får brukeren beskjed og administratoren ser det", async () => {
    identitetFeiler = "TOO_MANY_ATTEMPTS_TRY_LATER";
    const r = await kall("POST", "/api/meg/bekreftelse", per);
    identitetFeiler = null;
    expect(r.status).toBe(502);
    expect(r.data.error).toBe("Vi fikk ikke sendt lenken. Prøv igjen om litt.");
    expect((await venter("per.bek@server.test")).bekreftelse).toMatchObject({ status: "feilet", detaljer: "TOO_MANY_ATTEMPTS_TRY_LATER" });
    // Den som feilet, teller ikke mot minuttet.
    expect((await kall("POST", "/api/meg/bekreftelse", per)).data).toMatchObject({ sendt: true });
    expect((await venter("per.bek@server.test")).bekreftelse).toMatchObject({ status: "venter", antall: 2 });
  });

  it("serveren husker om adressen er bekreftet, og en bekreftet adresse trenger ingen lenke", async () => {
    expect((await venter("per.bek@server.test")).epost_bekreftet).toBe(false);
    const før = lenker().length;
    expect((await kall("POST", "/api/meg/bekreftelse", perBekreftet)).data).toEqual({ bekreftet: true, sendt: false });
    expect(lenker()).toHaveLength(før);
    expect((await venter("per.bek@server.test")).epost_bekreftet).toBe(true);
    // Et eldre token fra før bekreftelsen gjør den ikke ubekreftet igjen.
    await kall("GET", "/api/meg", per);
    expect((await venter("per.bek@server.test")).epost_bekreftet).toBe(true);
  });

  it("bare plattformadministratoren sender lenker for andre og bekrefter adressen for dem", async () => {
    await kall("GET", "/api/meg", kari);
    const k = await venter("kari.bek@server.test");
    expect(k).toMatchObject({ epost_bekreftet: false, bekreftelse: null });
    expect((await kall("POST", `/api/admin/brukere/${k.id}/epostbekreftelse`, kari)).status).toBe(403);
    expect((await kall("POST", `/api/admin/brukere/${k.id}/bekreft-epost`, kari)).status).toBe(403);
    // En ny lenke, uten minuttgrensen.
    expect((await kall("POST", `/api/admin/brukere/${k.id}/epostbekreftelse`, admin)).data).toEqual({ sendt: true, til: "kari.bek@server.test" });
    expect((await kall("POST", `/api/admin/brukere/${k.id}/epostbekreftelse`, admin)).data).toEqual({ sendt: true, til: "kari.bek@server.test" });
    expect((await venter("kari.bek@server.test")).bekreftelse).toMatchObject({ status: "venter", av_admin: true, antall: 2 });
    expect(lenker().at(-1)!.kode).toMatch(/kari\.bek$/);
    // Sier Identity Platform nei, lagres ingenting.
    identitetFeiler = "USER_NOT_FOUND";
    expect((await kall("POST", `/api/admin/brukere/${k.id}/bekreft-epost`, admin)).status).toBe(500);
    identitetFeiler = null;
    expect((await venter("kari.bek@server.test")).epost_bekreftet).toBe(false);
    // Bekreftet hos Identity Platform og hos oss.
    expect((await kall("POST", `/api/admin/brukere/${k.id}/bekreft-epost`, admin)).data).toEqual({ id: k.id, epost: "kari.bek@server.test", epost_bekreftet: true });
    expect(bekreftetHos).toEqual(["uid-bek-kari"]);
    expect((await venter("kari.bek@server.test")).epost_bekreftet).toBe(true);
    expect((await kall("GET", "/api/admin/brukere", admin)).data.find((b: any) => b.id === k.id)).toMatchObject({ epost_bekreftet: true });
    // Nå trengs ingen lenke.
    const r = await kall("POST", `/api/admin/brukere/${k.id}/epostbekreftelse`, admin);
    expect(r.status).toBe(409);
    expect(r.data.error).toBe("E-postadressen er alt bekreftet");
    expect((await kall("POST", `/api/admin/brukere/00000000-0000-4000-8000-000000000000/bekreft-epost`, admin)).status).toBe(404);
  });
});
