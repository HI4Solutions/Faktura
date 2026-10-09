// Altinn 3: systemet i Altinns systemregister og forespørslene om systemtilgang (systembruker).
// Leverandøren registrerer systemet én gang, med tilgangspakken «Lønn» og Maskinporten-klienten.
// For hver organisasjon lager appen en forespørsel; daglig leder (eller den som har
// tilgangsstyring i Altinn) godkjenner den på adressen i svaret (confirmUrl), og Altinn sender
// brukeren tilbake til appen. Deretter kan workeren hente token for organisasjonen.
// https://docs.altinn.studio/nb/api/authentication/systemuserapi/systemregister/create/
// https://docs.altinn.studio/nb/api/authentication/systemuserapi/systemuserrequest/external/
import { config } from "./config.js";
import { adresser, EtatFeil, etatKall, hentToken, SCOPE, systemId } from "./maskinporten.js";

// Tilgangspakken Skatteetaten krever for skattekort til arbeidsgiver.
export const TILGANGSPAKKE = "urn:altinn:accesspackage:lonn";
// Tilgangspakken for a-meldingen (docs/amelding.md); «Lønn» gjelder ikke der.
export const A_ORDNING = "urn:altinn:accesspackage:a-ordning";
// Tilgangspakken for sykmeldinger, forespørsler og inntektsmeldinger hos NAV (docs/nav.md).
export const NAV_SYKEPENGER = "urn:altinn:accesspackage:lonn-personopplysninger-saerlig-kategori";
// Tilgangspakkene systemet trenger nå: «Lønn» alltid, og de for funksjonene som er slått på.
export const tilgangspakker = () => [TILGANGSPAKKE, ...(config.ameldingInnsending ? [A_ORDNING] : []), ...(config.navSykepenger ? [NAV_SYKEPENGER] : [])];
export const PAKKENAVN: Record<string, string> = {
  [TILGANGSPAKKE]: "Lønn",
  [A_ORDNING]: "A-ordningen",
  [NAV_SYKEPENGER]: "Lønn med personopplysninger av særlig kategori",
};
// Hva hver tilgangspakke brukes til (teksten i appen når den mangler).
export const PAKKEBRUK: Record<string, string> = {
  [TILGANGSPAKKE]: "skattekortene",
  [A_ORDNING]: "a-meldingen",
  [NAV_SYKEPENGER]: "sykmeldinger og inntektsmeldinger hos NAV",
};
// Adressen Altinn sender brukeren tilbake til (må stå i systemregisteret, nøyaktig slik).
export const godkjentUrl = () => `${config.appUrl}/skattekort/godkjent`;

const api = () => `${adresser().altinn}/authentication/api/v1`;

// Feilen fra Altinn (ProblemDetails, med kode som AUTH-00007 eller AUTH.VLD-00002).
function altinnFeil(svar: { status: number; data: any; tekst: string }, hva: string): EtatFeil {
  const kode = svar.tekst.match(/AUTH(?:\.VLD)?-\d{5}/)?.[0] ?? null;
  const d = svar.data;
  const valideringer = Array.isArray(d?.validationErrors)
    ? d.validationErrors.map((e: any) => e?.detail).filter((x: unknown): x is string => typeof x === "string")
    : [];
  const melding = valideringer.join(" ") || (typeof d?.detail === "string" && d.detail) || (typeof d?.title === "string" && d.title) || `Altinn svarte ${svar.status}`;
  return new EtatFeil(`${hva}: ${melding}${kode ? ` (${kode})` : ""}`, svar.status, kode);
}

// --- Systemregisteret (leverandøren, én gang) ------------------------------------------------

