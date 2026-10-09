import { Hono } from "hono";
import { z } from "zod";
import { alle, en, somSystem } from "./db.js";
import { feilhandterer } from "./feil.js";
import { fakturaEpost, hentFaktura, pdfFilnavn, purringEpost, sikrePdf } from "./dokument.js";
import { epost, leggIKo, publiser, type Oppgave } from "./tjenester.js";
import { kjorIndeksregulering } from "./indeksregulering.js";
import { kopierTilDisk, slettFraDisk, synkOrganisasjon } from "./googleDisk.js";
import { sendVarsel } from "./push.js";
import { varsleForfalte, varsleGjentakende, varsleOmHendelse } from "./varsler.js";
import { sjekkEhf } from "./peppol.js";
import { ryddVedlegg, vedleggFiler } from "./vedlegg.js";
import { oppdaterEhfKoblinger, sendSomEhf, sjekkEhfLevering } from "./ehfSending.js";
import { fullforBankOkt, hentInnbetalinger, lagBankAdresse, planleggBankhenting, slettBankOkter } from "./bank.js";
import { sendPaaminnelser } from "./paaminnelser.js";
import { sendBursdager } from "./bursdager.js";
import { endreTilgang, hentSkattekort, hentSkattekortSvar, lagTilgang, planleggDagligSkattekort, planleggTilgangssjekk, registrerAltinnSystem, sjekkTilgang } from "./skattekort.js";
import { lagAmelding, planleggAmeldingssjekk, sjekkAmelding } from "./ameldingInnsending.js";
import { planleggMaanedsrapporter, sendRapporter, valgSkjema } from "./rapportmodul.js";
import { varsleAarsoversikter } from "./lonnAarsoversikt.js";
import { varsleTrekktabeller } from "./trekktabeller.js";

// Workeren nås bare av Cloud Scheduler, Cloud Tasks og Pub/Sub. Cloud Run sjekker
// OIDC-tokenet (roles/run.invoker) før forespørselen kommer hit.

const logg = (severity: string, message: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ severity, message, ...data }));

type SystemDb = Parameters<Parameters<typeof somSystem>[0]>[0];

// Hvem en faktura (eller purring) sendes til: kunden, med e-posten slik den står i
// kunderegisteret nå (den kan være rettet etter utstedelsen), kopimottakerne på fakturaen
// (synlig kopi) og organisasjonens faste kopiadresse (blindkopi). Uten fast kopiadresse
// går blindkopien til organisasjonens egen e-post. Ingen får e-posten to ganger.
export async function mottakere(db: SystemDb, f: any) {
  const r = await en(
    db,
    `select k.epost, o.kopi_til as fast from faktura.kunder k join faktura.organisasjoner o on o.id = k.org_id where k.id = $1`,
    [f.kunde_id],
  );
  const til = (r?.epost ?? f.kunde?.epost ?? undefined) as string | undefined;
  const sett = new Set<string>(til ? [til.toLowerCase()] : []);
  const unike = (liste: string[]) =>
    liste.filter((e) => {
      const k = e.toLowerCase();
      if (sett.has(k)) return false;
      sett.add(k);
      return true;
    });
  const kopi = unike((f.kopi_til ?? []) as string[]);
  const fast = ((r?.fast ?? []) as string[]).length ? (r!.fast as string[]) : f.selger?.epost ? [f.selger.epost as string] : [];
  return { til, kopi, blindkopi: unike(fast) };
}

