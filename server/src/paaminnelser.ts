// Påminnelser om fakturaer som må lages for hånd (0032_paaminnelser.sql), for eksempel når
// beløpet varierer fra måned til måned og en gjentakende faktura ikke passer. Rutene brukes
// av appen; workeren sender påminnelsene hvert minutt som push-varsel (og e-post om man har
// valgt det). Varselet åpner en side i appen der kunden og produktene er fylt inn
// (/paaminnelser/<id>): man skriver inn beløpet og sender fakturaen derfra.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { config } from "./config.js";
import { alle, en, somBruker, somSystem, type Db } from "./db.js";
import { harFunksjon } from "./funksjoner.js";
import { ApiFeil } from "./feil.js";
import { sendVarsel } from "./push.js";
import { dato, iDag } from "./regler.js";
import { leggIKo } from "./tjenester.js";

export const INTERVALLER = ["maaned", "kvartal", "aar", "uke", "en_gang"] as const;

const logg = (severity: string, message: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ severity, message, ...data }));
const uuid = z.string().uuid();
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const id = (c: Context) => uuid.parse(c.req.param("id"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);

const skjema = z.object({
  tekst: z.string({ error: "Skriv hva påminnelsen gjelder" }).trim().min(1, "Skriv hva påminnelsen gjelder").max(200, "Teksten kan være høyst 200 tegn"),
  kunde_id: uuid.nullish(),
  produkter: z.array(uuid).max(10, "Velg høyst 10 produkter").optional(),
  intervall: z.enum(INTERVALLER, { error: "Velg hvor ofte" }),
  neste_dato: z.string({ error: "Velg en dato" }).regex(/^\d{4}-\d{2}-\d{2}$/, "Velg en dato"),
  klokkeslett: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Ugyldig klokkeslett").optional(),
  hvem: z.enum(["meg", "alle"]).optional(),
  epost: z.boolean().optional(),
  aktiv: z.boolean().optional(),
});

const UTVALG = `
  select p.id, p.tekst, p.kunde_id, k.navn as kunde_navn, p.produkter,
         coalesce((select jsonb_agg(jsonb_build_object('id', pr.id, 'navn', pr.navn, 'fast_pris', pr.enhetspris is not null, 'aktiv', pr.aktiv)
                                    order by array_position(p.produkter, pr.id))
                     from faktura.produkter pr where pr.id = any(p.produkter)), '[]'::jsonb) as produktliste,
         p.intervall, p.dag, p.neste_dato, to_char(p.klokkeslett, 'HH24:MI') as klokkeslett, p.hvem, p.epost, p.aktiv, p.sist_varslet,
         coalesce(b.navn, b.epost) as opprettet_av_navn, p.opprettet_av = faktura.bruker_id() as min
    from faktura.paaminnelser p
    left join faktura.kunder k on k.id = p.kunde_id
    left join faktura.brukere b on b.id = p.opprettet_av`;

const forTidlig = () => new ApiFeil(400, "Velg en dato fra og med i dag");

export function paaminnelseRuter() {
  const r = new Hono();

  r.get("/paaminnelser", async (c) =>
    c.json(await bruk(c, (db) => alle(db, `${UTVALG} where p.org_id = $1 order by p.aktiv desc, p.neste_dato, p.klokkeslett, p.tekst`, [orgId(c)]))),
  );

  r.get("/paaminnelser/:id", async (c) => {
    const p = await bruk(c, (db) => en(db, `${UTVALG} where p.org_id = $1 and p.id = $2`, [orgId(c), id(c)]));
    if (!p) throw new ApiFeil(404, "Fant ikke påminnelsen");
    return c.json(p);
  });

  r.post("/paaminnelser", async (c) => {
    const b = skjema.parse(await c.req.json().catch(() => ({})));
    if (b.neste_dato < iDag()) throw forTidlig();
    const ny = await bruk(c, async (db) => {
      const rad = await en<{ id: string }>(
        db,
        `insert into faktura.paaminnelser (org_id, tekst, kunde_id, produkter, intervall, dag, neste_dato, klokkeslett, hvem, epost, aktiv)
         values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::time, '08:00'), coalesce($9, 'meg'), coalesce($10, false), coalesce($11, true)) returning id`,
        [orgId(c), b.tekst, b.kunde_id ?? null, b.produkter ?? [], b.intervall, Number(b.neste_dato.slice(8, 10)), b.neste_dato, b.klokkeslett ?? null,
         b.hvem ?? null, b.epost ?? null, b.aktiv ?? null],
      );
      return en(db, `${UTVALG} where p.id = $1`, [rad!.id]);
    });
    return c.json(ny, 201);
  });

  r.patch("/paaminnelser/:id", async (c) => {
    const b = skjema.partial().parse(await c.req.json().catch(() => ({})));
    if (b.neste_dato && b.neste_dato < iDag()) throw forTidlig();
    const felt: Record<string, unknown> = {
      tekst: b.tekst,
      kunde_id: b.kunde_id,
      produkter: b.produkter,
      intervall: b.intervall,
      neste_dato: b.neste_dato,
      dag: b.neste_dato ? Number(b.neste_dato.slice(8, 10)) : undefined,
      klokkeslett: b.klokkeslett,
      hvem: b.hvem,
      epost: b.epost,
      aktiv: b.aktiv,
    };
    const navn = Object.keys(felt).filter((k) => felt[k] !== undefined);
    if (!navn.length) throw new ApiFeil(400, "Ingen felt å endre");
    const p = await bruk(c, async (db) => {
      const rad = await en<{ id: string; aktiv: boolean; neste_dato: string; sendt: boolean }>(
        db,
        `update faktura.paaminnelser set ${navn.map((k, i) => `${k} = $${i + 3}`).join(", ")} where id = $1 and org_id = $2
         returning id, aktiv, neste_dato, coalesce((neste_dato + klokkeslett) at time zone 'Europe/Oslo' <= sist_varslet, false) as sendt`,
        [id(c), orgId(c), ...navn.map((k) => felt[k] ?? null)],
      );
      if (!rad) throw new ApiFeil(404, "Fant ikke påminnelsen");
      // En påminnelse som allerede er sendt for datoen (den siste av en engangspåminnelse),
      // eller med en dato som er passert, trenger en ny dato for å starte igjen.
      if (rad.aktiv && (rad.sendt || rad.neste_dato < iDag())) throw new ApiFeil(400, "Velg en ny dato for påminnelsen");
      return en(db, `${UTVALG} where p.id = $1`, [rad.id]);
    });
    return c.json(p);
  });

  r.delete("/paaminnelser/:id", async (c) => {
    const rad = await bruk(c, (db) => en(db, "delete from faktura.paaminnelser where id = $1 and org_id = $2 returning id", [id(c), orgId(c)]));
    if (!rad) throw new ApiFeil(404, "Fant ikke påminnelsen");
    return c.body(null, 204);
  });

  return r;
}

// --- Utsending (workeren, hvert minutt) ------------------------------------------

type Tatt = {
  id: string;
  org_id: string;
  tekst: string;
  kunde_id: string | null;
  produkter: string[];
  klokkeslett: string;
  hvem: "meg" | "alle";
  epost: boolean;
  opprettet_av: string | null;
};

// Påminnelsene som skal sendes nå. Databasen flytter hver til neste dato før den kommer hit,
// så en feil i sendingen gir ikke samme påminnelse flere ganger.
export async function sendPaaminnelser(): Promise<number> {
  const tatt = await somSystem((db) => alle<Tatt>(db, "select * from faktura.ta_paaminnelser()"));
  for (const p of tatt) {
    try {
      // Uten funksjonen (funksjonene i Administrasjon) sendes ingen påminnelse.
      if (!(await harFunksjon(p.org_id, "paaminnelser"))) continue;
      await varsle(p);
    } catch (e) {
      logg("ERROR", "Påminnelse kunne ikke sendes", { paaminnelse: p.id, org_id: p.org_id, feil: (e as Error).message });
    }
  }
  return tatt.length;
}

async function varsle(p: Tatt) {
  const { info, mottakere } = await somSystem(async (db) => ({
    info: (await en<{ org: string; kunde: string | null; produkter: string | null; neste: string; aktiv: boolean }>(
      db,
      `select o.navn as org, k.navn as kunde,
              (select string_agg(pr.navn, ', ' order by array_position($3::uuid[], pr.id)) from faktura.produkter pr where pr.id = any($3::uuid[])) as produkter,
              p.neste_dato as neste, p.aktiv
         from faktura.paaminnelser p
         join faktura.organisasjoner o on o.id = p.org_id
         left join faktura.kunder k on k.id = $2
        where p.id = $1`,
      [p.id, p.kunde_id, p.produkter],
    ))!,
    // Bare den som lagde påminnelsen (om den fortsatt er med), eller alle som kan fakturere.
    mottakere: await alle<{ bruker_id: string; epost: string }>(
      db,
      `select m.bruker_id, b.epost from faktura.medlemmer m join faktura.brukere b on b.id = m.bruker_id
        where m.org_id = $1 and case when $2 = 'meg' then m.bruker_id = $3 else m.rolle in ('eier', 'admin', 'fakturerer') end`,
      [p.org_id, p.hvem, p.opprettet_av],
    ),
  }));
  if (!mottakere.length) {
    logg("WARNING", "Påminnelse uten mottakere", { paaminnelse: p.id, org_id: p.org_id });
    return;
  }
  const hva = `${info.kunde ? ` til ${info.kunde}` : ""}${info.produkter ? ` for ${info.produkter}` : ""}`;
  const sti = `/paaminnelser/${p.id}`;
  const push = await sendVarsel({
    hendelse: "paaminnelse",
    org_id: p.org_id,
    bruker_ider: mottakere.map((m) => m.bruker_id),
    tittel: p.tekst,
    tekst: `Trykk for å skrive inn beløpet og sende fakturaen${hva}.`,
    url: sti,
    tag: `paaminnelse-${p.id}`,
  });
  if (p.epost) {
    const neste = info.aktiv ? `Neste påminnelse kommer ${dato(info.neste)} kl. ${p.klokkeslett.slice(0, 5)}.` : "Dette var den siste påminnelsen.";
    for (const m of mottakere)
      await leggIKo({
        type: "epost",
        til: [m.epost],
        emne: `Påminnelse: ${p.tekst}`,
        tekst: [
          "Hei,",
          "",
          `Dette er en påminnelse du har satt opp i HI4 Faktura for ${info.org}:`,
          "",
          p.tekst,
          "",
          `Skriv inn beløpet og send fakturaen${hva}: ${config.appUrl}${sti}?org=${p.org_id}`,
          "",
          neste,
          "Du kan endre eller stoppe påminnelsene under Gjentakende → Påminnelser i appen.",
        ].join("\n"),
      });
  }
  logg("INFO", "Påminnelse sendt", { paaminnelse: p.id, org_id: p.org_id, mottakere: mottakere.length, push: push.sendt, epost: p.epost });
}
