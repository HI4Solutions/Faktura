import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const her = fileURLToPath(new URL(".", import.meta.url));

function filerI(mappe: string, prefiks = ""): string[] {
  return readdirSync(mappe).flatMap((navn) => {
    const sti = join(mappe, navn);
    return statSync(sti).isDirectory() ? filerI(sti, `${prefiks}${navn}/`) : [`${prefiks}${navn}`];
  });
}

// Lager /sw.js fra malen sw.js: versjonen (hash av bygget) og app-skallet settes inn,
// så en ny utrulling gir en ny service worker som rydder bort det gamle.
function serviceWorker(): Plugin {
  return {
    name: "faktura-service-worker",
    apply: "build",
    enforce: "post",
    generateBundle(_, bundle) {
      const offentlige = filerI(join(her, "public"));
      const bygget = Object.keys(bundle).filter((f) => f !== "index.html" && !f.endsWith(".map"));
      const hash = createHash("sha256");
      for (const [navn, del] of Object.entries(bundle).sort(([a], [b]) => a.localeCompare(b))) {
        hash.update(navn).update(del.type === "chunk" ? del.code : del.source);
      }
      for (const f of offentlige.sort()) hash.update(f).update(readFileSync(join(her, "public", f)));
      const filer = ["/", ...offentlige.map((f) => `/${f}`), ...bygget.map((f) => `/${f}`)];
      const kilde = readFileSync(join(her, "sw.js"), "utf8")
        .replace("__VERSJON__", hash.digest("hex").slice(0, 12))
        .replace("__FILER__", JSON.stringify(filer));
      this.emitFile({ type: "asset", fileName: "sw.js", source: kilde });
    },
  };
}

// Lokalt: API-et på :8080 og Firebase-konfig fra VITE_FIREBASE_* (se src/firebase.ts).
export default defineConfig({
  plugins: [react(), serviceWorker()],
  server: { proxy: { "/api": "http://localhost:8080" } },
});