// Lager PDF, lagrer den og sender fakturaen med vedleggene: som EHF når kunden kan ta imot
// det og organisasjonen har koblet til EHF-sending, ellers (eller når EHF ikke kom fram) på
// e-post. Ved EHF får kopimottakerne og organisasjonen en kopi på e-post. Trygg å kjøre
// flere ganger: PDF-en og arkivkopiene av vedleggene gjenbrukes, EHF-en sendes én gang per
// oppgave, og e-posten har idempotensnøkkel per oppgave.
export async function sendFaktura(o: { faktura_id: string; send_epost: boolean; ehf?: boolean; oppgave_id: string }) {
  await somSystem(async (db) => {
    const rad = await en(db, "select org_id from faktura.fakturaer where id = $1", [o.faktura_id]);
    if (!rad) return logg("WARNING", "Fant ikke fakturaen", o);
    const f = await hentFaktura(db, rad.org_id, o.faktura_id);
    if (f.status === "utkast") return logg("WARNING", "Fakturaen er ikke utstedt", o);

    const { sti, data } = await sikrePdf(db, f);
    const vedlegg = await vedleggFiler(db, f, true);
    let sendtTil: string | null = null;
    const m = await mottakere(db, f);
    const pdf = { filnavn: pdfFilnavn(f), data };
    const ehf = o.send_epost && o.ehf !== false ? await sendSomEhf(db, f, pdf, vedlegg, o.oppgave_id) : null;
    // Kunden har fått EHF-en (eller vi vet ikke om den kom fram): ingen e-post til kunden.
    const viaEhf = ehf !== null && ehf.status !== "feilet";
    // Kopi på e-post: kopimottakerne på fakturaen, ellers organisasjonens faste kopiadresse.
    const til = viaEhf ? (m.kopi.length ? m.kopi : m.blindkopi) : m.til ? [m.til] : [];
    if (o.send_epost && til.length && !(viaEhf && ehf.status === "sender")) {
      const e = fakturaEpost(f, viaEhf);
      const sendt = await epost().send({
        fraNavn: f.selger.navn,
        til,
        svarTil: f.selger.epost ?? undefined,
        kopi: viaEhf ? [] : m.kopi,
        blindkopi: viaEhf && m.kopi.length ? m.blindkopi : viaEhf ? [] : m.blindkopi,
        emne: e.emne,
        tekst: e.tekst,
        html: e.html,
        vedlegg: [{ ...pdf, type: "application/pdf" }, ...vedlegg],
        idempotensnokkel: `faktura-${o.oppgave_id}`,
      });
      await db.query("select faktura.logg_epost($1, $2, null, $3, $4, $5, $6)", [f.org_id, f.id, sendt.id, til[0], e.emne, viaEhf ? til.slice(1) : m.kopi]);
      if (!viaEhf) sendtTil = m.til!;
    }
    if (viaEhf) sendtTil = `EHF (org.nr. ${ehf.mottaker.split(":")[1]})`;
    await db.query("select faktura.marker_sendt($1, $2, $3)", [f.id, sti, sendtTil]);
    logg("INFO", "Faktura sendt", { faktura_id: f.id, fakturanummer: f.fakturanummer, ehf: ehf?.status ?? null, epost: Boolean(sendtTil) && !viaEhf });
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

// Sender betalingspåminnelse eller inkassovarsel med den opprinnelige fakturaen og
// vedleggene på den.
export async function sendPurring(o: { purring_id: string; oppgave_id: string }) {
  await somSystem(async (db) => {
    const p = await en(db, "select * from faktura.purringer where id = $1", [o.purring_id]);
    if (!p) return logg("WARNING", "Fant ikke purringen", o);
    if (p.sendt_at) return;
    const f = await hentFaktura(db, p.org_id, p.faktura_id);
    const m = await mottakere(db, f);
    if (!m.til) return logg("WARNING", "Kunden mangler e-post; purringen ble ikke sendt", { purring_id: p.id });
    const { data } = await sikrePdf(db, f);
    const vedlegg = await vedleggFiler(db, f, true);
    const e = purringEpost(f, p);
    const sendt = await epost().send({
      fraNavn: f.selger.navn,
      til: [m.til],
      svarTil: f.selger.epost ?? undefined,
      kopi: m.kopi,
      blindkopi: m.blindkopi,
      emne: e.emne,
      tekst: e.tekst,
      html: e.html,
      vedlegg: [{ filnavn: pdfFilnavn(f), data, type: "application/pdf" }, ...vedlegg],
      idempotensnokkel: `purring-${p.id}`,
    });
    await db.query("select faktura.logg_epost($1, $2, $3, $4, $5, $6, $7)", [f.org_id, f.id, p.id, sendt.id, m.til, e.emne, m.kopi]);
    await db.query("select faktura.marker_purring_sendt($1, $2)", [p.id, m.til]);
    logg("INFO", "Purring sendt", { purring_id: p.id, type: p.type });
  });
}

export async function kjorOppgave(o: Oppgave & { oppgave_id: string }) {
  if (o.type === "send-faktura") return sendFaktura(o);
  if (o.type === "sjekk-ehf") return sjekkEhfLevering(o);
  if (o.type === "send-purring") return sendPurring(o);
  if (o.type === "disk-synk") return synkOrganisasjon(o.bruker_id, o.org_id, sikrePdf, pdfFilnavn);
  if (o.type === "disk-slett") return slettFraDisk(o.org_id, o.faktura_ider, pdfFilnavn);
  if (o.type === "varsel") return void (await sendVarsel(o.varsel));
  if (o.type === "bank-auth") return lagBankAdresse(o.org_id, o.kobling_id);
  if (o.type === "bank-okt") return fullforBankOkt(o.org_id, o.kobling_id, o.kode, o.psu);
  if (o.type === "bank-hent") return void (await hentInnbetalinger(o.org_id, { koblingId: o.kobling_id, psu: o.psu, kilde: o.kilde }));
  if (o.type === "bank-slett") return slettBankOkter(o.org_id, o.okt_ider, o.alt);
  if (o.type === "skattekort-tilgang") return lagTilgang(o.org_id);
  if (o.type === "skattekort-status") return sjekkTilgang(o.org_id);
  if (o.type === "skattekort-hent")
    return void (await hentSkattekort(o.org_id, { ansattIder: o.ansatt_ider, daglig: o.daglig, aar: o.aar, kilde: o.kilde }));
  if (o.type === "skattekort-svar") return hentSkattekortSvar(o.org_id, o.referanse, o.aar, o.forsok);
  if (o.type === "altinn-system") return void (await registrerAltinnSystem());
  if (o.type === "altinn-endring") return endreTilgang(o.org_id);
  if (o.type === "amelding-lag") return lagAmelding(o.org_id, o.amelding_id);
  if (o.type === "amelding-status") return sjekkAmelding(o.org_id, o.amelding_id, o.forsok);
  if (o.type === "rapport-send") return sendRapporter(o);
  return sendEpost(o);
}

// Fakturaene som skal få automatisk betalingspåminnelse nå (organisasjoner som har slått det på).
// Den venter mens en innbetaling som trolig gjelder fakturaen, er reservert i banken.
export const fakturaerSomSkalPurres = () =>
  somSystem((db) =>
    alle<{ id: string }>(
      db,
      `select f.id from faktura.fakturaer f
         join faktura.organisasjoner o on o.id = f.org_id
        where o.purring_auto and o.verifisering <> 'sperret'
          and f.type = 'faktura' and f.status = 'utstedt'
          and f.forfallsdato + o.purring_dager <= faktura.i_dag()
          and coalesce((select k.epost from faktura.kunder k where k.id = f.kunde_id), f.kunde ->> 'epost') is not null
          and not exists (select 1 from faktura.purringer p where p.faktura_id = f.id)
          and not exists (select 1 from faktura.reserverte_innbetalinger r where r.faktura_id = f.id)`,
    ),
  );

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

  const sendteGjentakende: string[] = [];
  const gjentakelser = await somSystem((db) =>
    alle<{ id: string }>(
      db,
      "select id from faktura.gjentakelser where aktiv and neste_dato <= faktura.i_dag() and faktura.har_funksjon(org_id, 'gjentakende') order by neste_dato",
    ),
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
        sendteGjentakende.push(fakturaId);
      } catch (e) {
        resultat.push({ id, ok: false, feil: (e as Error).message });
        break;
      }
    }
  }

  // Automatisk betalingspåminnelse for organisasjoner som har slått det på.
  const forfalte = await fakturaerSomSkalPurres();
  for (const { id } of forfalte) {
    try {
      const p = await somSystem((db) => en(db, "select id from faktura.lag_purring($1, 'paaminnelse', true)", [id]));
      await leggIKo({ type: "send-purring", purring_id: p!.id });
      resultat.push({ id, ok: true });
    } catch (e) {
      resultat.push({ id, ok: false, feil: (e as Error).message });
    }
  }

  // Push-varsler: gjentakende fakturaer som ble sendt nå, og fakturaer som forfalt i går.
  try {
    await varsleGjentakende(sendteGjentakende);
    await varsleForfalte();
  } catch (e) {
    logg("ERROR", "Push-varsler fra daglig jobb feilet", { feil: (e as Error).message });
  }

  // EHF-koblingene: selskapets status hos Recommand, og om nøkkelen virker.
  try {
    await oppdaterEhfKoblinger();
  } catch (e) {
    logg("ERROR", "Oppdatering av EHF-koblinger feilet", { feil: (e as Error).message });
  }

  // Vedlegg som aldri ble lagret på en faktura, og filene etter slettede vedlegg.
  try {
    await ryddVedlegg();
  } catch (e) {
    logg("ERROR", "Opprydding av vedlegg feilet", { feil: (e as Error).message });
  }

  // EHF: hvilke kunder som kan motta EHF, endres sjelden, men kan endres når som helst.
  try {
    await oppdaterEhf();
  } catch (e) {
    logg("ERROR", "EHF-oppslag feilet", { feil: (e as Error).message });
  }

  // Skattekort fra Skatteetaten: endringene siden i går (og de ansatte som mangler skattekortet for året).
  try {
    await planleggDagligSkattekort();
  } catch (e) {
    logg("ERROR", "Planlegging av skattekort feilet", { feil: (e as Error).message });
  }

  // Fra desember: påminnelse til plattformadministratorene om trekktabellene som mangler.
  try {
    await varsleTrekktabeller();
  } catch (e) {
    logg("ERROR", "Påminnelse om trekktabellene feilet", { feil: (e as Error).message });
  }

  // I januar: årsoversikten for året før til de ansatte (én gang per organisasjon).
  try {
    await varsleAarsoversikter();
  } catch (e) {
    logg("ERROR", "Varsel om årsoversikten feilet", { feil: (e as Error).message });
  }

  // Den 1. i måneden: månedsrapportene til regnskapsførerne som har bedt om dem.
  try {
    await planleggMaanedsrapporter();
  } catch (e) {
    logg("ERROR", "Planlegging av månedsrapporter feilet", { feil: (e as Error).message });
  }

  logg(resultat.some((r) => !r.ok) ? "WARNING" : "INFO", "Gjentakelser kjørt", { antall: resultat.length, feil: resultat.filter((r) => !r.ok) });
  return resultat;
}

