// Regnskap → Bank (0091_bankposter.sql, bankAvstemming.ts): bankpostene per konto med saldoen i
// banken og i regnskapet (avstemmingen), det som må avklares, og det som er ført i måneden; og
// handlingene på en post: godta forslaget, før den på en konto (og lær motparten), koble den til en
// ubetalt utgift eller et bilag, angre, eller si at en innbetaling ikke er en fakturabetaling.
// Workeren fører resten av seg selv; det brukeren gjør her, går gjennom de samme funksjonene.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { hentRegnskapsoppsett, regnskapskontoer } from "./anlegg.js";
import { bankKonto, kontoavstemming, POSTKOLONNER, utfor, type Post } from "./bankAvstemming.js";
import { alle, en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";

const uuid = z.string().uuid();
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const postId = (c: Context) => uuid.parse(c.req.param("id"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);
const krev = (db: Db, org: string) => db.query("select faktura.krev($1, 'regnskap')", [org]);
const osloIDag = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());
const navnNokkel = (x: string | null) => (x ?? "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200) || null;
const banktekst = (p: Pick<Post, "motpart" | "melding">) => (p.motpart ?? p.melding ?? "Bank").slice(0, 200);
const standardtekst = (p: Pick<Post, "motpart" | "melding">) => [p.motpart, p.melding].filter(Boolean).join(": ").slice(0, 300) || "Bankpost";

const LISTEKOLONNER = `${POSTKOLONNER}, b.serie || '-' || b.aar || '-' || b.nummer as bilagsnummer, p.avstemt, p.avstemt_av is null as av_seg_selv`;

async function hentPost(db: Db, org: string, id: string) {
  const p = await en<Post & { bilagsnummer: string | null; avstemt: string | null; av_seg_selv: boolean }>(
    db,
    `select ${LISTEKOLONNER} from faktura.bankposter p left join faktura.bilag b on b.id = p.bilag_id where p.org_id = $1 and p.id = $2`,
    [org, id],
  );
  if (!p) throw new ApiFeil(404, "Fant ikke bankposten");
  return p;
}

// Innbetalingen (fra Fakturaer → Innbetalinger) for en post inn.
const banktransaksjon = (db: Db, org: string, p: Pick<Post, "konto" | "ekstern_id" | "belop">) =>
  p.belop > 0
    ? en<{ id: string; status: string }>(db, "select id, status from faktura.banktransaksjoner where org_id = $1 and konto = $2 and ekstern_id = $3", [org, p.konto, p.ekstern_id])
    : Promise.resolve(undefined);

const linjeS = z.object({ konto: z.string().regex(/^\d{4,6}$/, "Kontonummeret har 4–6 siffer") });

export function bankRegnskapRuter() {
  const r = new Hono();

  // Reglene som er lært (motparten → kontoen).
  r.get("/regnskap/bank/regler", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        return alle(
          db,
          "select id, retning, motpart_konto, motpart, konto, tekst, opprettet from faktura.bankregler where org_id = $1 order by retning, coalesce(motpart, motpart_konto)",
          [orgId(c)],
        );
      }),
    ),
  );
  r.delete("/regnskap/bank/regler/:id", async (c) => {
    await bruk(c, async (db) => {
      await krev(db, orgId(c));
      const x = await db.query("delete from faktura.bankregler where org_id = $1 and id = $2", [orgId(c), postId(c)]);
      if (!x.rowCount) throw new ApiFeil(404, "Fant ikke regelen");
    });
    return c.body(null, 204);
  });

  // Oversikten: kontoene med avstemmingen, postene som må avklares (alle) og dem i måneden.
  r.get("/regnskap/bank", async (c) => {
    const maaned = z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Ugyldig måned")
      .parse(c.req.query("maaned") ?? osloIDag().slice(0, 7));
    const fra = `${maaned}-01`;
    const til = new Date(Date.UTC(Number(maaned.slice(0, 4)), Number(maaned.slice(5, 7)), 0)).toISOString().slice(0, 10);
    return c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        const o = await hentRegnskapsoppsett(db, orgId(c));
        const k = (await kontoavstemming(db, orgId(c))).map(({ apne, uten_post, ...x }) => ({
          ...x,
          apne: { antall: apne.antall, sum: apne.sum },
          uten_post: { antall: uten_post.antall, sum: uten_post.sum },
        }));
        const poster = await alle<Post & { bilagsnummer: string | null; for_start: boolean }>(
          db,
          `select ${LISTEKOLONNER}, ($2::date is not null and p.dato < $2) as for_start
             from faktura.bankposter p left join faktura.bilag b on b.id = p.bilag_id
            where p.org_id = $1
              and ((p.status <> 'avstemt' and ($2::date is null or p.dato >= $2)) or p.dato between $3 and $4)
            order by p.dato desc, p.opprettet desc
            limit 1000`,
          [orgId(c), o.bank_fra, fra, til],
        );
        return {
          maaned,
          bank_fra: o.bank_fra,
          auto: o.bank_auto,
          kontoer: k,
          poster,
          apne: poster.filter((p) => p.status !== "avstemt" && !p.for_start).length,
        };
      }),
    );
  });

  // En post, med det den kan kobles til: de ubetalte utgiftene og bilagene på bankkontoen (det
  // samme beløpet først).
  r.get("/regnskap/bank/:id", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        const p = await hentPost(db, orgId(c), postId(c));
        const o = await hentRegnskapsoppsett(db, orgId(c));
        const K = bankKonto(o, regnskapskontoer(o), p.konto);
        const utgifter =
          p.belop < 0
            ? await alle(
                db,
                `select u.id, u.leverandor, u.fakturanummer, to_char(u.dato, 'YYYY-MM-DD') as dato, to_char(u.forfallsdato, 'YYYY-MM-DD') as forfallsdato,
                        u.belop::float8 as belop, u.kid
                   from faktura.utgifter u
                  where u.org_id = $1 and u.status = 'bokfort' and u.betaling = 'ubetalt' and u.betaling_bilag_id is null and u.dato <= $2
                  order by abs(u.belop - $3::numeric), u.forfallsdato nulls last limit 30`,
                [orgId(c), p.dato, -p.belop],
              )
            : [];
        const bilag = await alle(
          db,
          `with k as (
             select b.id, b.serie || '-' || b.aar || '-' || b.nummer as nummer, b.dato, b.tekst, b.kilde, sum(x.belop) as paa
               from faktura.bilag b join faktura.posteringer x on x.bilag_id = b.id and x.konto = $2
              where b.org_id = $1 and b.reverserer is null and b.reversert_av is null and b.dato between $3::date - 45 and $3::date + 45
              group by b.id)
           select id, nummer, to_char(dato, 'YYYY-MM-DD') as dato, tekst, kilde, rest from (
             select k.*, (k.paa - coalesce((select sum(y.belop) from faktura.bankposter y where y.bilag_id = k.id and faktura.bankpost_konto(y.org_id, y.konto) = $2), 0))::float8 as rest
               from k) z
            -- Samme beløp, eller et lønnsbilag som flere poster deler (nettolønnen til hver ansatt).
            where abs(rest - $4::numeric) < 0.005 or (kilde = 'lonn' and sign(rest) = sign($4::numeric) and abs(rest) > abs($4::numeric))
            order by abs(rest - $4::numeric), abs(dato - $3::date) limit 30`,
          [orgId(c), K, p.dato, p.belop],
        );
        const t = await banktransaksjon(db, orgId(c), p);
        return { ...p, regnskapskonto: K, kandidater: { utgifter, bilag }, innbetaling: t ?? null };
      }),
    ),
  );

  const handling = (sti: string, fn: (db: Db, org: string, p: Awaited<ReturnType<typeof hentPost>>, c: Context) => Promise<void>) =>
    r.post(`/regnskap/bank/:id/${sti}`, async (c) =>
      c.json(
        await bruk(c, async (db) => {
          await krev(db, orgId(c));
          const p = await hentPost(db, orgId(c), postId(c));
          await fn(db, orgId(c), p, c);
          return hentPost(db, orgId(c), p.id);
        }),
      ),
    );

  // Godta forslaget.
  handling("godta", async (db, org, p) => {
    if (p.status !== "forslag" || !p.forslag) throw new ApiFeil(409, "Bankposten har ikke noe forslag");
    await utfor(db, org, p, p.forslag, p.regel ?? "Forslaget er godtatt", false);
  });

  // Før posten på en konto (bankkontoen mot kontoen), og lær motparten når det er valgt.
  handling("konto", async (db, org, p, c) => {
    const b = linjeS
      .extend({ tekst: z.string().trim().max(200, "Teksten kan være høyst 200 tegn").nullable().optional(), husk: z.boolean().optional() })
      .parse(await c.req.json().catch(() => ({})));
    if (p.status === "avstemt") throw new ApiFeil(409, "Bankposten er alt ført");
    const o = await hentRegnskapsoppsett(db, org);
    const K = bankKonto(o, regnskapskontoer(o), p.konto);
    if (b.konto === K) throw new ApiFeil(400, `Velg en annen konto enn bankkontoen (${K})`);
    const tekst = b.tekst || standardtekst(p);
    // En innbetaling som venter under Fakturaer → Innbetalinger, er ikke en fakturabetaling.
    const t = await banktransaksjon(db, org, p);
    await utfor(
      db,
      org,
      p,
      {
        type: "bokfor",
        tekst,
        posteringer: [
          { konto: K, belop: p.belop, tekst: banktekst(p) },
          { konto: b.konto, belop: -p.belop, tekst },
        ],
        ignorer: t && t.status !== "koblet" && t.status !== "ignorert" ? t.id : null,
      },
      `Ført på ${b.konto}${b.husk ? "; neste gang av seg selv" : ""}`,
      false,
    );
    if (b.husk && (p.motpart_konto || navnNokkel(p.motpart)))
      await db.query(
        `insert into faktura.bankregler (org_id, retning, motpart_konto, motpart, konto, tekst) values ($1, $2, $3, $4, $5, $6)
         on conflict (org_id, retning, coalesce(motpart_konto, ''), coalesce(motpart, '')) do update set konto = excluded.konto, tekst = excluded.tekst`,
        [org, p.belop > 0 ? "inn" : "ut", p.motpart_konto, p.motpart_konto ? null : navnNokkel(p.motpart), b.konto, b.tekst || null],
      );
  });

  // Betalingen av en ubetalt utgift (leverandørgjelden mot banken, serie U).
  handling("utgift", async (db, org, p, c) => {
    const b = z.object({ utgift_id: uuid }).parse(await c.req.json().catch(() => ({})));
    if (p.belop >= 0) throw new ApiFeil(400, "Bare penger ut kan betale en utgift");
    const u = await en<{ leverandor: string | null; fakturanummer: string | null }>(db, "select leverandor, fakturanummer from faktura.utgifter where org_id = $1 and id = $2", [
      org,
      b.utgift_id,
    ]);
    if (!u) throw new ApiFeil(404, "Fant ikke utgiften");
    await utfor(db, org, p, { type: "utgift", utgift_id: b.utgift_id, leverandor: u.leverandor }, `Betaling av fakturaen fra ${u.leverandor ?? "leverandøren"}${u.fakturanummer ? ` (${u.fakturanummer})` : ""}`, false);
  });

  // Koble til et bilag som alt fører beløpet på bankkontoen.
  handling("bilag", async (db, org, p, c) => {
    const b = z.object({ bilag_id: uuid }).parse(await c.req.json().catch(() => ({})));
    const n = await en<{ nummer: string }>(db, "select serie || '-' || aar || '-' || nummer as nummer from faktura.bilag where org_id = $1 and id = $2", [org, b.bilag_id]);
    if (!n) throw new ApiFeil(404, "Fant ikke bilaget");
    await utfor(db, org, p, { type: "bilag", bilag_id: b.bilag_id, nummer: n.nummer }, `Koblet til bilag ${n.nummer}`, false);
  });

  // Angre: et bilag i serie B reverseres; er posten koblet til betalingen av en utgift, angres
  // betalingen (utgiften står som ubetalt). Posten blir uavklart, og reglene foreslår bare.
  handling("angre", async (db, org, p) => {
    if (p.status !== "avstemt") throw new ApiFeil(409, "Bankposten er ikke ført");
    const b = p.bilag_id ? await en<{ kilde: string; kilde_id: string | null }>(db, "select kilde, kilde_id from faktura.bilag where id = $1", [p.bilag_id]) : undefined;
    await db.query("select faktura.apne_bankpost($1, $2, false)", [org, p.id]);
    if (b?.kilde === "utgift_betaling" && b.kilde_id) {
      const u = await en<{ betaling_bilag_id: string | null }>(db, "select betaling_bilag_id from faktura.utgifter where org_id = $1 and id = $2", [org, b.kilde_id]);
      if (u?.betaling_bilag_id === p.bilag_id) await db.query("select faktura.angre_utgift_betaling($1, $2)", [org, b.kilde_id]);
    }
  });

  // Innbetalingen er ikke en fakturabetaling: den tas bort fra Innbetalinger, og reglene vurderer den.
  handling("ikke-faktura", async (db, org, p) => {
    const t = await banktransaksjon(db, org, p);
    if (!t) throw new ApiFeil(404, "Fant ikke innbetalingen");
    await db.query("select faktura.ignorer_banktransaksjon($1, true)", [t.id]);
    if (p.status !== "avstemt") await db.query("select faktura.sett_bankpost($1, $2, 'ny', null, null)", [org, p.id]);
  });

  // Vurder posten på nytt (f.eks. etter at kvitteringen er lastet opp); workeren gjør det om litt.
  handling("vurder", async (db, org, p) => {
    if (p.status === "avstemt") throw new ApiFeil(409, "Bankposten er alt ført");
    await db.query("select faktura.sett_bankpost($1, $2, 'ny', null, null)", [org, p.id]);
  });

  return r;
}
