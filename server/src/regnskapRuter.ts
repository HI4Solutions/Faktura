// Regnskapsmodulen (0086_regnskap_anlegg.sql): oppsettet (kontoene og de skattemessige
// startverdiene), anleggsregisteret med avskrivningsplanen, bokføringen av anskaffelse,
// avskrivninger (månedsavslutningen), nedskrivning og reversering, salg og utrangering, reversering
// av bilag, og saldoavskrivningene (saldo.ts). Eier, administrator og regnskap (funksjonen
// «Regnskap»). Beregningene: anlegg.ts.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { alle, en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import {
  aarsplan,
  avgangsbilag,
  anskaffelsesbilag,
  avskrivningsbilag,
  avskrivningsforslag,
  avskrivningsplan,
  bokfor,
  bokfortVerdi,
  hentAnlegg,
  hentRegnskapsoppsett,
  KATEGORIER,
  KATEGORIKODER,
  mnd,
  nedskrivningsbilag,
  plussMnd,
  REGNSKAPSKONTOER,
  REGNSKAPSROLLER,
  regnskapskontoer,
  sisteDag,
  status,
  type Anleggsmiddel,
  type Hendelse,
  type Kategori,
  type Skatt,
} from "./anlegg.js";
import { maanedNavn } from "./lonnsberegning.js";
import { GRUPPER, maksSats, SALDOGRUPPER, saldoskjema } from "./saldo.js";
import { kundefordringerVedStart } from "./salgBokforing.js";

const uuid = z.string().uuid();
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);
const krev = (db: Db, org: string) => db.query("select faktura.krev($1, 'regnskap')", [org]);
const datoS = z.string({ error: "Velg datoen" }).regex(/^\d{4}-\d{2}-\d{2}$/, "Ugyldig dato");
const mndS = z.string({ error: "Velg måneden" }).regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Ugyldig måned");
const kontoS = z.string({ error: "Skriv kontonummeret" }).trim().regex(/^\d{4,6}$/, "Kontonummeret må ha 4–6 siffer");
const krS = (hva: string) => z.number({ error: `Skriv ${hva}` }).finite().min(0, `${hva[0]!.toUpperCase()}${hva.slice(1)} kan ikke være negativ`).lt(1e12, "Beløpet er for stort");
const SKATT = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "lineaer", "ingen"] as const;
const osloIDag = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());
const kort = (n: number) => `${n.toLocaleString("nb-NO", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 }).replace(/[\u00a0\u202f]/g, " ")} kr`;

// --- Oppsettet -----------------------------------------------------------------------------------

async function oppsett(db: Db, org: string) {
  const o = await hentRegnskapsoppsett(db, org);
  const plan = regnskapskontoer(o);
  // Kundefordringene ved startdatoen for bokføringen av salget: det som hører til den inngående
  // balansen.
  const ved_start = o.salg_fra ? await kundefordringerVedStart(db, org, o.salg_fra) : null;
  return {
    kontoer: REGNSKAPSKONTOER.map((k) => ({ ...k, konto: plan[k.rolle], endret: plan[k.rolle] !== k.standard })),
    saldo_fra_aar: o.saldo_fra_aar,
    saldo_inngaende: o.saldo_inngaende,
    salg_fra: o.salg_fra,
    uten_mva: o.uten_mva,
    kundefordringer_ved_start: ved_start,
    mva_fradrag: o.mva_fradrag,
    periodiser_fra: o.periodiser_fra,
    utgifter_auto: o.utgifter_auto,
    bank_fra: o.bank_fra,
    bank_auto: o.bank_auto,
    bankkontoer: o.bankkontoer,
    kategorier: KATEGORIKODER.map((kode) => ({
      kode,
      navn: KATEGORIER[kode].navn,
      konto: KATEGORIER[kode].konto,
      avskrivningskonto: KATEGORIER[kode].avskrivning ? plan[KATEGORIER[kode].avskrivning!] : null,
      skatt: KATEGORIER[kode].skatt,
      levetid_mnd: KATEGORIER[kode].levetid,
    })),
    saldogrupper: GRUPPER.map((g) => ({ gruppe: g, ...SALDOGRUPPER[g] })),
  };
}