// EHF: hvilke kunder som kan motta EHF. Daglig: de som ikke er sjekket på 30 dager (en
// mottaker kan bli registrert eller avregistrert når som helst). Hvert minutt (nye): de som
// aldri er sjekket, som importerte kunder og kunder der oppslaget feilet da de ble lagret, så
// de er sjekket kort tid etter at de er lagt inn. Feiler oppslaget, prøves kunden igjen om
// en time. Samme org.nr. hos flere organisasjoner slås opp én gang.
const ehfFeilet = new Map<string, number>(); // kunde-id → da oppslaget sist feilet
let ehfPagar = false;
export async function oppdaterEhf(maks = 300, { nye = false } = {}) {
  if (nye && ehfPagar) return { sjekket: 0, oppdatert: 0 };
  if (nye) ehfPagar = true;
  try {
    for (const [id, tid] of ehfFeilet) if (Date.now() - tid > 3600_000) ehfFeilet.delete(id);
    const kunder = await somSystem((db) =>
      alle<{ id: string; orgnr: string }>(
        db,
        nye
          ? `select id, orgnr from faktura.kunder
              where orgnr is not null and land = 'NO' and aktiv and ehf_sjekket is null and not (id = any($2::uuid[]))
              order by opprettet limit $1`
          : `select id, orgnr from faktura.kunder
              where orgnr is not null and land = 'NO' and aktiv
                and (ehf_sjekket is null or ehf_sjekket < now() - interval '30 days')
              order by ehf_sjekket nulls first limit $1`,
        nye ? [maks, [...ehfFeilet.keys()]] : [maks],
      ),
    );
    const svar = new Map<string, Promise<boolean | null>>();
    let oppdatert = 0;
    for (let i = 0; i < kunder.length; i += 5) {
      await Promise.all(
        kunder.slice(i, i + 5).map(async (k) => {
          if (!svar.has(k.orgnr)) svar.set(k.orgnr, sjekkEhf(k.orgnr));
          const ja = await svar.get(k.orgnr)!;
          if (ja === null) return void ehfFeilet.set(k.id, Date.now());
          await somSystem((db) => db.query("update faktura.kunder set ehf = $2, ehf_sjekket = now() where id = $1", [k.id, ja]));
          oppdatert++;
        }),
      );
    }
    return { sjekket: kunder.length, oppdatert };
  } finally {
    if (nye) ehfPagar = false;
  }
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
        if (r.hendelse === "organisasjon.kopi_endret") await varsleKopiadresse(db, r);
        if (r.hendelse === "organisasjon.rapportmottakere_endret") await varsleRapportmottakere(db, r);
        await db.query("update faktura.utboks set publisert_at = now() where id = $1", [r.id]);
        ok++;
      } catch (e) {
        await db.query("update faktura.utboks set forsok = forsok + 1, siste_feil = $2 where id = $1", [r.id, (e as Error).message]);
      }
    }
    return { behandlet: rader.length, publisert: ok };
  });
}

