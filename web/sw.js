/* HI4 Faktura – service worker.
 *
 * Bygges av vite.config.ts, som setter inn VERSJON og FILER (app-skallet i dette bygget).
 * - App-skallet lagres ved installasjon, så appen starter også uten nett.
 * - API-et (/api/…) går alltid rett til nettet og lagres aldri: det er personopplysninger.
 * - Push-varsler vises som systemvarsler; et trykk åpner riktig side i appen.
 */
const VERSJON = "__VERSJON__";
const FILER = __FILER__;
const SKALL = `skall-${VERSJON}`;
const FONTER = "fonter-v1";
const KONFIG = "konfig-v1";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SKALL).then((c) => c.addAll(FILER)));
  // En ny versjon venter til brukeren trykker «Oppdater» (se OPPDATER under), så ingen
  // mister noe de holder på med. Første gang er det ingen å vente på.
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      for (const navn of await caches.keys()) if (navn.startsWith("skall-") && navn !== SKALL) await caches.delete(navn);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "OPPDATER") self.skipWaiting();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith("/api/")) return; // aldri lagre API-svar
    if (url.pathname === "/__/firebase/init.json") return e.respondWith(nettForst(req, KONFIG));
    if (url.pathname.startsWith("/__/")) return; // Firebase sine egne sider
    if (req.mode === "navigate") return e.respondWith(side(req));
    if (url.pathname.startsWith("/assets/") || FILER.includes(url.pathname)) return e.respondWith(lagretForst(req, SKALL));
    return;
  }
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") return e.respondWith(lagretForst(req, FONTER));
});

// Sider: nettet først (alltid nyeste versjon), app-skallet når man er frakoblet.
async function side(req) {
  try {
    return await fetch(req);
  } catch {
    return (await caches.match("/", { cacheName: SKALL })) || (await caches.match("/")) || Response.error();
  }
}

async function lagretForst(req, cache) {
  const treff = await caches.match(req);
  if (treff) return treff;
  const svar = await fetch(req);
  if (svar.ok && (svar.type === "basic" || svar.type === "cors")) {
    const c = await caches.open(cache);
    await c.put(req, svar.clone());
  }
  return svar;
}

async function nettForst(req, cache) {
  try {
    const svar = await fetch(req);
    if (svar.ok) {
      const c = await caches.open(cache);
      await c.put(req, svar.clone());
    }
    return svar;
  } catch {
    return (await caches.match(req)) || Response.error();
  }
}

// --- Push-varsler -----------------------------------------------------------------

self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { tekst: e.data ? e.data.text() : "" };
  }
  const valg = {
    body: d.tekst || "",
    icon: "/ikoner/ikon-192.png",
    badge: "/ikoner/merke-96.png",
    lang: "nb",
    timestamp: d.tid || Date.now(),
    data: { url: typeof d.url === "string" ? d.url : "/" },
  };
  if (d.tag) {
    valg.tag = d.tag;
    valg.renotify = true;
  }
  e.waitUntil(self.registration.showNotification(d.tittel || "HI4 Faktura", valg));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin);
  if (url.origin !== self.location.origin) return; // bare egne sider
  e.waitUntil(
    (async () => {
      const vinduer = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const vindu = vinduer.find((v) => new URL(v.url).origin === self.location.origin);
      if (vindu) {
        await vindu.focus();
        vindu.postMessage({ type: "NAVIGER", url: url.pathname + url.search });
        return;
      }
      await self.clients.openWindow(url.href);
    })(),
  );
});