const oppsettSkjema = z.object({
  kontoer: z.partialRecord(z.enum(REGNSKAPSROLLER), kontoS.nullable()).optional(),
  // Fakturaene og innbetalingene bokføres fra og med datoen (null: alle), og salg uten avgift er
  // unntatt eller fritatt (salgBokforing.ts).
  salg_fra: datoS.nullable().optional(),
  uten_mva: z.enum(["unntatt", "fritatt"]).optional(),
  // Utgiftene (utgifter.ts): fradraget for inngående mva i prosent (null: fullt for den som er
  // mva-registrert), grensen for å periodisere, og om kjente leverandører bokføres av seg selv.
  mva_fradrag: z.number().finite().min(0, "Fradraget er i prosent").max(100, "Fradraget er i prosent").nullable().optional(),
  periodiser_fra: z.number().finite().min(0, "Grensen kan ikke være negativ").lt(1e9, "Grensen er for høy").optional(),
  utgifter_auto: z.boolean().optional(),
  // Banken (bankAvstemming.ts): bankpostene føres fra og med datoen (null: alle som er hentet), av seg
  // selv eller bare som forslag, og kontoen i regnskapet for en bankkonto (null: bankkontoen).
  bank_fra: datoS.nullable().optional(),
  bank_auto: z.boolean().optional(),
  bankkontoer: z.record(z.string().regex(/^[0-9A-Z]{5,34}$/, "Ugyldig kontonummer"), kontoS.nullable()).optional(),
  saldo_fra_aar: z.number().int().min(2000, "Ugyldig år").max(2100, "Ugyldig år").nullable().optional(),
  saldo_inngaende: z.partialRecord(z.enum(["a", "c", "d", "gevinst_tap"]), z.number().finite().gt(-1e12).lt(1e12).nullable()).optional(),
});

// --- Anleggsmidlene ------------------------------------------------------------------------------

const felt = {
  navn: z.string({ error: "Skriv navnet" }).trim().min(1, "Skriv navnet").max(120, "Navnet kan være høyst 120 tegn"),
  beskrivelse: z.string().trim().max(500, "Beskrivelsen kan være høyst 500 tegn").nullable().optional(),
  kategori: z.enum(KATEGORIKODER, { error: "Velg hva slags anleggsmiddel det er" }),
  anskaffet: datoS,
  avskrives_fra: mndS.nullable().optional(),
  kostpris: z.number({ error: "Skriv kostprisen" }).finite().positive("Kostprisen må være over 0").lt(1e12, "Kostprisen er for stor"),
  restverdi: krS("restverdien").optional(),
  levetid_mnd: z.number().int("Levetiden må være hele måneder").min(1, "Levetiden må være minst én måned").max(1200, "Levetiden kan være høyst 100 år").nullable().optional(),
  konto: kontoS.optional(),
  avskrivningskonto: kontoS.nullable().optional(),
  skatt: z.enum(SKATT, { error: "Velg saldogruppen" }).optional(),
  skatt_kostpris: krS("den skattemessige kostprisen").nullable().optional(),
  skatt_sats: z.number().finite().min(0, "Satsen kan ikke være negativ").max(30, "Satsen er for høy").nullable().optional(),
  tidligere_til: mndS.nullable().optional(),
  tidligere_avskrevet: krS("det som er avskrevet").optional(),
  skatt_inngaende: krS("den skattemessige saldoen").nullable().optional(),
};
const nyttSkjema = z.object({
  ...felt,
  anskaffelse: z.object({ motkonto: kontoS, mva: krS("mva-en").optional() }).nullable().optional(),
});
const endreSkjema = z.object(Object.fromEntries(Object.entries(felt).map(([k, v]) => [k, (v as z.ZodType).optional()])) as { [K in keyof typeof felt]: z.ZodOptional<(typeof felt)[K]> });

type Rad = Omit<Anleggsmiddel, "id" | "nummer" | "avgang_dato" | "avgang_type" | "avgang_vederlag">;