async function varsleEiere(db: SystemDb, orgId: string, emne: (navn: string) => string, tekst: (navn: string) => string, idempotensnokkel: string) {
  const o = await en(db, "select navn from faktura.organisasjoner where id = $1", [orgId]);
  const eiere = await alle<{ epost: string }>(
    db,
    "select b.epost from faktura.medlemmer m join faktura.brukere b on b.id = m.bruker_id where m.org_id = $1 and m.rolle = 'eier'",
    [orgId],
  );
  if (!eiere.length) return;
  const t = tekst(o?.navn ?? "");
  await epost().send({
    fraNavn: "HI4 Faktura",
    til: eiere.map((e) => e.epost),
    emne: emne(o?.navn ?? ""),
    tekst: t,
    html: `<pre style="font-family:Arial,Helvetica,sans-serif;font-size:14px">${t.replace(/</g, "&lt;")}</pre>`,
    idempotensnokkel,
  });
}

// Varsler alle eiere når kopiadressen endres: den som får kopi av alle fakturaer, vet nok
// til å lage overbevisende falske fakturaer eller «nytt kontonummer»-e-poster til kundene.
async function varsleKopiadresse(db: SystemDb, r: any) {
  const endretAv = r.data?.endret_av ? await en(db, "select epost from faktura.brukere where id = $1", [r.data.endret_av]) : null;
  const liste = (v: unknown) => (Array.isArray(v) && v.length ? v.join(", ") : "(organisasjonens e-post)");
  await varsleEiere(
    db,
    r.org_id,
    (navn) => `Kopi av fakturaene til ${navn} går til en ny adresse`,
    (navn) =>
      [
        `Adressen som får kopi av alle fakturaer fra ${navn}, ble endret ${new Date(r.opprettet).toLocaleString("nb-NO", { timeZone: "Europe/Oslo" })}.`,
        "",
        `Fra: ${liste(r.data?.fra)}`,
        `Til: ${liste(r.data?.til)}`,
        `Endret av: ${endretAv?.epost ?? "ukjent"}`,
        "",
        "Var ikke dette deg eller en du kjenner til, logg inn og endre den tilbake under Innstillinger med en gang, og bytt passord.",
      ].join("\n"),
    `kopi-${r.id}`,
  );
}

