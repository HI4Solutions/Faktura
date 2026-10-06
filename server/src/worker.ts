import { Hono } from "hono";
import { z } from "zod";
import { alle, en, somSystem } from "./db.js";
import { feilhandterer } from "./feil.js";
import { fakturaEpost, hentFaktura, pdfFilnavn, purringEpost, sikrePdf } from "./dokument.js";
import { epost, leggIKo, publiser, type Oppgave } from "./tjenester.js";
import { kjorIndeksregulering } from "./indeksregulering.js";
import { kopierTilDisk, slettFraDisk, synkOrganisasjon } from "./googleDisk.js";

// Workeren nås bare av Cloud Scheduler, Cloud Tasks og Pub/Sub. Cloud Run sjekker
// OIDC-tokenet (roles/run.invoker) før forespørselen kommer hit.

const logg = (severity: string, message: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ severity, message, ...data }));

// Lager PDF, lagrer den og sender e-post til kunden. Trygg å kjøre flere ganger:
// PDF-en gjenbrukes, og e-posten har idempotensnøkkel per oppgave.
export async function sendFaktura(o: { faktura_id: string; send_epost: boolean; oppgave_id: string }) {
  await somSystem(async (db) => {
    const rad = await en(db, "select org_id from faktura.fakturaer where id = $1", [o.faktura_id]);
    if (!rad) return logg("WARNING", "Fant ikke fakturaen", o);
    const f = await hentFaktura(db, rad.org_id, o.faktura_id);
    if (f.status === "utkast") return logg("WARNING", "Fakturaen er ikke utstedt", o);

    const { sti, data } = await sikrePdf(db, f);
    let sendtTil: string | null = null;
    const til = f.kunde?.epost as string | undefined;
    if (o.send_epost && til) {
      const e = fakturaEpost(f);
      const sendt = await epost().send({
        fraNavn: f.selger.navn,
        til: [til],
        svarTil: f.selger.epost ?? undefined,
        kopi: f.selger.epost ? [f.selger.epost] : undefined,
        emne: e.emne,
        tekst: e.tekst,
        html: e.html,
        vedlegg: [{ filnavn: pdfFilnavn(f), data }],
        idempotensnokkel: `faktura-${o.oppgave_id}`,
      });
      await db.query("select faktura.logg_epost($1, $2, null, $3, $4, $5)", [f.org_id, f.id, sendt.id, til, e.emne]);
      sendtTil = til;
    }
    await db.query("select faktura.marker_sendt($1, $2, $3)", [f.id, sti, sendtTil]);
    logg("INFO", "Faktura sendt", { faktura_id: f.id, fakturanummer: f.fakturanummer, epost: Boolean(sendtTil) });
  });
}

// Enkel e-post fra plattformen (verifiseringskoder, varsler til administratorer).
export async function sendEpost(o: { til: string[]; emne: string; tekst: string; fra_navn?: string; svar_til?: string; oppgave_id: string }) {
  const esc = o.tekst.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  await epost().send({
    fraNavn: o.fra_navn ?? "HI4 Faktura",
    til: o.til,
    svarTil: o.svar_til,
    emne: o.emne,
    tekst: o.tekst,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;white-space:pre-wrap">${esc}</div>`,
    idempotensnokkel: `epost-${o.oppgave_id}`,
  });
}

// Sender betalingspåminnelse eller inkassovarsel med den opprinnelige fakturaen vedlagt.
export async function sendPurring(o: { purring_id: string; oppgave_id: string }) {
  await somSystem(async (db) => {
    const p = await en(db, "select * from faktura.purringer where id = $1", [o.purring_id]);
    if (!p) return logg("WARNING", "Fant ikke purringen", o);
    if (p.sendt_at) return;
    const f = await hentFaktura(db, p.org_id, p.faktura_id);
    // Bruk kundens e-post slik den er nå; den kan være rettet etter at fakturaen ble sendt.
    const naa = await en(db, "select epost from faktura.kunder where id = $1", [f.kunde_id]);
    const til = (naa?.epost ?? f.kunde?.epost) as string | undefined;
    if (!til) return logg("WARNING", "Kunden mangler e-post; purringen ble ikke sendt", { purring_id: p.id });
    const { data } = await sikrePdf(db, f);
    const e = purringEpost(f, p);
    const sendt = await epost().send({
      fraNavn: f.selger.navn,
      til: [til],
      svarTil: f.selger.epost ?? undefined,
      kopi: f.selger.epost ? [f.selger.epost] : undefined,
      emne: e.emne,
      tekst: e.tekst,
      html: e.html,
      vedlegg: [{ filnavn: pdfFilnavn(f), data }],
      idempotensnokkel: `purring-${p.id}`,
    });
    await db.query("select faktura.logg_epost($1, $2, $3, $4, $5, $6)", [f.org_id, f.id, p.id, sendt.id, til, e.emne]);
    await db.query("select faktura.marker_purring_sendt($1, $2)", [p.id, til]);
    logg("INFO", "Purring sendt", { purring_id: p.id, type: p.type });
  });
}