// Feltene med standardverdiene for kategorien, kontrollert som helhet.
function rad(b: Partial<z.infer<typeof nyttSkjema>>, naa?: Anleggsmiddel): Rad {
  const kategori = (b.kategori ?? naa?.kategori) as Kategori;
  const k = KATEGORIER[kategori];
  const anskaffet = b.anskaffet ?? naa!.anskaffet;
  const kostpris = b.kostpris ?? naa!.kostpris;
  const restverdi = b.restverdi ?? naa?.restverdi ?? 0;
  const tomt = kategori === "tomt";
  const levetid = tomt ? null : b.levetid_mnd !== undefined ? b.levetid_mnd : (naa?.levetid_mnd ?? null);
  const skatt = (kategori === "goodwill" ? "b" : tomt ? "ingen" : (b.skatt ?? (naa && naa.kategori === kategori ? naa.skatt : k.skatt))) as Skatt;
  const avskrivesFra = `${b.avskrives_fra ?? (b.anskaffet !== undefined || !naa ? mnd(anskaffet) : mnd(naa.avskrives_fra))}-01`;
  const tidligereTil = b.tidligere_til !== undefined ? b.tidligere_til : naa?.tidligere_til ? mnd(naa.tidligere_til) : null;
  const tidligere = tidligereTil ? (b.tidligere_avskrevet ?? naa?.tidligere_avskrevet ?? 0) : 0;
  const sats = b.skatt_sats !== undefined ? b.skatt_sats : (naa?.skatt_sats ?? null);
  if (!tomt && !levetid) throw new ApiFeil(400, "Skriv levetiden");
  if (restverdi >= kostpris) throw new ApiFeil(400, "Restverdien må være lavere enn kostprisen");
  if (avskrivesFra.slice(0, 7) < mnd(anskaffet)) throw new ApiFeil(400, "Avskrivningen kan ikke begynne før anleggsmiddelet er anskaffet");
  if (tidligereTil && tidligereTil < plussMnd(avskrivesFra.slice(0, 7), -1)) throw new ApiFeil(400, "Det som er avskrevet før, kan ikke være før avskrivningen begynte");
  if (tidligere > kostpris - restverdi) throw new ApiFeil(400, "Det som er avskrevet før, kan ikke være mer enn kostprisen minus restverdien");
  if (sats != null && !["b", "e", "f", "g", "h", "i", "j"].includes(skatt)) throw new ApiFeil(400, "Egen sats gjelder bare driftsmidler med egen saldo (gruppe b og e–j)");
  if (sats != null && sats > maksSats(skatt as keyof typeof SALDOGRUPPER, true))
    throw new ApiFeil(400, `Satsen for gruppe ${skatt} kan være høyst ${maksSats(skatt as keyof typeof SALDOGRUPPER, true)} %`);
  return {
    navn: b.navn ?? naa!.navn,
    beskrivelse: b.beskrivelse !== undefined ? b.beskrivelse || null : (naa?.beskrivelse ?? null),
    kategori,
    anskaffet,
    avskrives_fra: avskrivesFra,
    kostpris,
    restverdi,
    levetid_mnd: levetid,
    konto: b.konto ?? (naa && naa.kategori === kategori ? naa.konto : k.konto),
    avskrivningskonto: b.avskrivningskonto !== undefined ? b.avskrivningskonto : (naa?.avskrivningskonto ?? null),
    skatt,
    skatt_kostpris: b.skatt_kostpris !== undefined ? b.skatt_kostpris : (naa?.skatt_kostpris ?? null),
    skatt_sats: sats,
    tidligere_til: tidligereTil ? sisteDag(tidligereTil) : null,
    tidligere_avskrevet: tidligere,
    skatt_inngaende: b.skatt_inngaende !== undefined ? b.skatt_inngaende : (naa?.skatt_inngaende ?? null),
  };
}

// Et nytt anleggsmiddel, uten anskaffelsen: feltene med standardverdiene for kategorien. Utgiftene
// (utgifter.ts) bruker det og fører anskaffelsen selv.
export async function lagAnleggsmiddel(db: Db, org: string, b: Partial<z.infer<typeof nyttSkjema>>) {
  const ny = rad(b);
  if (ny.anskaffet > osloIDag()) throw new ApiFeil(400, "Anskaffelsesdatoen kan ikke være fram i tid");
  const kol = Object.keys(ny) as (keyof Rad)[];
  const r = await en<{ id: string }>(
    db,
    `insert into faktura.anleggsmidler (org_id, ${kol.join(", ")}) values ($1, ${kol.map((_, i) => `$${i + 2}`).join(", ")}) returning id`,
    [org, ...kol.map((k) => ny[k])],
  );
  return r!.id;
}