export function systemdefinisjon() {
  const navn = config.altinnSystemnavn;
  return {
    id: systemId(),
    vendor: { authority: "iso6523-actorid-upis", ID: `0192:${config.leverandorOrgnr}` },
    name: { nb: navn, nn: navn, en: navn },
    description: config.ameldingInnsending
      ? {
          nb: `${navn} henter skattekortene til de ansatte fra Skatteetaten og sender a-meldingen fra lønnskjøringen.`,
          nn: `${navn} hentar skattekorta til dei tilsette frå Skatteetaten og sender a-meldinga frå lønnskøyringa.`,
          en: `${navn} retrieves the employees' tax deduction cards and submits the a-melding from payroll.`,
        }
      : {
          nb: `${navn} henter skattekortene til de ansatte fra Skatteetaten til lønnskjøringen.`,
          nn: `${navn} hentar skattekorta til dei tilsette frå Skatteetaten til lønnskøyringa.`,
          en: `${navn} retrieves the employees' tax deduction cards from the Norwegian Tax Administration for payroll.`,
        },
    accessPackages: tilgangspakker().map((urn) => ({ urn })),
    clientId: config.maskinportenKlientId ? [config.maskinportenKlientId] : [],
    allowedRedirectUrls: [godkjentUrl()],
    // Bare leverandøren lager forespørsler (fra appen); systemet vises ikke i Altinn-portalen.
    isVisible: false,
  };
}

// Registrerer systemet, eller oppdaterer det (PUT erstatter hele definisjonen). Gir "ny" eller "oppdatert".
export async function registrerSystem(): Promise<"ny" | "oppdatert"> {
  if (!config.maskinportenKlientId) throw new EtatFeil("Maskinporten er ikke satt opp (mangler klient-ID).", 503);
  const token = await hentToken(SCOPE.systemregister);
  const id = systemId();
  const def = systemdefinisjon();
  const finnes = await etatKall(`${api()}/systemregister/vendor/${encodeURIComponent(id)}`, token, { hvem: "Altinn" });
  if (finnes.status === 200) {
    const r = await etatKall(`${api()}/systemregister/vendor/${encodeURIComponent(id)}`, token, { metode: "PUT", kropp: def, hvem: "Altinn" });
    if (r.status >= 300) throw altinnFeil(r, "Kunne ikke oppdatere systemet i Altinn");
    return "oppdatert";
  }
  if (finnes.status !== 404 && finnes.status !== 400 && finnes.status !== 204) throw altinnFeil(finnes, "Kunne ikke slå opp systemet i Altinn");
  const r = await etatKall(`${api()}/systemregister/vendor`, token, { metode: "POST", kropp: def, hvem: "Altinn" });
  if (r.status >= 300) throw altinnFeil(r, "Kunne ikke registrere systemet i Altinn");
  return "ny";
}

// --- Forespørsler om systemtilgang (per organisasjon) -------------------------------------------

export type Tilgangsstatus = "ny" | "godkjent" | "avslatt" | "avvist" | "utlopt";
export type Foresporsel = { id: string | null; status: Tilgangsstatus; godkjennUrl: string | null };

// Statusen i Altinn: New, Accepted, Rejected, Denied, Timedout.
export function tilStatus(s: unknown): Tilgangsstatus {
  const v = String(s ?? "").toLowerCase();
  if (v === "accepted") return "godkjent";
  if (v === "rejected") return "avslatt";
  if (v === "denied") return "avvist";
  if (v === "timedout") return "utlopt";
  return "ny";
}

const somForesporsel = (d: any): Foresporsel => ({
  id: typeof d?.id === "string" ? d.id : null,
  status: tilStatus(d?.status),
  godkjennUrl: typeof d?.confirmUrl === "string" && d.confirmUrl.startsWith("https://") ? d.confirmUrl : null,
});

async function hentForesporselEtterOrgnr(orgnr: string): Promise<Foresporsel | null> {
  const token = await hentToken(SCOPE.foresporselLes);
  const r = await etatKall(`${api()}/systemuser/request/vendor/byexternalref/${encodeURIComponent(systemId())}/${orgnr}/${orgnr}`, token, { hvem: "Altinn" });
  if (r.status === 404) return null;
  if (r.status >= 300) throw altinnFeil(r, "Kunne ikke hente forespørselen fra Altinn");
  return somForesporsel(r.data);
}

async function slettForesporsel(id: string) {
  const token = await hentToken(SCOPE.foresporselSkriv);
  const r = await etatKall(`${api()}/systemuser/request/vendor/${encodeURIComponent(id)}`, token, { metode: "DELETE", hvem: "Altinn" });
  if (r.status >= 300 && r.status !== 404) throw altinnFeil(r, "Kunne ikke slette den gamle forespørselen i Altinn");
}

