// Tavle, fravær og vikarer: faser og oppgaver som organisasjonen lager selv, dagens tavle med
// ressursene fra vaktplanen, plasseringer, sykdom meldt av den ansatte (eier og administrator
// får varsel), ferie registrert av leder (den ansatte får beskjed), og vikar som settes inn
// på vakten, får varsel og tar over plassene på tavla.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { uke } from "../src/arbeidstid.js";
import { iDag } from "../src/regler.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";

const pluss = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!process.env.DATABASE_URL)("tavle, fravær og vikarer", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-tavle-eier:tavle-eier@server.test:mfa";
  const ola = "Bearer test:uid-tavle-ola:ola.tavle@server.test";
  const kari = "Bearer test:uid-tavle-kari:kari.tavle@server.test";
  const vera = "Bearer test:uid-tavle-vera:vera.tavle@server.test";
  const fakturerer = "Bearer test:uid-tavle-fakt:tavle-fakt@server.test:mfa";
  const ko: Oppgave[] = [];
  let org: string;
  const id: Record<string, string> = {};
  const bruker: Record<string, string> = {};
  // Neste uke (alltid fram i tid): mandag, tirsdag, onsdag.
  const M = uke(pluss(iDag(), 7)).fra;
  const d = (n: number) => pluss(M, n);

  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : null };
  };
  const varsler = () => ko.filter((o): o is Extract<Oppgave, { type: "varsel" }> => o.type === "varsel").map((o) => o.varsel);
  const nye = (for_: number) => varsler().slice(for_);
  const tavle = async (dato = d(0)) => (await kall("GET", `/api/org/${org}/tavle?dato=${dato}`)).data;

  beforeAll(async () => {
    settLokalOppgavekjorer(async (o) => {
      ko.push(o);
    });
    org = (await kall("POST", "/api/organisasjoner", { navn: "Tavle Test AS" })).data.id;
    bruker.eier = (await kall("GET", "/api/meg")).data.bruker.id;
    await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true });
    for (const [navn, hvem, ekstra] of [
      ["Ola", ola, {}],
      ["Kari", kari, {}],
      ["Vera", vera, { ansettelsestype: "tilkalling", lonnstype: "time" }],
    ] as const) {
      const a = (await kall("POST", `/api/org/${org}/ansatte`, { fornavn: navn, etternavn: "Nordmann", epost: `${navn.toLowerCase()}.tavle@server.test`, ansatt_fra: pluss(iDag(), -30), ...ekstra })).data;
      const inv = (await kall("POST", `/api/org/${org}/ansatte/${a.id}/inviter`)).data;
      expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.lenke.split("/").pop() }, hvem)).status).toBe(200);
      id[navn] = a.id;
      bruker[navn] = (await kall("GET", "/api/meg", undefined, hvem)).data.bruker.id;
    }
    // Vakter mandag: Ola på dagen, Kari på kvelden; publisert.
    id.olaVakt = (await kall("POST", `/api/org/${org}/vakter`, { ansatt_id: id.Ola, dato: d(0), fra: "07:00", til: "15:00", oppgave: "Kasse" })).data.id;
    id.kariVakt = (await kall("POST", `/api/org/${org}/vakter`, { ansatt_id: id.Kari, dato: d(0), fra: "14:00", til: "22:00" })).data.id;
    await kall("POST", `/api/org/${org}/vakter/publiser`, { fra: d(0), til: d(6) });
  });

  it("faser og oppgaver lages av eier og administrator, i den rekkefølgen de vil", async () => {
    const ny = async (sti: string, k: unknown) => {
      const r = await kall("POST", `/api/org/${org}/tavle/${sti}`, k);
      expect(r.status).toBe(201);
      return r.data.id as string;
    };
    id.senvakt = await ny("faser", { navn: "Senvakt", fra: "14:00", til: "22:00" });
    id.forvakt = await ny("faser", { navn: "Forvakt", fra: "07:00", til: "15:00" });
    id.telefon = await ny("oppgaver", { navn: "Telefon", behov: 2 });
    id.lab = await ny("oppgaver", { navn: "Lab" });
    id.resepsjon = await ny("oppgaver", { navn: "Resepsjon" });
    expect((await kall("POST", `/api/org/${org}/tavle/faser`, { navn: "Halv", fra: "08:00" })).data.error).toBe("Skriv både fra og til, eller ingen av dem");
    expect((await kall("POST", `/api/org/${org}/tavle/oppgaver`, { navn: " " })).data.error).toBe("Skriv et navn på oppgaven");
    expect((await kall("POST", `/api/org/${org}/tavle/rekkefolge`, { type: "faser", ider: [id.forvakt, id.senvakt] })).status).toBe(204);
    expect((await kall("PATCH", `/api/org/${org}/tavle/oppgaver/${id.resepsjon}`, { behov: 1 })).status).toBe(204);
    const oppsett = (await kall("GET", `/api/org/${org}/tavle/oppsett`)).data;
    expect(oppsett.faser.map((f: any) => [f.navn, f.fra, f.til])).toEqual([
      ["Forvakt", "07:00", "15:00"],
      ["Senvakt", "14:00", "22:00"],
    ]);
    expect(oppsett.oppgaver.map((o: any) => [o.navn, o.behov])).toEqual([
      ["Telefon", 2],
      ["Lab", null],
      ["Resepsjon", 1],
    ]);
    // Den ansatte ser oppsettet, men endrer det ikke.
    expect((await kall("GET", `/api/org/${org}/tavle/oppsett`, undefined, ola)).data.faser).toHaveLength(2);
    expect((await kall("POST", `/api/org/${org}/tavle/oppgaver`, { navn: "Kaffe" }, ola)).status).toBe(403);
  });

  it("dagens tavle har ressursene fra vaktplanen, og de plasseres i oppgavene", async () => {
    const t = await tavle();
    expect(t.ressurser.map((r: any) => [r.navn, r.vakter.map((v: any) => `${v.fra}–${v.til}`), r.fravaer])).toEqual([
      ["Ola Nordmann", ["07:00–15:00"], null],
      ["Kari Nordmann", ["14:00–22:00"], null],
    ]);
    const plasser = (k: Record<string, unknown>) => kall("PUT", `/api/org/${org}/tavle/plassering`, { dato: d(0), ...k });
    expect((await plasser({ fase_id: id.forvakt, ansatt_id: id.Ola, oppgave_id: id.telefon })).status).toBe(204);
    expect((await plasser({ fase_id: id.senvakt, ansatt_id: id.Kari, oppgave_id: id.lab })).status).toBe(204);
    // Flytt Kari til telefon, og ta henne ut igjen.
    expect((await plasser({ fase_id: id.senvakt, ansatt_id: id.Kari, oppgave_id: id.telefon })).status).toBe(204);
    expect((await tavle()).plasseringer.find((p: any) => p.ansatt_id === id.Kari).oppgave_id).toBe(id.telefon);
    expect((await plasser({ fase_id: id.senvakt, ansatt_id: id.Kari, oppgave_id: null })).status).toBe(204);
    expect((await plasser({ fase_id: id.senvakt, ansatt_id: id.Kari, oppgave_id: id.lab })).status).toBe(204);
    expect((await tavle()).plasseringer).toHaveLength(2);
    // Andre roller: den ansatte endrer ikke tavla, og den som bare fakturerer, ser den ikke.
    expect((await kall("PUT", `/api/org/${org}/tavle/plassering`, { dato: d(0), fase_id: id.forvakt, ansatt_id: id.Ola, oppgave_id: id.lab }, ola)).status).toBe(403);
    const inv = await kall("POST", `/api/org/${org}/invitasjoner`, { epost: "tavle-fakt@server.test", rolle: "fakturerer" });
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.data.lenke.split("/").pop() }, fakturerer)).status).toBe(200);
    expect((await kall("GET", `/api/org/${org}/tavle?dato=${d(0)}`, undefined, fakturerer)).status).toBe(403);
  });

  it("den ansatte melder seg syk: eier og administrator får varsel, og vakten mangler vikar", async () => {
    const for_ = varsler().length;
    const syk = await kall("POST", `/api/org/${org}/fravaer`, { type: "syk", fra: d(0), til: d(1) }, ola);
    expect(syk.status).toBe(201);
    expect(syk.data).toMatchObject({ ansatt_id: id.Ola, type: "syk", fra: d(0), til: d(1), vakter: [expect.objectContaining({ id: id.olaVakt, fra: "07:00" })] });
    id.syk = syk.data.id;
    expect(nye(for_)).toEqual([
      expect.objectContaining({ hendelse: "fravaer", bruker_ider: [bruker.eier], tittel: "Ola Nordmann er syk", tekst: expect.stringMatching(/1 vakt trenger vikar\.$/), url: `/vakter?fane=tavle&dato=${d(0)}` }),
    ]);
    // Ferie kan ikke meldes selv, og ikke for andre.
    expect((await kall("POST", `/api/org/${org}/fravaer`, { type: "ferie", fra: d(3), til: d(4) }, ola)).data.error).toBe("Du kan bare melde sykdom selv");
    expect((await kall("POST", `/api/org/${org}/fravaer`, { ansatt_id: id.Kari, type: "syk", fra: d(3), til: d(3) }, ola)).status).toBe(403);

    // Tavla: Ola er merket syk, plassen hans står (men teller ikke), og vakten mangler vikar.
    const t = await tavle();
    expect(t.ressurser.find((r: any) => r.ansatt_id === id.Ola).fravaer).toBe("syk");
    expect(t.fravaer.map((f: any) => [f.navn, f.type])).toEqual([["Ola Nordmann", "syk"]]);
    expect(t.mangler_vikar).toEqual([expect.objectContaining({ vakt_id: id.olaVakt, navn: "Ola Nordmann", fra: "07:00", til: "15:00", type: "syk" })]);
    expect((await kall("PUT", `/api/org/${org}/tavle/plassering`, { dato: d(0), fase_id: id.senvakt, ansatt_id: id.Ola, oppgave_id: id.lab })).data.error).toBe(
      "Ola Nordmann er borte denne dagen (syk)",
    );
    // Vaktplanen: vakten er merket, og teller ikke i advarslene.
    const plan = (await kall("GET", `/api/org/${org}/vakter?fra=${d(0)}&til=${d(6)}`)).data;
    expect(plan.vakter.find((v: any) => v.id === id.olaVakt)).toMatchObject({ fravaer: "syk", har_vikar: false });
    expect(plan.fravaer.map((f: any) => f.type)).toEqual(["syk"]);
  });

  it("en vikar settes inn: får varsel og tar over plassene på tavla", async () => {
    const for_ = varsler().length;
    expect((await kall("POST", `/api/org/${org}/vakter/${id.olaVakt}/vikar`, { ansatt_id: id.Ola })).data.error).toBe("Velg en annen enn den som har vakten");
    const v = await kall("POST", `/api/org/${org}/vakter/${id.olaVakt}/vikar`, { ansatt_id: id.Vera });
    expect(v.status).toBe(201);
    expect(v.data).toMatchObject({ ansatt_id: id.Vera, fra: "07:00", til: "15:00", oppgave: "Kasse", publisert: true, vikar_for: id.olaVakt, vikar_for_navn: "Ola Nordmann", notat: "Vikar for Ola Nordmann" });
    id.veraVakt = v.data.id;
    expect(nye(for_)).toEqual([expect.objectContaining({ hendelse: "vakter", bruker_ider: [bruker.Vera], tittel: "Ny vakt", tekst: expect.stringContaining("07:00–15:00 (Kasse)") })]);
    const t = await tavle();
    expect(t.mangler_vikar).toEqual([]);
    expect(t.plasseringer).toEqual(expect.arrayContaining([expect.objectContaining({ ansatt_id: id.Vera, fase_id: id.forvakt, oppgave_id: id.telefon })]));
    expect(t.ressurser.find((r: any) => r.ansatt_id === id.Vera).vakter[0]).toMatchObject({ vikar: true });
    expect((await kall("GET", `/api/org/${org}/vakter?fra=${d(0)}&til=${d(0)}`)).data.vakter.find((x: any) => x.id === id.olaVakt).har_vikar).toBe(true);
    // Vera ser vakten sin (men ikke hvem som er borte, utover notatet).
    expect((await kall("GET", `/api/org/${org}/vakter?fra=${d(0)}&til=${d(0)}`, undefined, vera)).data.vakter).toEqual([
      expect.objectContaining({ id: id.veraVakt, vikar_for_navn: null, notat: "Vikar for Ola Nordmann", fravaer: null }),
    ]);
    // Vikarvakter kopieres ikke til neste uke.
    expect((await kall("POST", `/api/org/${org}/vakter/kopier`, { fra: d(0), til: d(7) })).data).toEqual({ kopiert: 2, hoppet_over: 0 });
  });

  it("ferie registreres av leder: den ansatte får beskjed, og ser bare sitt eget fravær", async () => {
    const for_ = varsler().length;
    const f = await kall("POST", `/api/org/${org}/fravaer`, { ansatt_id: id.Kari, type: "ferie", fra: d(2), til: d(4), notat: "Høstferie" });
    expect(f.status).toBe(201);
    expect(nye(for_)).toEqual([expect.objectContaining({ hendelse: "fravaer", bruker_ider: [bruker.Kari], tittel: "Ferie registrert" })]);
    expect((await kall("POST", `/api/org/${org}/fravaer`, { ansatt_id: id.Kari, type: "syk", fra: d(3), til: d(3) })).data.error).toBe("Den ansatte har allerede fravær i perioden");
    expect((await kall("POST", `/api/org/${org}/fravaer`, { ansatt_id: id.Kari, type: "ferie", fra: d(4), til: d(2) })).data.error).toBe("Sluttdatoen er før startdatoen");
    expect((await kall("GET", `/api/org/${org}/fravaer?fra=${d(0)}&til=${d(6)}`)).data.map((x: any) => [x.ansatt_navn, x.type])).toEqual([
      ["Ola Nordmann", "syk"],
      ["Kari Nordmann", "ferie"],
    ]);
    expect((await kall("GET", `/api/org/${org}/fravaer?fra=${d(0)}&til=${d(6)}`, undefined, kari)).data.map((x: any) => x.type)).toEqual(["ferie"]);
    expect((await kall("GET", `/api/org/${org}/fravaer?fra=${d(0)}&til=${d(6)}`, undefined, fakturerer)).data).toEqual([]);
    // Den ansatte friskmelder seg (endrer sluttdatoen) og kan slette sin egen sykmelding.
    expect((await kall("PATCH", `/api/org/${org}/fravaer/${id.syk}`, { til: d(0) }, ola)).data).toMatchObject({ til: d(0) });
    expect((await kall("PATCH", `/api/org/${org}/fravaer/${id.syk}`, { fra: d(1) }, ola)).data.error).toBe("Du kan bare endre sluttdatoen");
    expect((await kall("PATCH", `/api/org/${org}/fravaer/${f.data.id}`, { til: d(5) }, kari)).status).toBe(404); // ferie endres av leder
    expect((await kall("DELETE", `/api/org/${org}/fravaer/${id.syk}`, undefined, ola)).status).toBe(204);
    expect((await tavle()).mangler_vikar).toEqual([]);
  });

  it("plassene kopieres fra en annen dag for dem som er på jobb", async () => {
    // Ola og Kari har vakt mandag neste uke (kopiert); Vera ikke (vikarvakten ble ikke kopiert).
    expect((await kall("POST", `/api/org/${org}/tavle/kopier`, { fra: d(0), til: d(7) })).data).toEqual({ kopiert: 2 });
    expect((await tavle(d(7))).plasseringer.map((p: any) => p.ansatt_id).sort()).toEqual([id.Ola, id.Kari].sort());
    expect((await kall("POST", `/api/org/${org}/tavle/kopier`, { fra: d(0), til: d(0) })).data.error).toBe("Velg en annen dag å kopiere fra");
  });

  it("slettes en oppgave, forsvinner plassene i den", async () => {
    expect((await kall("DELETE", `/api/org/${org}/tavle/oppgaver/${id.lab}`)).status).toBe(204);
    expect((await tavle()).plasseringer.map((p: any) => p.oppgave_id)).toEqual([id.telefon, id.telefon]);
  });
});
