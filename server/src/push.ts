// Push-varsler (Web Push, RFC 8030/8291/8292) til brukernes enheter.
//
// API-et lager VAPID-nøkkelparet første gang en bruker vil slå på varsler, og
// krypterer den private nøkkelen med Cloud KMS. Workeren dekrypterer og sender.
// Innholdet krypteres ende til ende til enheten; push-tjenesten (Google, Apple,
// Mozilla, Microsoft) ser bare kryptert innhold.
import { Hono } from "hono";
import webpush from "web-push";
import { z } from "zod";
import { config } from "./config.js";
import { alle, en, somBruker, somSystem, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { dekrypter, krypter } from "./kryptering.js";
import { leggIKo } from "./tjenester.js";

export const VARSELTYPER = {
  betaling: "Betaling mottatt",
  forfalt: "Faktura har forfalt",
  epostfeil: "E-post kom ikke fram",
  gjentakende: "Gjentakende fakturaer sendt",
  indeksregulering: "Indeksregulering planlagt",
  bank: "Innbetalinger fra banken",
  paaminnelse: "Påminnelser om å lage fakturaer",
  timer: "Timelister levert, godkjent og avvist, og timebanken",
  vakter: "Vaktplan: nye, endrede og ledige vakter og vaktbytter",
  fravaer: "Sykdom, fravær og avspasering",
  bursdag: "Bursdager i organisasjonen",
  beskjed: "Beskjeder til rollene dine",
  lonn: "Lønnsslippen er klar",
} as const;
export type Varseltype = keyof typeof VARSELTYPER;

export interface Varsel {
  hendelse: Varseltype | "test";
  org_id?: string; // alle direkte medlemmer av organisasjonen (unntatt ansatte) som vil ha denne typen varsel
  bruker_id?: string; // eller én bestemt bruker
  bruker_ider?: string[]; // eller bare disse brukerne (med org_id: de som fortsatt er med i organisasjonen)
  unntatt?: string; // brukeren som selv utløste hendelsen, trenger ikke varsel
  tittel: string;
  tekst: string;
  url: string; // sti i appen, f.eks. /fakturaer/<id>
  tag?: string; // samme tag erstatter et tidligere varsel på enheten
}

// Bare kjente push-tjenester. Endepunktet kommer fra nettleseren, og workeren sender
// en forespørsel dit; en vilkårlig adresse ville latt hvem som helst styre den.
const PUSHTJENESTER = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)push\.apple\.com$/,
  /\.notify\.windows\.com$/,
];

export function gyldigEndepunkt(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && u.port === "" && !u.username && PUSHTJENESTER.some((r) => r.test(u.hostname));
  } catch {
    return false;
  }
}

// --- Nøkler -----------------------------------------------------------------

// API: offentlig nøkkel til nettleseren. Lages første gang; null hvis KMS ikke er satt opp.
export async function offentligNokkel(db: Db): Promise<string | null> {
  const r = await en(db, "select offentlig from faktura.push_nokkel where id = 1");
  if (r) return r.offentlig;
  let par: { publicKey: string; privateKey: string };
  let kryptert: Buffer;
  try {
    par = webpush.generateVAPIDKeys();
    kryptert = await krypter(par.privateKey);
  } catch (e) {
    console.warn(JSON.stringify({ severity: "WARNING", message: "Kunne ikke lage VAPID-nøkkel", feil: (e as Error).message }));
    return null;
  }
  // To samtidige forespørsler: den første vinner, og begge returnerer den lagrede.
  await db.query("insert into faktura.push_nokkel (offentlig, privat_kryptert) values ($1, $2) on conflict (id) do nothing", [par.publicKey, kryptert]);
  return (await en(db, "select offentlig from faktura.push_nokkel where id = 1"))!.offentlig;
}

let vapid: { offentlig: string; privat: string } | undefined;
async function vapidNokler(db: Db) {
  if (vapid) return vapid;
  const r = await en(db, "select offentlig, privat_kryptert from faktura.push_nokkel where id = 1");
  if (!r) return null;
  vapid = { offentlig: r.offentlig, privat: await dekrypter(r.privat_kryptert) };
  return vapid;
}

