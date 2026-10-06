// PWA: service worker, installering, nye versjoner og push-varsler i nettleseren.
import { api } from "./api";

type Lytter = () => void;
const lyttere = new Set<Lytter>();
const endret = () => lyttere.forEach((l) => l());
export function lyttPaPwa(l: Lytter) {
  lyttere.add(l);
  return () => void lyttere.delete(l);
}

interface Installeringshendelse extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let installering: Installeringshendelse | null = null;
let venter: ServiceWorker | null = null;
let oppdatererSelv = false;

export const kanInstallere = () => Boolean(installering);
export const nyVersjonKlar = () => Boolean(venter);
export const erInstallert = () =>
  window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
export const erIos = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

export function startPwa() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // vi viser vår egen knapp
    installering = e as Installeringshendelse;
    endret();
  });
  window.addEventListener("appinstalled", () => {
    installering = null;
    endret();
  });
  if (!("serviceWorker" in navigator) || !import.meta.env.PROD) return;

  // Når brukeren har valgt «Oppdater», tar den nye versjonen over: last siden på nytt.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (oppdatererSelv) window.location.reload();
  });

  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      const sjekk = () => {
        if (reg.waiting && navigator.serviceWorker.controller) {
          venter = reg.waiting;
          endret();
        }
      };
      sjekk();
      reg.addEventListener("updatefound", () => {
        const ny = reg.installing;
        ny?.addEventListener("statechange", () => ny.state === "installed" && sjekk());
      });
      // Appen kan stå åpen lenge: se etter ny versjon hver time og når den kommer i forgrunnen.
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
      document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && reg.update().catch(() => {}));
    } catch (e) {
      console.warn("Service worker ble ikke registrert", e);
    }
  });
}

export function oppdaterApp() {
  if (!venter) return window.location.reload();
  oppdatererSelv = true;
  venter.postMessage({ type: "OPPDATER" });
}

export async function installer(): Promise<boolean> {
  if (!installering) return false;
  const h = installering;
  await h.prompt();
  const { outcome } = await h.userChoice;
  installering = null;
  endret();
  return outcome === "accepted";
}

// --- Push-varsler ------------------------------------------------------------------

// «installer»: iPhone/iPad støtter push bare i appen lagt til på Hjem-skjermen (iOS 16.4+).
export function pushStotte(): "ja" | "installer" | "nei" {
  if ("serviceWorker" in navigator && "PushManager" in window && "Notification" in window) return "ja";
  if (erIos() && !erInstallert()) return "installer";
  return "nei";
}

function tilBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = (b64url + "=".repeat((4 - (b64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function sammeNokkel(sub: PushSubscription, nokkel: string) {
  const a = sub.options.applicationServerKey;
  if (!a) return false;
  const x = new Uint8Array(a);
  const y = tilBytes(nokkel);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

// Et lesbart navn på enheten, f.eks. «Chrome på Windows» eller «Safari på iPhone».
function enhetsnavn(): string {
  const ua = navigator.userAgent;
  const nettleser = /Edg\//.test(ua)
    ? "Edge"
    : /SamsungBrowser/.test(ua)
      ? "Samsung Internet"
      : /OPR\//.test(ua)
        ? "Opera"
        : /Firefox\//.test(ua)
          ? "Firefox"
          : /Chrome\//.test(ua)
            ? "Chrome"
            : /Safari\//.test(ua)
              ? "Safari"
              : "Nettleser";
  const system = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Windows/.test(ua)
          ? "Windows"
          : /Mac OS X/.test(ua)
            ? "Mac"
            : /Linux/.test(ua)
              ? "Linux"
              : "";
  return `${erInstallert() ? "App" : nettleser}${system ? ` på ${system}` : ""}`;
}

function tilApi(sub: PushSubscription) {
  const j = sub.toJSON();
  return { endpoint: sub.endpoint, p256dh: j.keys?.p256dh ?? "", auth: j.keys?.auth ?? "", enhet: enhetsnavn() };
}

export async function hentAbonnement(): Promise<PushSubscription | null> {
  if (pushStotte() !== "ja") return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

// Må kalles direkte fra et klikk: nettleseren spør bare om tillatelse da.
export async function slaPaVarsler(nokkel: string): Promise<PushSubscription> {
  const tillatelse = await Notification.requestPermission();
  if (tillatelse !== "granted") {
    throw new Error(
      tillatelse === "denied"
        ? "Varsler er blokkert for denne siden. Tillat varsler i nettleserens innstillinger og prøv igjen."
        : "Du må tillate varsler for å slå dem på.",
    );
  }
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sammeNokkel(sub, nokkel)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: tilBytes(nokkel) });
  await api("POST", "/push/abonnement", tilApi(sub));
  return sub;
}

export async function slaAvVarsler() {
  const sub = await hentAbonnement();
  if (!sub) return;
  await api("POST", "/push/avmeld", { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

// Ved oppstart: hold serveren oppdatert om denne enheten (adressen kan endre seg).
export async function synkAbonnement() {
  try {
    if (pushStotte() !== "ja" || Notification.permission !== "granted") return;
    const sub = await hentAbonnement();
    if (sub) await api("POST", "/push/abonnement", tilApi(sub));
  } catch {
    // ikke viktig nok til å forstyrre
  }
}
