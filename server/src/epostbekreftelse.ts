// Lenken som bekrefter e-postadressen til en ny konto (0105_epostbekreftelse.sql). Identity
// Platform sendte den selv, fra sin egen avsender, og hos noen kom den ikke fram eller havnet i
// søppelposten. Nå lager API-et lenken (firebase-admin), og workeren sender den fra Admin Konsoll
// gjennom Resend, så den spores som de andre e-postene (levert, sprett, klage). Lenken går til
// /bekreft-epost i appen, som bekrefter adressen hos Identity Platform. Brukeren får den første
// rett fra registreringen og kan be om nye (høyst én i minuttet og åtte i døgnet).
// Plattformadministratoren ser hvordan det gikk, og kan sende en ny lenke eller bekrefte adressen
// selv når hen vet at den er riktig.
import type { Context } from "hono";
import { identitet } from "./auth.js";
import { config } from "./config.js";
import { en, somBetrodd, somBruker, somSystem } from "./db.js";
import { ApiFeil } from "./feil.js";
import { epost, leggIKo } from "./tjenester.js";

type Bekreftelse = { id: string; til: string };

const logg = (severity: string, message: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ severity, message, ...data }));

// Lager koden og legger sendingen i køen. Går det ikke, merkes lenken som feilet, og brukeren får
// en feilmelding (appen ber da Identity Platform sende lenken i stedet).
async function lagOgSend(b: Bekreftelse, hvem: string) {
  try {
    const kode = await identitet().bekreftelseskode(b.til);
    await leggIKo({ type: "epostbekreftelse", bekreftelse_id: b.id, kode });
  } catch (e) {
    const feil = (e as Error).message || "Ukjent feil";
    logg("ERROR", "Kunne ikke lage eller sende lenken som bekrefter e-postadressen", { bekreftelse_id: b.id, feil });
    await somBetrodd(hvem, (db) => db.query("select faktura.epostbekreftelse_sendt($1, null, $2)", [b.id, feil])).catch(() => undefined);
    throw new ApiFeil(502, "Vi fikk ikke sendt lenken. Prøv igjen om litt.");
  }
}

// POST /api/meg/bekreftelse: en ny lenke til den innloggede (også før kontoen er godkjent).
export async function sendBekreftelse(c: Context) {
  const b = c.get("bruker");
  if (b.epostBekreftet) return { bekreftet: true, sendt: false };
  const e = (await somBruker(b.id, (db) => en<Bekreftelse>(db, "select id, til from faktura.be_om_epostbekreftelse()")))!;
  await lagOgSend(e, b.id);
  return { bekreftet: false, sendt: true, til: e.til };
}

// Administrasjonen: en ny lenke til brukeren.
export async function adminSendBekreftelse(c: Context, bruker: string) {
  const admin = c.get("bruker").id;
  const e = (await somBetrodd(admin, (db) => en<Bekreftelse>(db, "select id, til from faktura.admin_send_epostbekreftelse($1)", [bruker])))!;
  await lagOgSend(e, admin);
  return { sendt: true, til: e.til };
}

// Administrasjonen: bekreft e-postadressen for brukeren, hos Identity Platform og hos oss i samme
// transaksjon (sier Identity Platform nei, lagres ingenting).
export async function adminBekreftEpost(c: Context, bruker: string) {
  const admin = c.get("bruker").id;
  const b = (await somBetrodd(admin, async (db) => {
    const b = (await en<{ id: string; ekstern_id: string; epost: string }>(db, "select id, ekstern_id, epost from faktura.admin_bekreft_epost($1)", [bruker]))!;
    await identitet().bekreftEpost(b.ekstern_id);
    return b;
  }))!;
  logg("NOTICE", "Plattformadministratoren bekreftet e-postadressen for en bruker", { bruker_id: b.id, admin });
  return { id: b.id, epost: b.epost, epost_bekreftet: true };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// Fornavnet i hilsenen bare når det ser ut som et navn: navnet skriver brukeren selv, og e-posten
// går til adressen kontoen er laget med (som kan være en annens), så ingen lenker eller annen tekst
// kommer med derfra.
const navnLikt = /^\p{L}[\p{L}'’-]{0,29}$/u;

export function bekreftelsesEpost(navn: string | null, lenke: string) {
  const fornavn = navn?.trim().split(/\s+/)[0];
  const hei = fornavn && navnLikt.test(fornavn) ? `Hei ${fornavn},` : "Hei,";
  const emne = "Bekreft e-postadressen din i Admin Konsoll";
  const ellers = "Lenken kan brukes én gang. Har du ikke laget en konto i Admin Konsoll, kan du se bort fra denne e-posten.";
  const tekst = [
    hei,
    "",
    "Takk for at du har laget en konto i Admin Konsoll. Bekreft e-postadressen din ved å åpne lenken under:",
    "",
    lenke,
    "",
    ellers,
    "",
    "Hilsen",
    "Admin Konsoll",
  ].join("\n");
  const l = esc(lenke);
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:520px">
<p style="margin:0 0 16px">${esc(hei)}</p>
<p style="margin:0 0 22px">Takk for at du har laget en konto i Admin Konsoll. Bekreft e-postadressen din med knappen under.</p>
<p style="margin:0 0 26px"><a href="${l}" style="display:inline-block;background:#2f56d8;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:8px">Bekreft e-postadressen</a></p>
<p style="margin:0 0 6px;font-size:13px;color:#555">Virker ikke knappen? Kopier lenken inn i nettleseren:</p>
<p style="margin:0 0 22px;font-size:13px;word-break:break-all"><a href="${l}" style="color:#2f56d8">${l}</a></p>
<p style="margin:0 0 22px;font-size:13px;color:#555">${esc(ellers)}</p>
<p style="margin:0">Hilsen<br>Admin Konsoll</p>
</div>`;
  return { emne, tekst, html };
}

// Workeren: sender lenken. Trygg å kjøre flere ganger: en lenke som er sendt, sendes ikke igjen,
// og e-posten har idempotensnøkkel. Feiler sendingen, merkes lenken som feilet, og Cloud Tasks
// prøver igjen.
export async function sendEpostbekreftelse(o: { bekreftelse_id: string; kode: string; oppgave_id: string }) {
  const b = await somSystem((db) =>
    en<{ til: string; navn: string | null; status: string }>(db, "select til, navn, status from faktura.epostbekreftelse_til_sending($1)", [o.bekreftelse_id]),
  );
  if (!b) return logg("WARNING", "Fant ikke lenken som skulle sendes", { bekreftelse_id: o.bekreftelse_id });
  if (b.status !== "venter" && b.status !== "feilet") return;
  const e = bekreftelsesEpost(b.navn, `${config.appUrl}/bekreft-epost?kode=${encodeURIComponent(o.kode)}`);
  let id: string;
  try {
    ({ id } = await epost().send({
      fraNavn: "Admin Konsoll",
      til: [b.til],
      emne: e.emne,
      tekst: e.tekst,
      html: e.html,
      idempotensnokkel: `epostbekreftelse-${o.bekreftelse_id}`,
    }));
  } catch (err) {
    await somSystem((db) => db.query("select faktura.epostbekreftelse_sendt($1, null, $2)", [o.bekreftelse_id, (err as Error).message || "Ukjent feil"])).catch(
      () => undefined,
    );
    throw err;
  }
  await somSystem((db) => db.query("select faktura.epostbekreftelse_sendt($1, $2)", [o.bekreftelse_id, id]));
  logg("INFO", "Lenken som bekrefter e-postadressen er sendt", { bekreftelse_id: o.bekreftelse_id });
}
