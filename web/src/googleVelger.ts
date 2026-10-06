// Google Picker for å velge mappe i brukerens Google Disk. Tilgangstokenet hentes i
// nettleseren med Google Identity Services (samme OAuth-klient og scope drive.file), så
// serveren aldri trenger å dele Google-tilgangen sin. Mappen brukeren velger, blir
// tilgjengelig for appen, også for kopieringen som skjer på serveren.

declare global {
  interface Window {
    gapi?: any;
    google?: any;
  }
}

export interface VelgerOppsett {
  klientId: string;
  nokkel: string;
  appId: string;
}

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const MAPPE = "application/vnd.google-apps.folder";

const skript = new Map<string, Promise<void>>();
function lastSkript(src: string): Promise<void> {
  let p = skript.get(src);
  if (!p) {
    p = new Promise<void>((ok, feil) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = () => ok();
      s.onerror = () => {
        skript.delete(src);
        feil(new Error("Kunne ikke laste Google Picker. Sjekk nettforbindelsen eller om noe blokkerer Google."));
      };
      document.head.appendChild(s);
    });
    skript.set(src, p);
  }
  return p;
}

// Lastes på forhånd, så tilgangsvinduet kan åpnes direkte fra klikket (ellers blokkeres popupen).
export function forberedVelger(): Promise<void> {
  return Promise.all([
    lastSkript("https://accounts.google.com/gsi/client"),
    lastSkript("https://apis.google.com/js/api.js").then(() => new Promise<void>((ok) => window.gapi.load("picker", ok))),
  ]).then(() => undefined);
}

export const velgerKlar = () => Boolean(window.google?.accounts?.oauth2 && window.google?.picker);

function hentToken(oppsett: VelgerOppsett, epost?: string): Promise<string> {
  return new Promise((ok, feil) => {
    const klient = window.google.accounts.oauth2.initTokenClient({
      client_id: oppsett.klientId,
      scope: SCOPE,
      login_hint: epost,
      prompt: "",
      callback: (svar: any) => (svar.error ? feil(new Error(svar.error_description ?? "Google ga ikke tilgang")) : ok(svar.access_token)),
      error_callback: (e: any) => feil(new Error(e?.type === "popup_closed" ? "avbrutt" : "Google-vinduet kunne ikke åpnes. Tillat popup-vinduer for siden.")),
    });
    klient.requestAccessToken();
  });
}

// Returnerer valgt mappe, eller null hvis brukeren avbrøt.
export async function velgMappe(oppsett: VelgerOppsett, epost?: string): Promise<{ id: string; navn: string } | null> {
  let token: string;
  try {
    token = await hentToken(oppsett, epost);
  } catch (e) {
    if ((e as Error).message === "avbrutt") return null;
    throw e;
  }
  const p = window.google.picker;
  const mappevisning = (navn: string) => {
    const v = new p.DocsView(p.ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true).setMimeTypes(MAPPE);
    return typeof v.setLabel === "function" ? v.setLabel(navn) : v;
  };
  const minDisk = mappevisning("Min disk").setParent("root");
  const delteDisker = mappevisning("Delte disker").setEnableDrives(true);
  const delteMedMeg = mappevisning("Delt med meg").setOwnedByMe(false);
  return new Promise((ok) => {
    new p.PickerBuilder()
      .setTitle("Velg mappe for fakturaene")
      .setLocale("no")
      .addView(minDisk)
      .addView(delteDisker)
      .addView(delteMedMeg)
      .setOAuthToken(token)
      .setDeveloperKey(oppsett.nokkel)
      .setAppId(oppsett.appId)
      .setCallback((d: any) => {
        if (d.action === p.Action.PICKED && d.docs?.[0]) ok({ id: d.docs[0].id, navn: d.docs[0].name });
        else if (d.action === p.Action.CANCEL) ok(null);
      })
      .build()
      .setVisible(true);
  });
}