// Varsler alle eiere når rapportene (med lønn og personopplysninger) skal gå til nye mottakere.
export async function varsleRapportmottakere(db: SystemDb, r: any) {
  const endretAv = r.data?.endret_av ? await en(db, "select epost from faktura.brukere where id = $1", [r.data.endret_av]) : null;
  const liste = (v: unknown) => (Array.isArray(v) && v.length ? v.join(", ") : "(ingen)");
  await varsleEiere(
    db,
    r.org_id,
    (navn) => `Rapportene fra ${navn} sendes til en ny adresse`,
    (navn) =>
      [
        `Rapportene fra ${navn} (f.eks. lønn og timer) sendes nå også til: ${liste(r.data?.nye)}.`,
        "",
        `Alle mottakere: ${liste(r.data?.alle)}`,
        `Endret av: ${endretAv?.epost ?? "ukjent"} ${new Date(r.opprettet).toLocaleString("nb-NO", { timeZone: "Europe/Oslo" })}`,
        "",
        "Var ikke dette deg eller en du kjenner til, logg inn og fjern adressen under Rapporter → Utsending med en gang, og bytt passord.",
      ].join("\n"),
    `rapportmottakere-${r.id}`,
  );
}

// Varsler alle eiere når kontonummeret endres – det vanligste svindelforsøket.
async function varsleKontonr(db: SystemDb, r: any) {
  const endretAv = r.data?.endret_av ? await en(db, "select epost from faktura.brukere where id = $1", [r.data.endret_av]) : null;
  await varsleEiere(
    db,
    r.org_id,
    (navn) => `Kontonummeret for ${navn} er endret`,
    (navn) =>
      [
        `Kontonummeret for ${navn} ble endret ${new Date(r.opprettet).toLocaleString("nb-NO", { timeZone: "Europe/Oslo" })}.`,
        "",
        `Fra: ${r.data?.fra ?? "(ingen)"}`,
        `Til: ${r.data?.til ?? "(ingen)"}`,
        `Endret av: ${endretAv?.epost ?? "ukjent"}`,
        "",
        "Var ikke dette deg eller en du kjenner til, logg inn og endre kontonummeret tilbake med en gang, og bytt passord.",
      ].join("\n"),
    `kontonr-${r.id}`,
  );
}