// Ny forespørsel om tilgang for organisasjonen. Har den alt systemtilgang (AUTH-00004 eller
// AUTH-00006), er den godkjent. En forespørsel som venter (AUTH-00007), brukes igjen; en som
// ble avslått eller avvist (AUTH-00008, AUTH-00009), slettes og lages på nytt.
export async function lagForesporsel(orgnr: string, forsok = 0): Promise<Foresporsel> {
  const token = await hentToken(SCOPE.foresporselSkriv);
  const r = await etatKall(`${api()}/systemuser/request/vendor`, token, {
    metode: "POST",
    kropp: { systemId: systemId(), partyOrgNo: orgnr, accessPackages: tilgangspakker().map((urn) => ({ urn })), redirectUrl: godkjentUrl() },
    hvem: "Altinn",
  });
  if (r.status < 300) return somForesporsel(r.data);
  const feil = altinnFeil(r, "Kunne ikke lage forespørselen i Altinn");
  if (feil.kode === "AUTH-00004" || feil.kode === "AUTH-00006") return { id: null, status: "godkjent", godkjennUrl: null };
  if (feil.kode === "AUTH-00007") {
    const f = await hentForesporselEtterOrgnr(orgnr);
    if (f) return f;
  }
  if ((feil.kode === "AUTH-00008" || feil.kode === "AUTH-00009") && forsok === 0) {
    const gammel = await hentForesporselEtterOrgnr(orgnr);
    if (gammel?.id) {
      await slettForesporsel(gammel.id);
      return lagForesporsel(orgnr, 1);
    }
  }
  if (feil.kode === "AUTH-00011") throw new EtatFeil("Systemet er ikke registrert i Altinn ennå. Plattformadministratoren må registrere det først.", 503, feil.kode);
  throw feil;
}

// Statusen på forespørselen (null: Altinn kjenner den ikke lenger).
export async function hentForesporsel(id: string): Promise<Foresporsel | null> {
  const token = await hentToken(SCOPE.foresporselLes);
  const r = await etatKall(`${api()}/systemuser/request/vendor/${encodeURIComponent(id)}`, token, { hvem: "Altinn" });
  if (r.status === 404) return null;
  if (r.status >= 300) throw altinnFeil(r, "Kunne ikke hente forespørselen fra Altinn");
  return somForesporsel(r.data);
}

// --- Endringsforespørsler (flere tilgangspakker for en systembruker som finnes) ----------------

// Ber kunden godkjenne flere tilgangspakker for systembrukeren (f.eks. «A-ordningen» når
// a-meldingen slås på). Har systembrukeren dem alt, er den godkjent.
// https://docs.altinn.studio/nb/api/authentication/systemuserapi/scopes/
export async function lagEndringsforesporsel(orgnr: string, pakker: string[]): Promise<Foresporsel> {
  const token = await hentToken(SCOPE.foresporselSkriv);
  const r = await etatKall(`${api()}/systemuser/changerequest/vendor`, token, {
    metode: "POST",
    kropp: {
      systemId: systemId(),
      partyOrgNo: orgnr,
      externalRef: orgnr,
      requiredAccessPackages: pakker.map((urn) => ({ urn })),
      redirectUrl: godkjentUrl(),
    },
    hvem: "Altinn",
  });
  if (r.status < 300) return somForesporsel(r.data);
  const feil = altinnFeil(r, "Kunne ikke lage endringsforespørselen i Altinn");
  // Systembrukeren har alt pakkene.
  if (feil.kode === "AUTH-00004" || feil.kode === "AUTH-00006" || /already|allerede/i.test(feil.message)) return { id: null, status: "godkjent", godkjennUrl: null };
  throw feil;
}

export async function hentEndringsforesporsel(id: string): Promise<Foresporsel | null> {
  const token = await hentToken(SCOPE.foresporselLes);
  const r = await etatKall(`${api()}/systemuser/changerequest/vendor/${encodeURIComponent(id)}`, token, { hvem: "Altinn" });
  if (r.status === 404) return null;
  if (r.status >= 300) throw altinnFeil(r, "Kunne ikke hente endringsforespørselen fra Altinn");
  return somForesporsel(r.data);
}