export async function kjorOppgave(o: Oppgave & { oppgave_id: string }) {
  if (o.type === "send-faktura") return sendFaktura(o);
  if (o.type === "send-purring") return sendPurring(o);
  if (o.type === "disk-synk") return synkOrganisasjon(o.bruker_id, o.org_id, sikrePdf, pdfFilnavn);
  if (o.type === "disk-slett") return slettFraDisk(o.org_id, o.faktura_ider, pdfFilnavn);
  return sendEpost(o);
}

// Daglig: planlagte utkast og gjentakende fakturaer. En feil på én stopper ikke de andre.
export async function gjenta() {
  const resultat: { id: string; ok: boolean; feil?: string }[] = [];

  // Indeksregulering først, så gjentakelser med forfall fra reguleringsdatoen får ny pris.
  try {
    await kjorIndeksregulering();
  } catch (e) {
    logg("ERROR", "Indeksregulering feilet", { feil: (e as Error).message });
  }

  const planlagte = await somSystem((db) =>
    alle<{ id: string }>(db, "select id from faktura.fakturaer where status = 'utkast' and planlagt_sending <= faktura.i_dag() order by planlagt_sending"),
  );
  for (const { id } of planlagte) {
    try {
      await somSystem((db) => db.query("select faktura.utsted($1)", [id]));
      await leggIKo({ type: "send-faktura", faktura_id: id, send_epost: true });
      resultat.push({ id, ok: true });
    } catch (e) {
      resultat.push({ id, ok: false, feil: (e as Error).message });
    }
  }

  const gjentakelser = await somSystem((db) =>
    alle<{ id: string }>(db, "select id from faktura.gjentakelser where aktiv and neste_dato <= faktura.i_dag() order by neste_dato"),
  );
  for (const { id } of gjentakelser) {
    // Har kjøringen stått stille, tas opptil tre perioder igjen.
    for (let i = 0; i < 3; i++) {
      try {
        const fakturaId = await somSystem(async (db) => {
          const g = await en(db, "select aktiv, neste_dato <= faktura.i_dag() as forfalt from faktura.gjentakelser where id = $1", [id]);
          if (!g?.aktiv || !g.forfalt) return null;
          const fid = (await en(db, "select faktura.lag_fra_gjentakelse($1) as id", [id]))!.id as string | null;
          if (fid) await db.query("select faktura.utsted($1)", [fid]);
          return fid;
        });
        if (!fakturaId) break;
        await leggIKo({ type: "send-faktura", faktura_id: fakturaId, send_epost: true });
        resultat.push({ id: fakturaId, ok: true });
      } catch (e) {
        resultat.push({ id, ok: false, feil: (e as Error).message });
        break;
      }
    }
  }

  // Automatisk betalingspåminnelse for organisasjoner som har slått det på.
  const forfalte = await somSystem((db) =>
    alle<{ id: string }>(
      db,
      `select f.id from faktura.fakturaer f
         join faktura.organisasjoner o on o.id = f.org_id
        where o.purring_auto and o.verifisering <> 'sperret'
          and f.type = 'faktura' and f.status = 'utstedt'
          and f.forfallsdato + o.purring_dager <= faktura.i_dag()
          and coalesce((select k.epost from faktura.kunder k where k.id = f.kunde_id), f.kunde ->> 'epost') is not null
          and not exists (select 1 from faktura.purringer p where p.faktura_id = f.id)`,
    ),
  );
  for (const { id } of forfalte) {
    try {
      const p = await somSystem((db) => en(db, "select id from faktura.lag_purring($1, 'paaminnelse', true)", [id]));
      await leggIKo({ type: "send-purring", purring_id: p!.id });
      resultat.push({ id, ok: true });
    } catch (e) {
      resultat.push({ id, ok: false, feil: (e as Error).message });
    }
  }

  logg(resultat.some((r) => !r.ok) ? "WARNING" : "INFO", "Gjentakelser kjørt", { antall: resultat.length, feil: resultat.filter((r) => !r.ok) });
  return resultat;
}

// Hvert minutt: publiser utboksen til Pub/Sub. «skip locked» gjør at to samtidige
// kjøringer ikke tar de samme radene.
export async function publiserUtboks(maks = 500) {
  return somSystem(async (db) => {
    const rader = await alle(
      db,
      `select * from faktura.utboks where publisert_at is null and forsok < 20 order by id limit $1 for update skip locked`,
      [maks],
    );
    let ok = 0;
    for (const r of rader) {
      try {
        await publiser(r.hendelse, r.org_id, { ...r.data, hendelse: r.hendelse, org_id: r.org_id, tid: r.opprettet }, String(r.id));
        if (r.hendelse === "organisasjon.kontonr_endret") await varsleKontonr(db, r);
        await db.query("update faktura.utboks set publisert_at = now() where id = $1", [r.id]);
        ok++;
      } catch (e) {
        await db.query("update faktura.utboks set forsok = forsok + 1, siste_feil = $2 where id = $1", [r.id, (e as Error).message]);
      }
    }
    return { behandlet: rader.length, publisert: ok };
  });
}