export function lagWorker() {
  const app = new Hono();
  app.onError(feilhandterer);

  app.get("/helse", (c) => c.json({ ok: true }));

  app.post("/oppgaver/send-faktura", async (c) => {
    const o = z.object({ faktura_id: z.string().uuid(), send_epost: z.boolean(), ehf: z.boolean().optional(), oppgave_id: z.string() }).parse(await c.req.json());
    await sendFaktura(o);
    return c.json({ ok: true });
  });

  app.post("/oppgaver/sjekk-ehf", async (c) => {
    const o = z.object({ sending_id: z.string().uuid(), oppgave_id: z.string() }).parse(await c.req.json());
    await sjekkEhfLevering(o);
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

  app.post("/oppgaver/varsel", async (c) => {
    const o = z
      .object({
        varsel: z.object({
          hendelse: z.string(),
          org_id: z.string().uuid().optional(),
          bruker_id: z.string().uuid().optional(),
          unntatt: z.string().uuid().optional(),
          tittel: z.string(),
          tekst: z.string(),
          url: z.string(),
          tag: z.string().optional(),
        }),
      })
      .parse(await c.req.json());
    return c.json(await sendVarsel(o.varsel as any));
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

  // Bank (Enable Banking): BankID-adresse ved fornyelse, fullføring av koblingen, henting
  // av innbetalinger og frakobling.
  const bankOppgave = z.object({ org_id: z.string().uuid(), oppgave_id: z.string() });
  app.post("/oppgaver/bank-auth", async (c) => {
    const o = bankOppgave.extend({ kobling_id: z.string().uuid() }).parse(await c.req.json());
    await lagBankAdresse(o.org_id, o.kobling_id);
    return c.json({ ok: true });
  });
  const psuSkjema = z.object({ ip: z.string().max(100), agent: z.string().max(500) }).optional();
  app.post("/oppgaver/bank-okt", async (c) => {
    const o = bankOppgave.extend({ kobling_id: z.string().uuid(), kode: z.string().min(1).max(4000), psu: psuSkjema }).parse(await c.req.json());
    await fullforBankOkt(o.org_id, o.kobling_id, o.kode, o.psu);
    return c.json({ ok: true });
  });
  app.post("/oppgaver/bank-hent", async (c) => {
    const o = bankOppgave
      .extend({ kobling_id: z.string().uuid().optional(), psu: psuSkjema, kilde: z.enum(["automatisk", "manuell", "apnet", "tilkoblet"]).optional() })
      .parse(await c.req.json());
    return c.json(await hentInnbetalinger(o.org_id, { koblingId: o.kobling_id, psu: o.psu, kilde: o.kilde }));
  });
  app.post("/oppgaver/bank-slett", async (c) => {
    const o = bankOppgave.extend({ okt_ider: z.array(z.string().max(500)).max(50), alt: z.boolean().optional() }).parse(await c.req.json());
    await slettBankOkter(o.org_id, o.okt_ider, o.alt);
    return c.json({ ok: true });
  });

  // Skattekort fra Skatteetaten: tilgangen i Altinn, hentingen, svar som ventet, og systemet i
  // Altinns systemregister (plattformadministratoren).
  const skattOppgave = z.object({ org_id: z.string().uuid(), oppgave_id: z.string() });
  app.post("/oppgaver/skattekort-tilgang", async (c) => {
    const o = skattOppgave.parse(await c.req.json());
    await lagTilgang(o.org_id);
    return c.json({ ok: true });
  });
  app.post("/oppgaver/skattekort-status", async (c) => {
    const o = skattOppgave.parse(await c.req.json());
    await sjekkTilgang(o.org_id);
    return c.json({ ok: true });
  });
  app.post("/oppgaver/skattekort-hent", async (c) => {
    const o = skattOppgave
      .extend({
        ansatt_ider: z.array(z.string().uuid()).max(5000).optional(),
        daglig: z.boolean().optional(),
        aar: z.number().int().min(2000).max(2100).optional(),
        kilde: z.enum(["godkjent", "manuell", "automatisk", "ansatt"]).optional(),
      })
      .parse(await c.req.json());
    return c.json(await hentSkattekort(o.org_id, { ansattIder: o.ansatt_ider, daglig: o.daglig, aar: o.aar, kilde: o.kilde }));
  });
  app.post("/oppgaver/skattekort-svar", async (c) => {
    const o = skattOppgave
      .extend({ referanse: z.string().regex(/^BR\d+$/), aar: z.number().int().min(2000).max(2100), forsok: z.number().int().min(1).max(100) })
      .parse(await c.req.json());
    await hentSkattekortSvar(o.org_id, o.referanse, o.aar, o.forsok);
    return c.json({ ok: true });
  });
  app.post("/oppgaver/altinn-system", async (c) => c.json(await registrerAltinnSystem()));

  // Rapportmodulen: rapporter på e-post til regnskapsføreren.
  app.post("/oppgaver/rapport-send", async (c) => {
    const o = z
      .object({
        org_id: z.string().uuid(),
        rapporter: z.array(z.object({ id: z.string().max(60), valg: valgSkjema })).min(1).max(20),
        til: z.array(z.string().email()).min(1).max(10),
        melding: z.string().max(2000).nullish(),
        bruker_id: z.string().uuid().nullish(),
        automatisk: z.enum(["lonn", "maaned"]).nullish(),
        oppgave_id: z.string(),
      })
      .parse(await c.req.json());
    await sendRapporter(o);
    return c.json({ ok: true });
  });

  app.post("/jobber/gjenta", async (c) => c.json(await gjenta()));
  // Hvert minutt: utboksen og påminnelsene. Samme hjerteslag henter fra banken på de faste
  // hentetidene (planleggingen tar hver hentetid én gang per bank), sjekker nye kunder for
  // EHF (litt om gangen), sender bursdagsvarslene (fra kl. 08, én gang per bursdag) og sjekker
  // forespørslene om tilgang til skattekort som venter på godkjenning i Altinn, og
  // a-meldingene som venter på tilbakemelding.
  app.post("/jobber/utboks", async (c) => {
    const r = await publiserUtboks();
    await sendPaaminnelser().catch((e) => logg("ERROR", "Påminnelser feilet", { feil: (e as Error).message }));
    await sendBursdager().catch((e) => logg("ERROR", "Bursdagsvarsler feilet", { feil: (e as Error).message }));
    await planleggBankhenting().catch((e) => logg("ERROR", "Planlegging av bankhenting feilet", { feil: (e as Error).message }));
    await oppdaterEhf(10, { nye: true }).catch((e) => logg("ERROR", "EHF-oppslag for nye kunder feilet", { feil: (e as Error).message }));
    await planleggTilgangssjekk().catch((e) => logg("ERROR", "Sjekk av tilgangene i Altinn feilet", { feil: (e as Error).message }));
    await planleggAmeldingssjekk().catch((e) => logg("ERROR", "Sjekk av a-meldingene feilet", { feil: (e as Error).message }));
    return c.json(r);
  });
  app.post("/jobber/bank", async (c) => c.json({ planlagt: await planleggBankhenting() }));

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

  // Push-varsler for hendelser fra utboksen (betalt, e-post som ikke kom fram).
  app.post("/hendelser/varsler", async (c) => {
    const kropp: any = await c.req.json().catch(() => ({}));
    const m = kropp?.message;
    const data = JSON.parse(Buffer.from(m?.data ?? "", "base64").toString() || "{}");
    await varsleOmHendelse(m?.attributes?.hendelse, m?.attributes?.org_id, m?.attributes?.utboks_id, data);
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
