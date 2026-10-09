// Vaktbytte for lederen (0072_vaktbytte_leder.sql): eieren gir bort eller bytter vakter rett fra
// vaktplanen, uten godkjenning, også med dem som har en annen rolle eller ikke logger inn, og også
// vakter som ikke er publisert. Forhåndsvisningen viser advarslene etter arbeidsmiljøloven uten å
// bytte; byttet gjøres, de to får beskjed (når vaktene er publisert), og en fast arbeidsdag som gis
// bort, blir en vakt hos den som får den. Datoene er i en uke uten helligdager fram i tid.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { uke } from "../src/arbeidstid.js";
import { iDag } from "../src/regler.js";
import { helligdag } from "../src/helligdager.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";

const pluss = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!process.env.DATABASE_URL)("vaktbytte for lederen", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-lederbytte-eier:lederbytte-eier@server.test:mfa";
  const hvem = {
    ola: "Bearer test:uid-lederbytte-ola:ola.lederbytte@server.test",
    kari: "Bearer test:uid-lederbytte-kari:kari.lederbytte@server.test",
  };
  const ko: Oppgave[] = [];
  let org: string;
  const id: Record<string, string> = {};
  const bruker: Record<string, string> = {};
  const vakt: Record<string, string> = {};
  let M = uke(pluss(iDag(), 7)).fra;
  while ([0, 1, 2, 3, 4, 5, 6].some((n) => helligdag(pluss(M, n)))) M = pluss(M, 7);
  const d = (n: number) => pluss(M, n);
  const dag = (iso: string) => new Intl.DateTimeFormat("nb-NO", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${iso}T12:00:00Z`));

  const kall = async (m: string, sti: string, k?: unknown, som = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: som, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : null };
  };
  const varsler = () => ko.filter((o): o is Extract<Oppgave, { type: "varsel" }> => o.type === "varsel").map((o) => o.varsel);
  const nye = (for_: number) => varsler().slice(for_);
  const plan = async () => (await kall("GET", `/api/org/${org}/vakter?fra=${d(0)}&til=${d(6)}`)).data;
  const hvemHar = async (v: string) => (await plan()).vakter.find((x: any) => x.id === v)?.ansatt_navn;
  const bytt = (k: Record<string, unknown>, som = eier) => kall("POST", `/api/org/${org}/vaktbytter/leder`, k, som);

  beforeAll(async () => {
    settLokalOppgavekjorer(async (o) => {
      ko.push(o);
    });
    org = (await kall("POST", "/api/organisasjoner", { navn: "Lederbytte Test AS" })).data.id;
    await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true });
    // Ola og Kari logger inn (sekretær og lege); Per har ikke innlogging.
    for (const [navn, rolle] of [
      ["ola", "Sekretær"],
      ["kari", "Lege"],
      ["per", "Sekretær"],
    ] as const) {
      const fornavn = navn[0]!.toUpperCase() + navn.slice(1);
      const epost = navn === "per" ? undefined : `${navn}.lederbytte@server.test`;
      const a = (await kall("POST", `/api/org/${org}/ansatte`, { fornavn, etternavn: "Bytte", epost, ansatt_fra: pluss(iDag(), -30), rolle })).data;
      id[navn] = a.id;
      if (navn === "per") continue;
      const inv = (await kall("POST", `/api/org/${org}/ansatte/${a.id}/inviter`)).data;
      const h = hvem[navn];
      expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.lenke.split("/").pop() }, h)).status).toBe(200);
      bruker[navn] = (await kall("GET", "/api/meg", undefined, h)).data.bruker.id;
    }
    const ny = async (navn: string, ansatt: string, n: number, fra: string, til: string) => {
      const r = await kall("POST", `/api/org/${org}/vakter`, { ansatt_id: id[ansatt], dato: d(n), fra, til });
      expect(r.status).toBe(201);
      vakt[navn] = r.data.id;
    };
    await ny("olaMan", "ola", 0, "14:00", "22:00");
    await ny("kariMan", "kari", 0, "06:00", "10:00");
    await ny("kariTir", "kari", 1, "06:00", "14:00");
    await ny("olaTir", "ola", 1, "10:00", "18:00");
    await ny("perOns", "per", 2, "08:00", "16:00");
    await ny("kariTor", "kari", 3, "08:00", "16:00");
    expect((await kall("POST", `/api/org/${org}/vakter/publiser`, { fra: d(0), til: d(6) })).status).toBe(200);
    await ny("olaFre", "ola", 4, "09:00", "15:00"); // utkast
  });

  it("bare eier og administrator", async () => {
    expect((await kall("GET", `/api/org/${org}/vaktbytter/leder/muligheter?vakt=${vakt.olaMan}`, undefined, hvem.ola)).status).toBe(403);
    expect((await bytt({ vakt_id: vakt.olaMan, til_ansatt: id.kari }, hvem.ola)).status).toBe(403);
    expect(await hvemHar(vakt.olaMan)).toBe("Ola Bytte");
  });

  it("alle aktive kan få vakten, med rollen og det som hindrer dem, og kollegaens vakter kan byttes mot", async () => {
    const m = await kall("GET", `/api/org/${org}/vaktbytter/leder/muligheter?vakt=${vakt.kariTor}`);
    expect(m.status).toBe(200);
    expect(m.data.rolle).toBe("Lege");
    expect(m.data.kolleger.map((k: any) => [k.navn, k.rolle, k.hindring])).toEqual([
      ["Ola Bytte", "Sekretær", null],
      ["Per Bytte", "Sekretær", null],
    ]);
    expect(m.data.vakter).toEqual([]);
    // Pers vakter: onsdagen (publisert); Kari kan ikke ta en vakt som overlapper hennes egen.
    const k = await kall("GET", `/api/org/${org}/vaktbytter/leder/muligheter?vakt=${vakt.kariTor}&kollega=${id.per}`);
    expect(k.data.vakter.map((v: any) => [v.vakt_id, v.dato, v.fra, v.til, v.publisert, v.hindring])).toEqual([[vakt.perOns, d(2), "08:00", "16:00", true, null]]);
    // Olas vakter, også utkastet: Kari kan ikke få tirsdagen hans, hun har en vakt som overlapper.
    const o = await kall("GET", `/api/org/${org}/vaktbytter/leder/muligheter?vakt=${vakt.kariMan}&kollega=${id.ola}`);
    expect(o.data.vakter.map((v: any) => [v.vakt_id, v.publisert, v.hindring])).toEqual([
      [vakt.olaMan, true, null],
      [vakt.olaTir, true, "Kari Bytte har en annen vakt som overlapper"],
      [vakt.olaFre, false, null],
    ]);
    expect((await kall("GET", `/api/org/${org}/vaktbytter/leder/muligheter`)).status).toBe(400);
  });

  it("forhåndsvisningen viser advarslene uten å bytte; så gis vakten bort, og de to får beskjed", async () => {
    const for_ = varsler().length;
    const f = await bytt({ vakt_id: vakt.olaMan, til_ansatt: id.kari, melding: "Ola er på kurs", forhandsvis: true });
    expect(f.status).toBe(200);
    expect(f.data).toMatchObject({ utfort: false, varslet: false, fra_navn: "Ola Bytte", tatt_av_navn: "Kari Bytte", dato: d(0), fra: "14:00", til: "22:00" });
    // Kari får 12 timer mandag, og bare 8 timer hvile før tirsdagsvakten kl. 06.
    expect(f.data.advarsler).toEqual([`Kari Bytte, ${dag(d(0))}: Over 9 timer denne dagen (overtid)`, `Kari Bytte, ${dag(d(1))}: Bare 8 timer hvile før vakten (minst 11)`]);
    expect(await hvemHar(vakt.olaMan)).toBe("Ola Bytte");
    expect((await kall("GET", `/api/org/${org}/vaktbytter`)).data.bytter).toEqual([]);
    expect(nye(for_)).toEqual([]);

    const g = await bytt({ vakt_id: vakt.olaMan, til_ansatt: id.kari, melding: "Ola er på kurs" });
    expect(g.status).toBe(201);
    expect(g.data).toMatchObject({ utfort: true, varslet: true, status: "godkjent", av_leder: true, fra_navn: "Ola Bytte", tatt_av_navn: "Kari Bytte", mot_vakt_id: null, melding: "Ola er på kurs" });
    expect(g.data.advarsler).toEqual(f.data.advarsler);
    expect(await hvemHar(vakt.olaMan)).toBe("Kari Bytte");
    expect(nye(for_)).toEqual([
      expect.objectContaining({ bruker_ider: [bruker.ola], tittel: "Vakten din er gitt bort", tekst: `Kari Bytte har nå vakten ${dag(d(0))} 14:00–22:00. «Ola er på kurs»`, url: "/vakter?fane=mine" }),
      expect.objectContaining({ bruker_ider: [bruker.kari], tittel: "Du har fått en vakt", tekst: `${dag(d(0))} 14:00–22:00 (fra Ola Bytte). «Ola er på kurs»`, url: "/vakter?fane=mine" }),
    ]);
    // Byttet står i listene som godkjent, med lederen som har gjort det.
    const ola = (await kall("GET", `/api/org/${org}/vaktbytter`, undefined, hvem.ola)).data.bytter;
    expect(ola).toEqual([expect.objectContaining({ id: g.data.id, status: "godkjent", av_leder: true, behandlet_av_navn: expect.any(String) })]);
  });

  it("bytte med en som ikke logger inn: bare den med innlogging får beskjed", async () => {
    const for_ = varsler().length;
    const b = await bytt({ vakt_id: vakt.kariTir, til_ansatt: id.per, mot_vakt_id: vakt.perOns });
    expect(b.status).toBe(201);
    expect(b.data).toMatchObject({ status: "godkjent", mot_vakt_id: vakt.perOns, mot_dato: d(2) });
    expect(await hvemHar(vakt.kariTir)).toBe("Per Bytte");
    expect(await hvemHar(vakt.perOns)).toBe("Kari Bytte");
    expect(nye(for_)).toEqual([
      expect.objectContaining({
        bruker_ider: [bruker.kari],
        tittel: "Vakten din er byttet",
        tekst: `Du har nå ${dag(d(2))} 08:00–16:00 i stedet for ${dag(d(1))} 06:00–14:00 (byttet med Per Bytte).`,
      }),
    ]);
  });

  it("et utkast kan gis bort uten at noen får beskjed før det publiseres", async () => {
    const for_ = varsler().length;
    const b = await bytt({ vakt_id: vakt.olaFre, til_ansatt: id.per });
    expect(b.status).toBe(201);
    expect(b.data.varslet).toBe(false);
    const v = (await plan()).vakter.find((x: any) => x.id === vakt.olaFre);
    expect([v.ansatt_navn, v.publisert]).toEqual(["Per Bytte", false]);
    expect(nye(for_)).toEqual([]);
  });

  it("en fast arbeidsdag gis bort som en vakt, og den som ga den bort, får fri", async () => {
    // Per jobber torsdager 08–12 etter planen.
    const p = await kall("PUT", `/api/org/${org}/ansatte/${id.per}/arbeidsplan`, { gjelder_fra: M, dager: [{ ukedag: 4, fra: "08:00", til: "12:00" }] });
    expect(p.status).toBe(200);
    const m = await kall("GET", `/api/org/${org}/vaktbytter/leder/muligheter?ansatt=${id.per}&dato=${d(3)}`);
    expect(m.data.kolleger.map((k: any) => [k.navn, k.hindring])).toEqual([
      ["Kari Bytte", "Kari Bytte har en annen vakt som overlapper"],
      ["Ola Bytte", null],
    ]);
    const for_ = varsler().length;
    const b = await bytt({ ansatt_id: id.per, dato: d(3), til_ansatt: id.ola });
    expect(b.status).toBe(201);
    expect(b.data).toMatchObject({ dato: d(3), fra: "08:00", til: "12:00", tatt_av_navn: "Ola Bytte" });
    const etter = await plan();
    expect(etter.vakter.filter((v: any) => v.dato === d(3) && v.ansatt_id === id.ola).map((v: any) => `${v.fra}–${v.til}`)).toEqual(["08:00–12:00"]);
    expect(etter.faste.filter((f: any) => f.dato === d(3) && f.ansatt_id === id.per)).toEqual([]);
    expect(nye(for_)).toEqual([expect.objectContaining({ bruker_ider: [bruker.ola], tittel: "Du har fått en vakt", tekst: `${dag(d(3))} 08:00–12:00 (fra Per Bytte).` })]);
  });

  it("feil: overlapp, samme person og et skjema som mangler noe", async () => {
    expect((await bytt({ vakt_id: vakt.kariTor, til_ansatt: id.ola })).data.error).toBe("Ola Bytte har en annen vakt som overlapper");
    expect((await bytt({ vakt_id: vakt.kariTor, til_ansatt: id.ola, forhandsvis: true })).status).toBe(409);
    expect((await bytt({ vakt_id: vakt.kariTor, til_ansatt: id.kari })).data.error).toBe("Velg en annen enn den som har vakten");
    expect((await bytt({ vakt_id: vakt.kariTor })).data.error).toBe("Velg hvem vakten skal til");
    expect((await bytt({ vakt_id: vakt.kariTor, ansatt_id: id.per, dato: d(3), til_ansatt: id.ola })).data.error).toBe("Velg vakten som skal byttes");
    expect((await bytt({ vakt_id: vakt.kariTor, til_ansatt: id.per, mot_vakt_id: vakt.olaMan, mot_dato: d(3) })).data.error).toBe("Velg én vakt å bytte mot");
    expect(await hvemHar(vakt.kariTor)).toBe("Kari Bytte");
  });
});
