// Sletting når oppbevaringstiden er ute (oppbevaring.ts, 0124_slett_utlopt.sql): en stengt
// organisasjon med regnskapsmateriale fra 2019 oppbevares til 31.12.2024 og slettes helt av
// morgenjobben. Filene i Cloud Storage slettes under organisasjonens mapper; holder
// oppbevaringsregelen på noen, prøves det igjen neste morgen. Administrasjonen viser slettingen.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { config } from "../src/config.js";
import { slettUtloptMateriale } from "../src/oppbevaring.js";
import { lagring, settLokalOppgavekjorer } from "../src/tjenester.js";

describe.skipIf(!process.env.DATABASE_URL)("sletting når oppbevaringstiden er ute", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-oppb-eier:oppb-eier@server.test:mfa:Ole%20Oppbevar";
  const admin = "Bearer test:uid-oppb-admin:oppb-admin@server.test:mfa";
  const kall: { bucket: string; prefiks: string }[] = [];
  let venter = 1;
  let org = "";
  let aktiv = "";

  const api = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : null };
  };
  const ok = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await api(m, sti, k, hvem);
    expect(r.status, `${m} ${sti}: ${JSON.stringify(r.data)}`).toBeLessThan(300);
    return r.data;
  };
  const slettet = async (id: string) => ((await ok("GET", "/api/admin/slettede", undefined, admin)) as any[]).find((s) => s.id === id);
  const mineKall = (id: string) => kall.filter((k) => k.prefiks.includes(id)).map((k) => `${k.bucket}/${k.prefiks}`);

  beforeAll(async () => {
    settLokalOppgavekjorer(async () => {});
    config.adminEposter.push("oppb-admin@server.test");
    Object.assign(config, { fakturaBucket: "test-fakturaer", filerBucket: "test-filer" });
    // Fakturabøtta holder på filene første gang (oppbevaringsregelen), så er de borte.
    lagring.slettMappe = async (bucket, prefiks) => {
      kall.push({ bucket, prefiks });
      return bucket === "test-fakturaer" && prefiks.includes(org) ? { slettet: 2, venter } : { slettet: 1, venter: 0 };
    };

    // Et bilag fra 2019 og ingenting senere: oppbevares til 31.12.2024.
    org = (await ok("POST", "/api/organisasjoner", { navn: "Gammel Drift AS", orgnr: "315000238" })).id;
    await ok("POST", `/api/org/${org}/regnskap/bilag`, {
      dato: "2019-06-30",
      tekst: "Kontantsalg",
      linjer: [
        { konto: "1920", debet: 1000 },
        { konto: "3000", kredit: 1000 },
      ],
    });
    // Et bilag i år: oppbevares i fem år til.
    aktiv = (await ok("POST", "/api/organisasjoner", { navn: "Nylig Stengt AS", orgnr: "315000246" })).id;
    await ok("POST", `/api/org/${aktiv}/regnskap/bilag`, {
      dato: new Date().toISOString().slice(0, 10),
      tekst: "Kontantsalg",
      linjer: [
        { konto: "1920", debet: 500 },
        { konto: "3000", kredit: 500 },
      ],
    });
    expect((await ok("POST", `/api/org/${org}/slett`, { grunn: "Virksomheten er avviklet" })).oppbevares_til).toBe("2024-12-31");
    expect((await ok("POST", `/api/org/${aktiv}/slett`, { grunn: "Virksomheten er avviklet" })).oppbevares_til).toBe(
      `${new Date().getFullYear() + 5}-12-31`,
    );
  });

  // Den som nettopp ble stengt (den andre kan alt være slettet av en annen test som kjører morgenjobben).
  it("stengt med materialet: står i administrasjonen til den slettes", async () => {
    const s = await slettet(aktiv);
    expect(s).toMatchObject({ navn: "Nylig Stengt AS", materiale_slettet_at: null, filer_slettet_at: null, slettet_av_navn: "Ole Oppbevar" });
  });

  it("morgenjobben sletter organisasjonen der oppbevaringstiden er ute, og filene til de er borte", async () => {
    await slettUtloptMateriale();
    let s = await slettet(org);
    expect(s.materiale_slettet_at).not.toBeNull();
    // Hvem som slettet, er borte; navnet og org.nr. til foretaket står.
    expect(s).toMatchObject({ navn: "Gammel Drift AS", orgnr: "315000238", slettet_av_navn: null, slettet_av_epost: null, filer_slettet_at: null });
    expect(mineKall(org)).toEqual([`test-fakturaer/${org}/`, `test-filer/${org}/`, `test-filer/amelding/${org}/`]);
    // Den som nettopp ble stengt, står urørt.
    expect((await slettet(aktiv)).materiale_slettet_at).toBeNull();
    expect(mineKall(aktiv)).toEqual([]);

    // Neste morgen er filene borte.
    venter = 0;
    await slettUtloptMateriale();
    s = await slettet(org);
    expect(s.filer_slettet_at).not.toBeNull();
    expect(mineKall(org)).toHaveLength(6);
    await slettUtloptMateriale();
    expect(mineKall(org)).toHaveLength(6);
  });

  it("uten bøttene (lokalt) slettes bare databasen", async () => {
    Object.assign(config, { fakturaBucket: undefined, filerBucket: undefined });
    const antall = kall.length;
    expect((await slettUtloptMateriale()).feil).toBe(0);
    expect(kall).toHaveLength(antall);
    Object.assign(config, { fakturaBucket: "test-fakturaer", filerBucket: "test-filer" });
  });
});