// Varsler alle eiere når kontonummeret endres – det vanligste svindelforsøket.
async function varsleKontonr(db: Parameters<Parameters<typeof somSystem>[0]>[0], r: any) {
  const o = await en(db, "select navn from faktura.organisasjoner where id = $1", [r.org_id]);
  const eiere = await alle<{ epost: string }>(
    db,
    "select b.epost from faktura.medlemmer m join faktura.brukere b on b.id = m.bruker_id where m.org_id = $1 and m.rolle = 'eier'",
    [r.org_id],
  );
  const endretAv = r.data?.endret_av ? await en(db, "select epost from faktura.brukere where id = $1", [r.data.endret_av]) : null;
  if (!eiere.length) return;
  const tekst = [
    `Kontonummeret for ${o?.navn} ble endret ${new Date(r.opprettet).toLocaleString("nb-NO", { timeZone: "Europe/Oslo" })}.`,
    "",
    `Fra: ${r.data?.fra ?? "(ingen)"}`,
    `Til: ${r.data?.til ?? "(ingen)"}`,
    `Endret av: ${endretAv?.epost ?? "ukjent"}`,
    "",
    "Var ikke dette deg eller en du kjenner til, logg inn og endre kontonummeret tilbake med en gang, og bytt passord.",
  ].join("\n");
  await epost().send({
    fraNavn: "HI4 Faktura",
    til: eiere.map((e) => e.epost),
    emne: `Kontonummeret for ${o?.navn} er endret`,
    tekst,
    html: `<pre style="font-family:Arial,Helvetica,sans-serif;font-size:14px">${tekst.replace(/</g, "&lt;")}</pre>`,
    idempotensnokkel: `kontonr-${r.id}`,
  });
}

export function lagWorker() {
  const app = new Hono();
  app.onError(feilhandterer);

  app.get("/helse", (c) => c.json({ ok: true }));

  app.post("/oppgaver/send-faktura", async (c) => {
    const o = z.object({ faktura_id: z.string().uuid(), send_epost: z.boolean(), oppgave_id: z.string() }).parse(await c.req.json());
    await sendFaktura(o);
    return c.json({ ok: true });
  });

  app.post("/oppgaver/disk-synk", async (c) => {
    const o = z.object({ bruker_id: z.string().uuid(), org_id: z.string().uuid() }).parse(await c.req.json());
    await synkOrganisasjon(o.bruker_id, o.org_id, sikrePdf, pdfFilnavn);
    return c.json({ ok: true });
  });

  app.post("/oppgaver/disk-slett", async (c) => {
    const o = z.object({ org_id: z.string().uuid(), faktura_ider: z.array(z.string().uuid()) }).parse(await c.req.json());
    await slettFraDisk(o.org_id, o.faktura_ider, pdfFilnavn);
    return c.json({ ok: true });
  });

  app.post("/oppgaver/send-purring", async (c) => {
    const o = z.object({ purring_id: z.string().uuid(), oppgave_id: z.string() }).parse(await c.req.json());
    await sendPurring(o);
    return c.json({ ok: true });
  });

  app.post("/oppgaver/epost", async (c) => {
    const o = z
      .object({ til: z.array(z.string().email()).min(1), emne: z.string(), tekst: z.string(), fra_navn: z.string().optional(), svar_til: z.string().optional(), oppgave_id: z.string() })
      .parse(await c.req.json());
    await sendEpost(o);
    return c.json({ ok: true });
  });

  app.post("/jobber/gjenta", async (c) => c.json(await gjenta()));
  app.post("/jobber/utboks", async (c) => c.json(await publiserUtboks()));
  app.post("/jobber/bank", (c) => c.json({ ok: true, melding: "Bankintegrasjon er ikke konfigurert ennå" }));

  // Google Disk: kopi av PDF når en faktura eller kreditnota er utstedt. Feil gir 500, så Pub/Sub prøver igjen.
  app.post("/hendelser/google-disk", async (c) => {
    const kropp: any = await c.req.json().catch(() => ({}));
    const hendelse = kropp?.message?.attributes?.hendelse;
    if (hendelse === "faktura.utstedt" || hendelse === "kreditnota.utstedt") {
      const data = JSON.parse(Buffer.from(kropp.message.data ?? "", "base64").toString() || "{}");
      if (data.faktura_id) await kopierTilDisk(data.faktura_id, sikrePdf, pdfFilnavn);
    }
    return c.body(null, 204);
  });

  // Øvrige integrasjoner kvitteres foreløpig; adapterne kommer i senere faser.
  app.post("/hendelser/:integrasjon", async (c) => {
    const kropp: any = await c.req.json().catch(() => ({}));
    logg("INFO", "Hendelse mottatt", { integrasjon: c.req.param("integrasjon"), hendelse: kropp?.message?.attributes?.hendelse });
    return c.body(null, 204);
  });

  return app;
}
