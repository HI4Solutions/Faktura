/* Appen lå på adminkonsoll.no før den fikk sitt eget domene (app.adminkonsoll.no), og nettlesere
 * som brukte den der, har appens service worker. Når de ser etter en ny versjon, får de denne: den
 * tømmer appens lagrede filer og fjerner seg selv, så nettstedet vises som det er, og varslene
 * kommer fra appen på det nye domenet. Den registreres aldri av nettstedet selv (docs/domene.md).
 */
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      for (const navn of await caches.keys()) await caches.delete(navn);
      await self.registration.unregister();
    })(),
  );
});