// Verdien etter måneden (etter avskrivningen for måneden og hendelsene i den), etter planen.
function verdiEtter(a: Anleggsmiddel, hendelser: Hendelse[], m: string) {
  const plan = avskrivningsplan(a, hendelser);
  const p = plan.find((x) => x.maaned === m) ?? [...plan].reverse().find((x) => x.maaned < m);
  if (p && (plan[0]!.maaned <= m)) {
    // Hendelser etter den siste måneden i planen (når levetiden er ute).
    const etter = hendelser.filter((h) => h.anleggsmiddel_id === a.id && !h.reversert && mnd(h.dato) > p.maaned && mnd(h.dato) <= m);
    return Math.round((p.verdi - etter.reduce((s, h) => s + (h.type === "nedskrivning" ? h.belop : h.type === "reversering" ? -h.belop : 0), 0)) * 100) / 100;
  }
  return bokfortVerdi(a, hendelser.filter((h) => h.type !== "avskrivning"), sisteDag(m));
}

async function detalj(db: Db, org: string, id: string) {
  const { anlegg, hendelser } = await hentAnlegg(db, org, id);
  const a = anlegg[0];
  if (!a) throw new ApiFeil(404, "Fant ikke anleggsmiddelet");
  const iDag = osloIDag();
  const nedskrevet = hendelser.filter((h) => !h.reversert).reduce((s, h) => s + (h.type === "nedskrivning" ? h.belop : h.type === "reversering" ? -h.belop : 0), 0);
  return {
    anleggsmiddel: { ...a, ...status(a, hendelser, iDag) },
    hendelser: hendelser.map((h) => ({ ...h })),
    plan: avskrivningsplan(a, hendelser),
    aar: aarsplan(a, hendelser),
    kan_reversere: a.kategori !== "goodwill" && nedskrevet > 0,
  };
}

// Reverseringen kan ikke gi en høyere verdi enn planen uten nedskrivninger.
function reverseringMaks(a: Anleggsmiddel, hendelser: Hendelse[], dato: string) {
  const uten = avskrivningsplan(a, hendelser.filter((h) => h.type !== "nedskrivning" && h.type !== "reversering" && h.type !== "avskrivning"));
  const m = mnd(dato);
  const planUten = uten.find((x) => x.maaned === m)?.verdi ?? (uten.length && m > uten.at(-1)!.maaned ? uten.at(-1)!.verdi : a.kostpris - a.tidligere_avskrevet);
  const naa = verdiEtter(a, hendelser, m);
  const nedskrevet = hendelser.filter((h) => h.anleggsmiddel_id === a.id && !h.reversert).reduce((s, h) => s + (h.type === "nedskrivning" ? h.belop : h.type === "reversering" ? -h.belop : 0), 0);
  return Math.max(0, Math.min(Math.round(nedskrevet * 100) / 100, Math.round((planUten - naa) * 100) / 100));
}

// Avskrivningene som mangler til og med måneden, bokført måned for måned (et bilag per måned). Før
// en avgang (bare): den siste måneden står på avgangsdatoen.
export async function bokforAvskrivninger(db: Db, org: string, til: string, bare?: { id: string; dato: string }) {
  const { anlegg, hendelser } = await hentAnlegg(db, org);
  const k = regnskapskontoer(await hentRegnskapsoppsett(db, org));
  const forslag = avskrivningsforslag(bare ? anlegg.filter((a) => a.id === bare.id) : anlegg, hendelser, til);
  const bilag = [];
  for (const m of forslag) {
    const b = avskrivningsbilag(m.maaned, m.linjer, k, bare && m.maaned === mnd(bare.dato) ? bare.dato : undefined);
    bilag.push({ ...(await bokfor(db, org, b)), sum: Math.round(m.linjer.reduce((s, l) => s + l.belop, 0) * 100) / 100 });
  }
  return bilag;
}

