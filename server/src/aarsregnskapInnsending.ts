// Årsregnskapet til Brønnøysundregistrene gjennom Altinn 3 (aarsregnskap.ts, 0120_aarsregnskap.sql,
// docs/aarsregnskap.md). Workeren henter et token fra Maskinporten for systembrukeren
// organisasjonen har gitt systemet i Altinn (tilgangspakken «Regnskap og økonomirapportering»),
// bytter det til et Altinn-token og lager instansen i Brønnøysunds app (aarsregnskap-vanlig),
// laster opp hovedskjemaet og underskjemaet, validerer og låser skjemaet for signering (komplett
// innsending). Systembrukeren kan ikke signere: daglig leder (eller den som har signaturrett)
// åpner skjemaet i Altinn med ID-porten og signerer, og da er årsregnskapet sendt inn. Skal
// årsregnskapet revideres, låses det ikke (ukomplett innsending), så revisjonsberetningen kan
// legges ved i Altinn før det signeres.
//
// Workeren følger med på instansen til den er signert (levert). Trekkes årsregnskapet tilbake,
// låses skjemaet opp igjen (tilbake til utfyllingen), og instansen brukes på nytt neste gang.
// https://github.com/brreg/docs (regnskapsregisteret/maskinell-innrapportering)
// https://docs.altinn.studio/nb/api/apps/instances/
import { altinnFeil, REGNSKAP_OKONOMI_RAPPORT } from "./altinn.js";
import { config } from "./config.js";
import { alle, en, somSystem } from "./db.js";
import { adresser, EtatFeil, etatFetch, hentToken, SCOPE } from "./maskinporten.js";
import { harPakke, hentTilgang, melding } from "./skattekort.js";
import { leggIKo } from "./tjenester.js";

const logg = (severity: string, message: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ severity, message, ...data }));

// Brønnøysunds app for årsregnskapet (RR-0002, vanlige foretak).
export const APP = "brg/aarsregnskap-vanlig-202406";
const app = () => `${adresser().brreg}/${APP}`;
// Skjemaet i Altinn for den som skal signere (instansen er «partyId/guid»).
export const instansUrl = (instans: string) => `${app()}/#/instance/${instans}`;

type Svar = { status: number; data: any; tekst: string };