// --- Sending (worker) ----------------------------------------------------------

export type PushSender = (abonnement: webpush.PushSubscription, innhold: string, valg: webpush.RequestOptions) => Promise<unknown>;
let pushSender: PushSender = (a, i, v) => webpush.sendNotification(a, i, v);
export function settPushSender(s: PushSender) {
  pushSender = s;
  vapid = undefined;
}

const medOrg = (url: string, org: string) => `${url}${url.includes("?") ? "&" : "?"}org=${org}`;

export async function sendVarsel(v: Varsel): Promise<{ sendt: number; fjernet: number }> {
  const forberedt = await somSystem(async (db) => {
    const mottakere = await alle(
      db,
      `select a.id, a.endpoint, a.p256dh, a.auth,
              (select count(*) from faktura.medlemmer mm where mm.bruker_id = a.bruker_id)::int as antall_org
         from faktura.push_abonnementer a
         left join faktura.push_valg pv on pv.bruker_id = a.bruker_id
        where ($1::uuid[] is null or a.bruker_id = any($1::uuid[]))
          and ($2::uuid is null or exists (select 1 from faktura.medlemmer m where m.org_id = $2 and m.bruker_id = a.bruker_id
                                              -- Varsler til hele organisasjonen går ikke til ansatte (de ser ikke fakturaene).
                                              and ($1::uuid[] is not null or m.rolle <> 'ansatt')))
          and a.bruker_id is distinct from $3::uuid
          and ($4 = 'test' or coalesce((pv.valg ->> $4)::boolean, true))`,
      [v.bruker_ider ?? (v.bruker_id ? [v.bruker_id] : null), v.org_id ?? null, v.unntatt ?? null, v.hendelse],
    );
    if (!mottakere.length) return null;
    // Nøkkelen dekrypteres først når det faktisk er noen å sende til.
    const nokler = await vapidNokler(db);
    if (!nokler) return null;
    const org = v.org_id ? await en(db, "select navn from faktura.organisasjoner where id = $1", [v.org_id]) : null;
    return { nokler, mottakere, orgNavn: org?.navn as string | undefined };
  });
  if (!forberedt) return { sendt: 0, fjernet: 0 };

  const { nokler, mottakere, orgNavn } = forberedt;
  const url = v.org_id ? medOrg(v.url, v.org_id) : v.url;
  const resultat = await Promise.all(
    mottakere.map(async (m) => {
      // Er brukeren med i flere organisasjoner, står organisasjonen først.
      const tekst = orgNavn && m.antall_org > 1 ? `${orgNavn}: ${v.tekst}` : v.tekst;
      try {
        await pushSender(
          { endpoint: m.endpoint, keys: { p256dh: m.p256dh, auth: m.auth } },
          JSON.stringify({ tittel: v.tittel, tekst, url, tag: v.tag, tid: Date.now() }),
          {
            vapidDetails: { subject: `mailto:${config.epostAvsender}`, publicKey: nokler.offentlig, privateKey: nokler.privat },
            TTL: 24 * 3600,
            urgency: "normal",
            timeout: 10_000,
          },
        );
        return { id: m.id, ok: true as const };
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode ?? 0;
        // 404/410: abonnementet finnes ikke lenger (avinstallert, varsler slått av).
        return { id: m.id, ok: false as const, borte: status === 404 || status === 410, feil: `${status} ${(e as Error).message}` };
      }
    }),
  );

  let fjernet = 0;
  await somSystem(async (db) => {
    for (const r of resultat) {
      if (r.ok) await db.query("update faktura.push_abonnementer set sist_sendt = now(), feil = 0 where id = $1", [r.id]);
      else if (r.borte) {
        await db.query("delete from faktura.push_abonnementer where id = $1", [r.id]);
        fjernet++;
      } else {
        // Midlertidige feil: gi opp enheten etter 10 på rad.
        await db.query("update faktura.push_abonnementer set feil = feil + 1 where id = $1", [r.id]);
        await db.query("delete from faktura.push_abonnementer where id = $1 and feil >= 10", [r.id]);
        console.warn(JSON.stringify({ severity: "WARNING", message: "Push-varsel feilet", abonnement: r.id, feil: r.feil }));
      }
    }
  });
  return { sendt: resultat.filter((r) => r.ok).length, fjernet };
}

