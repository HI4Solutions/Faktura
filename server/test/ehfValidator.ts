// Validerer EHF-filer mot de offisielle reglene (EN 16931 og PEPPOL BIS Billing 3.0 med
// norske regler). Schematron-filene kompileres til XSLT og videre til SaxonJS-format én
// gang, og mellomlagres så neste kjøring går raskt.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import SaxonJS from "saxon-js";

const her = path.dirname(fileURLToPath(import.meta.url));
const regler = path.join(her, "ehf-regler");
const xslt3 = createRequire(import.meta.url).resolve("xslt3/xslt3.js");
const REGELSETT = ["CEN-EN16931-UBL", "PEPPOL-EN16931-UBL"];

export interface Funn {
  flagg: string; // fatal eller warning
  id: string;
  tekst: string;
}

// Den store regelfila trenger mer stakk enn standard når den kompileres (under 8 MB).
const kjor = (...arg: string[]) => execFileSync(process.execPath, ["--stack-size=7000", xslt3, ...arg], { stdio: "pipe" });

export function lagValidator(): (xml: string) => Funn[] {
  const hash = createHash("sha256");
  for (const fil of fs.readdirSync(regler).sort()) hash.update(fil).update(fs.readFileSync(path.join(regler, fil)));
  const mappe = path.join(her, "..", "node_modules", ".cache", "ehf-regler", hash.digest("hex").slice(0, 16));
  fs.mkdirSync(mappe, { recursive: true });

  const stilark = REGELSETT.map((navn) => {
    const sef = path.join(mappe, `${navn}.sef.json`);
    if (!fs.existsSync(sef)) {
      const steg1 = path.join(mappe, `${navn}-1.sch`);
      const steg2 = path.join(mappe, `${navn}-2.sch`);
      const xsl = path.join(mappe, `${navn}.xsl`);
      kjor(`-xsl:${path.join(regler, "iso_dsdl_include.xsl")}`, `-s:${path.join(regler, `${navn}.sch`)}`, `-o:${steg1}`);
      kjor(`-xsl:${path.join(regler, "iso_abstract_expand.xsl")}`, `-s:${steg1}`, `-o:${steg2}`);
      kjor(`-xsl:${path.join(regler, "iso_svrl_for_xslt2.xsl")}`, `-s:${steg2}`, `-o:${xsl}`);
      kjor(`-xsl:${xsl}`, `-export:${sef}.tmp`, "-nogo");
      fs.renameSync(`${sef}.tmp`, sef);
    }
    return sef;
  });

  return (xml: string) => {
    const funn: Funn[] = [];
    for (const sef of stilark) {
      const svrl = (SaxonJS.transform({ stylesheetFileName: sef, sourceText: xml, destination: "serialized" }, "sync") as any).principalResult as string;
      for (const m of svrl.matchAll(/<svrl:failed-assert\b([^>]*)>[\s\S]*?<svrl:text>([\s\S]*?)<\/svrl:text>/g)) {
        funn.push({
          flagg: /flag="([^"]*)"/.exec(m[1]!)?.[1] ?? "fatal",
          id: /id="([^"]*)"/.exec(m[1]!)?.[1] ?? "?",
          tekst: m[2]!.replace(/\s+/g, " ").trim(),
        });
      }
    }
    return funn;
  };
}
