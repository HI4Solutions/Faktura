// Lager app-ikonene: symbolet (Modul-K) alene, skalert så kvadratet fyller hele ikonet, med nattblå
// moduler, blå kile og hvite mellomrom, som i logoen. iPhone og Android runder av hjørnene selv.
// Stiene er de samme som i web/src/logoStier.ts og docs/merkevare/admin-konsoll-symbol.svg.
//
// Kjør fra server/ (der sharp ligger): node ../scripts/lag-ikoner.mjs
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sharp = createRequire(path.join(rot, "server/package.json"))("sharp");

const KROPP = "M15.8 4H12A8 8 0 0 0 4 12V36A8 8 0 0 0 12 44H15.8ZM19 4L19 20.8L39.95 5.04A8 8 0 0 0 36 4ZM19 44L19 27.2L39.95 42.96A8 8 0 0 1 36 44Z";
const KILE = "M20.06 24L42.4 7.2A8 8 0 0 1 44 12V36A8 8 0 0 1 42.4 40.8Z";
// Kvadratet går fra 4 til 44 på 48 × 48. Skalert med 1,2 og flyttet 4,8 fyller det hele flaten.
const symbol = `<g transform="translate(-4.8 -4.8) scale(1.2)"><path fill="#0d1530" d="${KROPP}"/><path fill="#2f56d8" d="${KILE}"/></g>`;
// Hvit bunn under hele flaten: ikonet på Hjem-skjermen (iPhone) og de maskerbare ikonene (Android),
// der systemet legger sin egen form over.
const heldekkende = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="#ffffff"/>${symbol}</svg>`;
// Med symbolets egne hjørner og gjennomsiktig utenfor: manifestets vanlige ikoner (installert app på PC).
const avrundet = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="9.6" fill="#ffffff"/>${symbol}</svg>`;

async function png(svg, storrelse, fil, hvitBunn) {
  mkdirSync(path.dirname(fil), { recursive: true });
  let bilde = sharp(Buffer.from(svg), { density: Math.ceil((72 * storrelse) / 48) + 1 }).resize(storrelse, storrelse);
  if (hvitBunn) bilde = bilde.flatten({ background: "#ffffff" });
  await bilde.png({ compressionLevel: 9 }).toFile(fil);
}

const app = path.join(rot, "web/public/ikoner");
const nettsted = path.join(rot, "landingsside/ikoner");
for (const mappe of [app, nettsted]) {
  await png(heldekkende, 180, path.join(mappe, "apple-touch-icon.png"), true);
  await png(avrundet, 192, path.join(mappe, "ikon-192.png"), false);
  await png(avrundet, 512, path.join(mappe, "ikon-512.png"), false);
}
await png(heldekkende, 192, path.join(app, "maskerbar-192.png"), true);
await png(heldekkende, 512, path.join(app, "maskerbar-512.png"), true);

const merkevare = path.join(rot, "docs/merkevare");
writeFileSync(path.join(merkevare, "admin-konsoll-app-ikon.svg"), heldekkende + "\n");
await png(heldekkende, 1024, path.join(merkevare, "admin-konsoll-app-ikon.png"), true);
console.log("Ikonene er laget.");