export function regnskapRuter() {
  const r = new Hono();

  r.get("/regnskap/oppsett", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        return oppsett(db, orgId(c));
      }),
    ),
  );

  r.put("/regnskap/oppsett", async (c) => {
    const b = oppsettSkjema.parse(await c.req.json().catch(() => ({})));
    return c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        const naa = await hentRegnskapsoppsett(db, orgId(c));
        // Bare kontoene som avviker fra standarden lagres.
        const kontoer: Record<string, string> = { ...naa.kontoer } as Record<string, string>;
        for (const [rolle, nr] of Object.entries(b.kontoer ?? {})) {
          if (!nr || nr === REGNSKAPSKONTOER.find((k) => k.rolle === rolle)?.standard) delete kontoer[rolle];
          else kontoer[rolle] = nr;
        }
        const inngaende: Record<string, number> = { ...naa.saldo_inngaende } as Record<string, number>;
        for (const [g, v] of Object.entries(b.saldo_inngaende ?? {})) {
          if (v == null) delete inngaende[g];
          else inngaende[g] = Math.round(v * 100) / 100;
        }
        const bankkontoer: Record<string, string> = { ...naa.bankkontoer };
        for (const [nr, konto] of Object.entries(b.bankkontoer ?? {})) {
          if (konto) bankkontoer[nr] = konto;
          else delete bankkontoer[nr];
        }
        const bankFra = b.bank_fra !== undefined ? b.bank_fra : naa.bank_fra;
        await db.query(
          `insert into faktura.regnskap_oppsett (org_id, kontoer, saldo_fra_aar, saldo_inngaende, salg_fra, uten_mva, mva_fradrag, periodiser_fra,
                                                 utgifter_auto, bank_fra, bank_auto, bankkontoer, oppdatert)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
           on conflict (org_id) do update set kontoer = excluded.kontoer, saldo_fra_aar = excluded.saldo_fra_aar,
                                              saldo_inngaende = excluded.saldo_inngaende, salg_fra = excluded.salg_fra,
                                              uten_mva = excluded.uten_mva, mva_fradrag = excluded.mva_fradrag,
                                              periodiser_fra = excluded.periodiser_fra, utgifter_auto = excluded.utgifter_auto,
                                              bank_fra = excluded.bank_fra, bank_auto = excluded.bank_auto, bankkontoer = excluded.bankkontoer,
                                              oppdatert = now()`,
          [
            orgId(c),
            JSON.stringify(kontoer),
            b.saldo_fra_aar !== undefined ? b.saldo_fra_aar : naa.saldo_fra_aar,
            JSON.stringify(inngaende),
            b.salg_fra !== undefined ? b.salg_fra : naa.salg_fra,
            b.uten_mva ?? naa.uten_mva,
            b.mva_fradrag !== undefined ? b.mva_fradrag : naa.mva_fradrag,
            b.periodiser_fra ?? naa.periodiser_fra,
            b.utgifter_auto ?? naa.utgifter_auto,
            bankFra,
            b.bank_auto ?? naa.bank_auto,
            JSON.stringify(bankkontoer),
          ],
        );
        // Flyttes startdatoen for banken fram, angres føringen av bankpostene før den (bilagene i
        // serie B reverseres); flyttes den bakover, fører workeren dem som er hentet.
        if (bankFra && (!naa.bank_fra || bankFra > naa.bank_fra))
          for (const x of await alle<{ id: string }>(db, "select id from faktura.bankposter where org_id = $1 and status = 'avstemt' and dato < $2 order by dato", [orgId(c), bankFra]))
            if ((await en<{ status: string }>(db, "select status from faktura.bankposter where id = $1", [x.id]))?.status === "avstemt")
              await db.query("select faktura.apne_bankpost($1, $2, true)", [orgId(c), x.id]);
        return oppsett(db, orgId(c));
      }),
    );
  });

  r.get("/regnskap/anleggsmidler", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        const { anlegg, hendelser } = await hentAnlegg(db, orgId(c));
        const iDag = osloIDag();
        const forslag = avskrivningsforslag(anlegg, hendelser, mnd(iDag));
        return {
          anleggsmidler: anlegg.map((a) => ({ ...a, ...status(a, hendelser, iDag) })),
          // Det som ikke er bokført til og med denne måneden (månedsavslutningen).
          ikke_bokfort: {
            til: mnd(iDag),
            fra: forslag[0]?.maaned ?? null,
            maaneder: forslag.length,
            sum: Math.round(forslag.reduce((s, m) => s + m.linjer.reduce((t, l) => t + l.belop, 0), 0) * 100) / 100,
          },
        };
      }),
    ),
  );

  r.post("/regnskap/anleggsmidler", async (c) => {
    const b = nyttSkjema.parse(await c.req.json().catch(() => ({})));
    const ny = rad(b);
    if (b.anskaffelse && ny.tidligere_til) throw new ApiFeil(400, "Anskaffelsen av et anleggsmiddel som er ført i et annet system, bokføres ikke her");
    if (ny.anskaffet > osloIDag()) throw new ApiFeil(400, "Anskaffelsesdatoen kan ikke være fram i tid");
    return c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        const id = await lagAnleggsmiddel(db, orgId(c), b);
        if (b.anskaffelse) {
          const { anlegg } = await hentAnlegg(db, orgId(c), id);
          const k = regnskapskontoer(await hentRegnskapsoppsett(db, orgId(c)));
          await bokfor(db, orgId(c), anskaffelsesbilag(anlegg[0]!, b.anskaffelse.motkonto, b.anskaffelse.mva ?? 0, k));
        }
        return detalj(db, orgId(c), id);
      }),
      201,
    );
  });

  r.get("/regnskap/anleggsmidler/:id", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        return detalj(db, orgId(c), uuid.parse(c.req.param("id")));
      }),
    ),
  );

  r.patch("/regnskap/anleggsmidler/:id", async (c) => {
    const id = uuid.parse(c.req.param("id"));
    const b = endreSkjema.parse(await c.req.json().catch(() => ({})));
    return c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        const { anlegg } = await hentAnlegg(db, orgId(c), id);
        if (!anlegg[0]) throw new ApiFeil(404, "Fant ikke anleggsmiddelet");
        const ny = rad(b, anlegg[0]);
        const kol = Object.keys(ny) as (keyof Rad)[];
        await db.query(`update faktura.anleggsmidler set ${kol.map((k, i) => `${k} = $${i + 3}`).join(", ")} where org_id = $1 and id = $2`, [
          orgId(c),
          id,
          ...kol.map((k) => ny[k]),
        ]);
        return detalj(db, orgId(c), id);
      }),
    );
  });

  r.delete("/regnskap/anleggsmidler/:id", async (c) => {
    const id = uuid.parse(c.req.param("id"));
    await bruk(c, async (db) => {
      await krev(db, orgId(c));
      const n = await db.query("delete from faktura.anleggsmidler where org_id = $1 and id = $2", [orgId(c), id]);
      if (!n.rowCount) throw new ApiFeil(404, "Fant ikke anleggsmiddelet");
    });
    return c.body(null, 204);
  });

  // Anskaffelsen bokført etterpå (kostprisen på balansekontoen mot motkontoen, med inngående mva).
  r.post("/regnskap/anleggsmidler/:id/anskaffelse", async (c) => {
    const id = uuid.parse(c.req.param("id"));
    const b = z.object({ motkonto: kontoS, mva: krS("mva-en").optional() }).parse(await c.req.json().catch(() => ({})));
    return c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        const { anlegg, hendelser } = await hentAnlegg(db, orgId(c), id);
        const a = anlegg[0];
        if (!a) throw new ApiFeil(404, "Fant ikke anleggsmiddelet");
        if (hendelser.some((h) => h.type === "anskaffelse" && !h.reversert)) throw new ApiFeil(409, "Anskaffelsen er alt bokført");
        const k = regnskapskontoer(await hentRegnskapsoppsett(db, orgId(c)));
        const bilag = await bokfor(db, orgId(c), anskaffelsesbilag(a, b.motkonto, b.mva ?? 0, k));
        return { ...(await detalj(db, orgId(c), id)), bilag };
      }),
      201,
    );
  });

  r.post("/regnskap/anleggsmidler/:id/nedskrivning", async (c) => {
    const id = uuid.parse(c.req.param("id"));
    const b = z
      .object({
        dato: datoS,
        belop: z.number({ error: "Skriv beløpet" }).finite().positive("Beløpet må være over 0").lt(1e12, "Beløpet er for stort"),
        tekst: z.string().trim().max(300, "Teksten kan være høyst 300 tegn").nullable().optional(),
        reverser: z.boolean().optional(),
      })
      .parse(await c.req.json().catch(() => ({})));
    if (b.dato > osloIDag()) throw new ApiFeil(400, "Datoen kan ikke være fram i tid");
    return c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        const { anlegg, hendelser } = await hentAnlegg(db, orgId(c), id);
        const a = anlegg[0];
        if (!a) throw new ApiFeil(404, "Fant ikke anleggsmiddelet");
        if (a.avgang_dato) throw new ApiFeil(409, "Anleggsmiddelet er solgt eller utrangert");
        if (b.dato < a.anskaffet) throw new ApiFeil(400, "Datoen er før anleggsmiddelet ble anskaffet");
        if (b.reverser) {
          if (a.kategori === "goodwill") throw new ApiFeil(409, "Nedskrivning av goodwill kan ikke reverseres");
          const maks = reverseringMaks(a, hendelser, b.dato);
          if (b.belop > maks + 0.004)
            throw new ApiFeil(400, maks ? `Reverseringen kan være høyst ${kort(maks)} (nedskrivningene, og ikke mer enn verdien etter planen uten nedskrivning)` : "Det er ingen nedskrivning å reversere");
        } else {
          const maks = verdiEtter(a, hendelser, mnd(b.dato));
          if (b.belop > maks + 0.004) throw new ApiFeil(400, `Nedskrivningen kan være høyst den bokførte verdien (${kort(Math.max(0, maks))})`);
        }
        const k = regnskapskontoer(await hentRegnskapsoppsett(db, orgId(c)));
        const bilag = await bokfor(db, orgId(c), nedskrivningsbilag(a, b.dato, b.belop, !!b.reverser, b.tekst ?? null, k));
        return { ...(await detalj(db, orgId(c), id)), bilag };
      }),
      201,
    );
  });

  // Salg eller utrangering: avskrivningene til og med måneden bokføres først, så avgangen.
  r.post("/regnskap/anleggsmidler/:id/avgang", async (c) => {
    const id = uuid.parse(c.req.param("id"));
    const b = z
      .object({
        dato: datoS,
        type: z.enum(["salg", "utrangering"], { error: "Velg salg eller utrangering" }),
        vederlag: krS("salgssummen").optional(),
        mva: krS("mva-en").optional(),
        motkonto: kontoS.optional(),
        tekst: z.string().trim().max(300, "Teksten kan være høyst 300 tegn").nullable().optional(),
      })
      .parse(await c.req.json().catch(() => ({})));
    if (b.dato > osloIDag()) throw new ApiFeil(400, "Datoen kan ikke være fram i tid");
    if (b.type === "salg" && !b.vederlag) throw new ApiFeil(400, "Skriv salgssummen (uten mva)");
    return c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        let { anlegg, hendelser } = await hentAnlegg(db, orgId(c), id);
        const a = anlegg[0];
        if (!a) throw new ApiFeil(404, "Fant ikke anleggsmiddelet");
        if (a.avgang_dato) throw new ApiFeil(409, "Anleggsmiddelet er alt solgt eller utrangert");
        if (b.dato < a.anskaffet) throw new ApiFeil(400, "Datoen er før anleggsmiddelet ble anskaffet");
        if (hendelser.some((h) => !h.reversert && h.dato > b.dato && h.type !== "avskrivning"))
          throw new ApiFeil(409, "Det er bokført noe for anleggsmiddelet etter datoen. Reverser det først.");
        if (hendelser.some((h) => !h.reversert && h.type === "avskrivning" && h.maaned! > mnd(b.dato)))
          throw new ApiFeil(409, `Avskrivningene er bokført etter ${maanedNavn(`${mnd(b.dato)}-01`)}. Reverser dem først.`);
        const k = regnskapskontoer(await hentRegnskapsoppsett(db, orgId(c)));
        const bilag = await bokforAvskrivninger(db, orgId(c), mnd(b.dato), { id: a.id, dato: b.dato });
        ({ anlegg, hendelser } = await hentAnlegg(db, orgId(c), id));
        const salg = b.type === "salg";
        bilag.push({
          ...(await bokfor(
            db,
            orgId(c),
            avgangsbilag(
              anlegg[0]!,
              {
                dato: b.dato,
                type: b.type,
                vederlag: salg ? (b.vederlag ?? 0) : 0,
                mva: salg ? (b.mva ?? 0) : 0,
                motkonto: b.motkonto ?? k.bank,
                verdi: bokfortVerdi(anlegg[0]!, hendelser, "9999-12-31"),
                tekst: b.tekst ?? null,
              },
              k,
            ),
          )),
          sum: salg ? (b.vederlag ?? 0) : 0,
        });
        return { ...(await detalj(db, orgId(c), id)), bilag };
      }),
      201,
    );
  });

  // Månedsavslutningen: avskrivningene som ikke er bokført til og med måneden.
  r.get("/regnskap/avskrivninger", async (c) => {
    const til = mndS.parse(c.req.query("til") ?? mnd(osloIDag()));
    return c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        const { anlegg, hendelser } = await hentAnlegg(db, orgId(c));
        const forslag = avskrivningsforslag(anlegg, hendelser, til);
        return {
          til,
          maaneder: forslag.map((m) => ({
            maaned: m.maaned,
            navn: maanedNavn(`${m.maaned}-01`),
            sum: Math.round(m.linjer.reduce((s, l) => s + l.belop, 0) * 100) / 100,
            linjer: m.linjer.map((l) => ({ anleggsmiddel_id: l.a.id, nummer: l.a.nummer, navn: l.a.navn, belop: l.belop })),
          })),
        };
      }),
    );
  });

  r.post("/regnskap/avskrivninger", async (c) => {
    const b = z.object({ til: mndS }).parse(await c.req.json().catch(() => ({})));
    if (b.til > mnd(osloIDag())) throw new ApiFeil(400, "Avskrivningene kan ikke bokføres for en måned fram i tid");
    return c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        return { bilag: await bokforAvskrivninger(db, orgId(c), b.til) };
      }),
      201,
    );
  });

  // Saldoavskrivningene for året, med den regnskapsmessige verdien ved utgangen av året.
  r.get("/regnskap/saldo", async (c) => {
    const aar = z.coerce.number().int().min(2000).max(2100).parse(c.req.query("aar") ?? osloIDag().slice(0, 4));
    return c.json(await bruk(c, (db) => hentSaldo(db, orgId(c), aar)));
  });

  r.put("/regnskap/saldo/:aar", async (c) => {
    const aar = z.coerce.number().int().min(2000).max(2100).parse(c.req.param("aar"));
    const b = z
      .object({ satser: z.partialRecord(z.enum(GRUPPER as [string, ...string[]]), z.number().finite().min(0, "Satsen kan ikke være negativ").nullable()) })
      .parse(await c.req.json().catch(() => ({})));
    for (const [g, s] of Object.entries(b.satser))
      if (s != null && s > maksSats(g as keyof typeof SALDOGRUPPER)) throw new ApiFeil(400, `Satsen for gruppe ${g} kan være høyst ${maksSats(g as keyof typeof SALDOGRUPPER)} %`);
    return c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        for (const [g, s] of Object.entries(b.satser)) {
          if (s == null || s === maksSats(g as keyof typeof SALDOGRUPPER))
            await db.query("delete from faktura.saldo_satser where org_id = $1 and aar = $2 and gruppe = $3", [orgId(c), aar, g]);
          else
            await db.query(
              "insert into faktura.saldo_satser (org_id, aar, gruppe, sats) values ($1, $2, $3, $4) on conflict (org_id, aar, gruppe) do update set sats = excluded.sats",
              [orgId(c), aar, g, s],
            );
        }
        return hentSaldo(db, orgId(c), aar);
      }),
    );
  });

  return r;
}