async function kall(url: string, token: string, v: { metode?: "GET" | "POST" | "PUT"; kropp?: unknown; xml?: string } = {}): Promise<Svar> {
  let r: Response;
  try {
    r = await etatFetch(url, {
      method: v.metode ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(v.xml !== undefined ? { "content-type": "application/xml" } : v.kropp !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: v.xml ?? (v.kropp === undefined ? undefined : JSON.stringify(v.kropp)),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new EtatFeil(`Fikk ikke svar fra Altinn: ${(e as Error).message}`, 0);
  }
  const tekst = await r.text().catch(() => "");
  let data: any = null;
  try {
    data = tekst ? JSON.parse(tekst) : null;
  } catch {
    data = null;
  }
  return { status: r.status, data, tekst };
}

// Altinn-tokenet for organisasjonen: Maskinporten-tokenet for systembrukeren byttes hos Altinn.
// Det gjelder en time og brukes til ti minutter før.
const altinnTokener = new Map<string, { token: string; utloper: number }>();
export const glemAltinnTokener = () => altinnTokener.clear();

export async function altinnToken(orgnr: string): Promise<string> {
  const lagret = altinnTokener.get(orgnr);
  if (lagret && lagret.utloper > Date.now()) return lagret.token;
  const mp = await hentToken(SCOPE.aarsregnskap, orgnr);
  const r = await kall(`${adresser().altinn}/authentication/api/v1/exchange/maskinporten?ttl=3600`, mp);
  if (r.status >= 300) throw altinnFeil(r, "Altinn byttet ikke tokenet");
  const token = (typeof r.data === "string" ? r.data : r.tekst).trim().replace(/^"|"$/g, "");
  if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) throw new EtatFeil("Altinn svarte ikke med et token", 502);
  altinnTokener.set(orgnr, { token, utloper: Date.now() + 50 * 60_000 });
  return token;
}

type Instans = {
  id: string;
  instanceOwner?: { partyId?: string };
  data?: { id: string; dataType: string }[];
  process?: { currentTask?: { altinnTaskType?: string; elementId?: string } | null; ended?: string | null } | null;
  status?: { isArchived?: boolean; archived?: string | null } | null;
};
export type Valideringsfeil = { alvor: "feil" | "advarsel" | "info"; kode: string | null; tekst: string; felt: string | null };

const levertDato = (i: Instans) => i.process?.ended ?? (i.status?.isArchived ? (i.status.archived ?? new Date().toISOString()) : null);
// Steget instansen er i: «data» (utfyllingen) eller signeringen (låst).
const iUtfyllingen = (i: Instans) => (i.process?.currentTask?.altinnTaskType ?? "data") === "data";

async function lagInstans(token: string, orgnr: string): Promise<Instans> {
  const r = await kall(`${app()}/instances/create`, token, { metode: "POST", kropp: { instanceOwner: { organisationNumber: orgnr } } });
  if (r.status >= 300) throw altinnFeil(r, "Altinn laget ikke årsregnskapet");
  if (typeof r.data?.id !== "string") throw new EtatFeil("Altinn svarte uten instans", 502);
  return r.data;
}

async function hentInstans(token: string, instans: string): Promise<Instans | null> {
  const r = await kall(`${app()}/instances/${instans}`, token);
  if (r.status === 404) return null;
  if (r.status >= 300) throw altinnFeil(r, "Fant ikke årsregnskapet i Altinn");
  return r.data;
}

async function lastOpp(token: string, inst: Instans, type: "Hovedskjema" | "Underskjema", xml: string) {
  const element = inst.data?.find((d) => d.dataType === type);
  const url = element ? `${app()}/instances/${inst.id}/data/${element.id}` : `${app()}/instances/${inst.id}/data?dataType=${type}`;
  const r = await kall(url, token, { metode: element ? "PUT" : "POST", xml });
  if (r.status >= 300) throw altinnFeil(r, `Altinn tok ikke imot ${type === "Hovedskjema" ? "hovedskjemaet" : "underskjemaet"}`);
}

// Altinns kontroll av skjemaet (alvorlighet 1 er feil, 2 advarsel, resten informasjon).
async function valider(token: string, inst: Instans): Promise<Valideringsfeil[]> {
  const r = await kall(`${app()}/instances/${inst.id}/validate`, token);
  if (r.status >= 300) throw altinnFeil(r, "Altinn validerte ikke årsregnskapet");
  return (Array.isArray(r.data) ? r.data : []).map((v: any) => ({
    alvor: v?.severity === 1 ? "feil" : v?.severity === 2 ? "advarsel" : "info",
    kode: typeof v?.code === "string" ? v.code : null,
    tekst: String(v?.description || v?.customTextKey || v?.code || "Ukjent feil").slice(0, 500),
    felt: typeof v?.field === "string" ? v.field : null,
  }));
}

// Neste steg i prosessen: «confirm» låser skjemaet for signering, «reject» låser det opp igjen.
async function nesteSteg(token: string, inst: Instans, handling: "confirm" | "reject"): Promise<Instans> {
  const r = await kall(`${app()}/instances/${inst.id}/process/next`, token, { metode: "PUT", kropp: { action: handling } });
  if (r.status >= 300) throw altinnFeil(r, handling === "confirm" ? "Altinn låste ikke årsregnskapet for signering" : "Altinn låste ikke opp årsregnskapet");
  return (await hentInstans(token, inst.id)) ?? inst;
}

// --- Oppgavene (workeren) ---------------------------------------------------------------------------

type Rad = { id: string; org_id: string; aar: number; status: string; instans: string | null; laast: boolean; hovedskjema: string | null; underskjema: string | null; revideres: boolean | null };

const hentRad = (id: string) =>
  somSystem((db) =>
    en<Rad>(
      db,
      `select id, org_id, aar, status, instans, laast, hovedskjema, underskjema, (opplysninger ->> 'revideres')::boolean as revideres
         from faktura.aarsregnskap where id = $1`,
      [id],
    ),
  );

// Oppdaterer raden (kolonnenavnene kommer fra koden), bare når statusen er den forventede.
async function oppdater(id: string, fra: string[], felt: Record<string, unknown>) {
  const k = Object.keys(felt);
  await somSystem((db) =>
    db.query(`update faktura.aarsregnskap set ${k.map((x, i) => `${x} = $${i + 3}`).join(", ")}, oppdatert = now() where id = $1 and status = any($2::text[])`, [
      id,
      fra,
      ...k.map((x) => felt[x]),
    ]),
  );
}

// Feil som ikke går over av seg selv (avvist, ugyldig, ikke satt opp): lagres på årsregnskapet.
// De andre (ingen svar, 5xx) kastes, så oppgaven prøves igjen.
const varig = (e: unknown) => e instanceof EtatFeil && ((e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) || e.status === 503);

async function tokenFor(org: string) {
  if (!config.aarsregnskapInnsending) throw new EtatFeil("Innsendingen av årsregnskapet til Altinn er ikke slått på.", 503);
  const t = await hentTilgang(org);
  if (!t?.orgnr || !harPakke(t, REGNSKAP_OKONOMI_RAPPORT))
    throw new EtatFeil("Tilgangen i Altinn mangler tilgangspakken «Regnskap og økonomirapportering». Utvid tilgangen og prøv igjen.", 409);
  return altinnToken(t.orgnr).then((token) => ({ token, orgnr: t.orgnr! }));
}

// Sender årsregnskapet (status sender): instansen (ny, eller den fra forrige gang), skjemaene,
// valideringen og låsingen for signering.
export async function sendAarsregnskap(org: string, id: string) {
  const r = await hentRad(id);
  if (!r || r.org_id !== org || r.status !== "sender" || !r.hovedskjema || !r.underskjema) return;
  try {
    const { token, orgnr } = await tokenFor(org);
    let inst = r.instans ? await hentInstans(token, r.instans) : null;
    const levert = inst && levertDato(inst);
    if (levert) return void (await oppdater(id, ["sender"], { status: "levert", levert_at: levert, feil: null }));
    if (!inst) {
      inst = await lagInstans(token, orgnr);
      await oppdater(id, ["sender"], { instans: inst.id, instans_url: instansUrl(inst.id), laast: false });
    } else if (!iUtfyllingen(inst)) {
      inst = await nesteSteg(token, inst, "reject");
    }
    await lastOpp(token, inst, "Hovedskjema", r.hovedskjema);
    await lastOpp(token, inst, "Underskjema", r.underskjema);
    const v = await valider(token, inst);
    if (v.some((x) => x.alvor === "feil")) {
      logg("WARNING", "Altinn fant feil i årsregnskapet", { org_id: org, aarsregnskap_id: id, antall: v.length });
      return void (await oppdater(id, ["sender"], { status: "feil", feil: "Altinn fant feil i årsregnskapet (se under).", valideringsfeil: JSON.stringify(v) }));
    }
    // Skal det revideres, låses det ikke, så revisjonsberetningen kan legges ved i Altinn først.
    const laas = r.revideres === false;
    if (laas) inst = await nesteSteg(token, inst, "confirm");
    await oppdater(id, ["sender"], {
      status: "til_signering",
      laast: laas,
      feil: null,
      valideringsfeil: v.length ? JSON.stringify(v) : null,
      sjekket_at: new Date(),
    });
    logg("INFO", "Årsregnskapet ligger til signering i Altinn", { org_id: org, aarsregnskap_id: id, aar: r.aar, laast: laas });
  } catch (e) {
    if (!varig(e)) throw e;
    logg("WARNING", "Årsregnskapet ble ikke sendt til Altinn", { org_id: org, aarsregnskap_id: id, feil: melding(e) });
    await oppdater(id, ["sender"], { status: "feil", feil: melding(e) });
  }
}

// Statusen i Altinn for årsregnskapet som venter på signering.
export async function sjekkAarsregnskap(org: string, id: string) {
  const r = await hentRad(id);
  if (!r || r.org_id !== org || r.status !== "til_signering" || !r.instans) return;
  try {
    const { token } = await tokenFor(org);
    const inst = await hentInstans(token, r.instans);
    if (!inst)
      return void (await oppdater(id, ["til_signering"], {
        status: "feil",
        feil: "Årsregnskapet finnes ikke lenger i Altinn. Send det på nytt.",
        instans: null,
        instans_url: null,
        laast: false,
        sjekket_at: new Date(),
      }));
    const levert = levertDato(inst);
    if (levert) {
      logg("INFO", "Årsregnskapet er signert og sendt inn", { org_id: org, aarsregnskap_id: id, aar: r.aar });
      return void (await oppdater(id, ["til_signering"], { status: "levert", levert_at: levert, feil: null, sjekket_at: new Date() }));
    }
    await oppdater(id, ["til_signering"], { laast: !iUtfyllingen(inst), feil: null, sjekket_at: new Date() });
  } catch (e) {
    if (!varig(e)) throw e;
    await oppdater(id, ["til_signering"], { feil: melding(e), sjekket_at: new Date() });
  }
}

// Trekker årsregnskapet tilbake fra signeringen: skjemaet låses opp i Altinn, og det kan endres og
// sendes på nytt (til samme instans).
export async function trekkTilbakeAarsregnskap(org: string, id: string) {
  const r = await hentRad(id);
  if (!r || r.org_id !== org || r.status !== "til_signering") return;
  try {
    const { token } = await tokenFor(org);
    const inst = r.instans ? await hentInstans(token, r.instans) : null;
    const levert = inst && levertDato(inst);
    if (levert) return void (await oppdater(id, ["til_signering"], { status: "levert", levert_at: levert, feil: null }));
    if (inst && !iUtfyllingen(inst)) await nesteSteg(token, inst, "reject");
    await oppdater(id, ["til_signering"], {
      status: "utkast",
      laast: false,
      feil: null,
      valideringsfeil: null,
      ...(inst ? {} : { instans: null, instans_url: null }),
    });
  } catch (e) {
    if (!varig(e)) throw e;
    await oppdater(id, ["til_signering"], { feil: `Kunne ikke trekke årsregnskapet tilbake: ${melding(e)}` });
  }
}

// Hvert minutt (hjerteslaget): en innsending som ikke ble ferdig på en halvtime, får feil (så den
// kan sendes på nytt), og årsregnskapene som venter på signering sjekkes: hvert kvarter det første
// døgnet, deretter hver sjette time, i 90 dager.
export async function planleggAarsregnskapssjekk(): Promise<number> {
  if (!config.aarsregnskapInnsending) return 0;
  await somSystem((db) =>
    db.query(
      `update faktura.aarsregnskap set status = 'feil', feil = 'Innsendingen til Altinn ble ikke ferdig. Prøv igjen.', oppdatert = now()
        where status = 'sender' and sendt_at < now() - interval '30 minutes'`,
    ),
  );
  const rader = await somSystem((db) =>
    alle<{ id: string; org_id: string }>(
      db,
      `update faktura.aarsregnskap set sjekket_at = now()
        where status = 'til_signering' and instans is not null and sendt_at > now() - interval '90 days'
          and (sjekket_at is null
               or sjekket_at < now() - case when sendt_at > now() - interval '1 day' then interval '15 minutes' else interval '6 hours' end)
       returning id, org_id`,
    ),
  );
  for (const r of rader) await leggIKo({ type: "aarsregnskap-status", org_id: r.org_id, aarsregnskap_id: r.id });
  return rader.length;
}