// Sender bare første gang for en gitt nøkkel (Pub/Sub og jobber kan levere flere ganger).
export async function forsteGang(nokkel: string): Promise<boolean> {
  return somSystem(async (db) => (await en(db, "select faktura.varsle_en_gang($1) as ny", [nokkel]))!.ny as boolean);
}

// --- API-ruter (monteres under /api/push) ------------------------------------------

const b64url = (min: number, maks: number) => z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${min},${maks}}$`));

export function pushRuter() {
  const r = new Hono();

  r.get("/", async (c) =>
    c.json(
      await somBruker(c.get("bruker").id, async (db) => {
        const valg = await en(db, "select valg from faktura.push_valg where bruker_id = faktura.bruker_id()");
        return {
          nokkel: await offentligNokkel(db),
          typer: VARSELTYPER,
          valg: Object.fromEntries(Object.keys(VARSELTYPER).map((k) => [k, valg?.valg?.[k] !== false])),
          abonnementer: await alle(
            db,
            "select id, endpoint, enhet, opprettet, sist_sendt from faktura.push_abonnementer where bruker_id = faktura.bruker_id() order by opprettet desc",
          ),
        };
      }),
    ),
  );

  r.post("/abonnement", async (c) => {
    const b = z
      .object({ endpoint: z.string().max(1000), p256dh: b64url(80, 100), auth: b64url(16, 32), enhet: z.string().trim().max(120).optional() })
      .parse(await c.req.json());
    if (!gyldigEndepunkt(b.endpoint)) throw new ApiFeil(400, "Ukjent push-tjeneste");
    const id = await somBruker(c.get("bruker").id, async (db) =>
      (await en(db, "select faktura.registrer_push($1, $2, $3, $4) as id", [b.endpoint, b.p256dh, b.auth, b.enhet ?? null]))!.id,
    );
    return c.json({ id }, 201);
  });

  // Slå av på denne enheten (nettleseren kjenner endepunktet).
  r.post("/avmeld", async (c) => {
    const { endpoint } = z.object({ endpoint: z.string().max(1000) }).parse(await c.req.json());
    await somBruker(c.get("bruker").id, (db) => db.query("delete from faktura.push_abonnementer where endpoint = $1", [endpoint]));
    return c.body(null, 204);
  });

  r.delete("/abonnement/:id", async (c) => {
    const id = z.string().uuid().parse(c.req.param("id"));
    const rad = await somBruker(c.get("bruker").id, (db) => en(db, "delete from faktura.push_abonnementer where id = $1 returning id", [id]));
    if (!rad) throw new ApiFeil(404, "Finnes ikke");
    return c.body(null, 204);
  });

  r.put("/valg", async (c) => {
    const skjema = z.object(Object.fromEntries(Object.keys(VARSELTYPER).map((k) => [k, z.boolean().optional()])) as Record<Varseltype, z.ZodOptional<z.ZodBoolean>>);
    const b = skjema.strict().parse(await c.req.json());
    await somBruker(c.get("bruker").id, (db) =>
      db.query(
        `insert into faktura.push_valg (bruker_id, valg) values (faktura.bruker_id(), $1)
         on conflict (bruker_id) do update set valg = faktura.push_valg.valg || excluded.valg, oppdatert = now()`,
        [JSON.stringify(b)],
      ),
    );
    return c.json({ ok: true });
  });

  r.post("/test", async (c) => {
    const b = c.get("bruker");
    await leggIKo({
      type: "varsel",
      varsel: {
        hendelse: "test",
        bruker_id: b.id,
        tittel: "Varsler er slått på",
        tekst: "Slik ser et varsel fra HI4 Faktura ut. Trykk for å åpne innstillingene.",
        url: "/innstillinger?fane=app",
        tag: "test",
      },
    });
    return c.json({ ok: true });
  });

  return r;
}