export async function hentSaldo(db: Db, org: string, aar: number) {
  await krev(db, org);
  const o = await hentRegnskapsoppsett(db, org);
  const { anlegg, hendelser } = await hentAnlegg(db, org);
  const satser = Object.fromEntries(
    (
      await db.query<{ aar: number; gruppe: string; sats: number }>("select aar, gruppe, sats::float8 as sats from faktura.saldo_satser where org_id = $1", [org])
    ).rows.map((s) => [`${s.aar}:${s.gruppe}`, s.sats]),
  );
  const s = saldoskjema(aar, anlegg, o, satser);
  // Den regnskapsmessige verdien ved utgangen av året (midlertidige forskjeller).
  const slutt = `${aar}-12-31`;
  const verdi = (a: Anleggsmiddel) => bokfortVerdi(a, hendelser, slutt);
  const rader = s.rader.map((r) => {
    const regnskap =
      r.type === "samlet"
        ? anlegg.filter((a) => a.skatt === r.gruppe).reduce((t, a) => t + verdi(a), 0)
        : r.anleggsmiddel_id
          ? verdi(anlegg.find((a) => a.id === r.anleggsmiddel_id)!)
          : null;
    return { ...r, regnskap: regnskap == null ? null : Math.round(regnskap * 100) / 100, forskjell: regnskap == null ? null : Math.round((regnskap - r.utgaende) * 100) / 100 };
  });
  return {
    ...s,
    rader,
    satser: GRUPPER.map((g) => ({ gruppe: g, navn: SALDOGRUPPER[g].navn, maks: SALDOGRUPPER[g].sats, sats: satser[`${aar}:${g}`] ?? SALDOGRUPPER[g].sats })),
    oppsett: { saldo_fra_aar: o.saldo_fra_aar, saldo_inngaende: o.saldo_inngaende },
  };
}
