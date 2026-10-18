// Flere domener (docs/domene.md): appen svarer på hoveddomenet og de andre domenene, og det brukeren
// gjør i nettleseren (passkeys, tilbakeadressene fra banken, Google og Altinn) følger adressen
// brukeren er på. Passkeys per domene testes i passkey.test.ts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Context } from "hono";
import { config } from "../src/config.js";
import { lagApi } from "../src/api.js";
import { appUrler, appUrlFra } from "../src/appadresse.js";
import { tilbakeUrl } from "../src/bank.js";
import { lesState, signerState } from "../src/googleDisk.js";
import { systemdefinisjon } from "../src/altinn.js";

const c = config as any;
const HOVED = "https://adminkonsoll.test";
const ANDRE = "https://faktura.gammel.test";

// En forespørsel med de hodene nettleseren sender.
const fra = (hoder: Record<string, string>) => ({ req: { header: (n: string) => hoder[n.toLowerCase()] } }) as unknown as Context;

describe("appens adresser", () => {
  const for_ = { appUrl: c.appUrl, andreAppUrler: c.andreAppUrler, gamleAppUrler: c.gamleAppUrler, nettstedUrl: c.nettstedUrl, googleClientSecret: c.googleClientSecret };
  beforeEach(() => Object.assign(c, { appUrl: HOVED, andreAppUrler: [ANDRE], gamleAppUrler: [], nettstedUrl: undefined, googleClientSecret: "hemmelig" }));
  afterEach(() => Object.assign(c, for_));

  it("hoveddomenet først, så de andre og de gamle, uten dubletter", () => {
    expect(appUrler()).toEqual([HOVED, ANDRE]);
    c.gamleAppUrler = ["https://eldst.test", ANDRE];
    expect(appUrler()).toEqual([HOVED, ANDRE, "https://eldst.test"]);
  });

  it("nettstedets domene er med, for der ligger appen under /app", () => {
    const NETTSTED = "https://nettsted.test";
    c.nettstedUrl = NETTSTED;
    expect(appUrler()).toEqual([HOVED, ANDRE, NETTSTED]);
    expect(appUrlFra(fra({ origin: NETTSTED }))).toBe(NETTSTED);
    expect(appUrlFra(fra({ referer: `${NETTSTED}/app/innstillinger?fane=bank` }))).toBe(NETTSTED);
    expect(tilbakeUrl(appUrlFra(fra({ origin: NETTSTED })))).toBe(`${NETTSTED}/bank/tilbake`);
    expect(systemdefinisjon().allowedRedirectUrls).toContain(`${NETTSTED}/skattekort/godkjent`);
    // Før appen har flyttet er nettstedets domene hoveddomenet: ingen dublett. En ugyldig adresse
    // tas ikke med.
    c.nettstedUrl = `${HOVED}/`;
    expect(appUrler()).toEqual([HOVED, ANDRE]);
    c.nettstedUrl = "ikke en adresse";
    expect(appUrler()).toEqual([HOVED, ANDRE]);
  });

  it("adressen brukeren er på: Origin, ellers Referer, ellers hoveddomenet", () => {
    expect(appUrlFra(fra({ origin: ANDRE }))).toBe(ANDRE);
    expect(appUrlFra(fra({ referer: `${ANDRE}/innstillinger?fane=bank` }))).toBe(ANDRE);
    expect(appUrlFra(fra({ origin: HOVED, referer: `${ANDRE}/x` }))).toBe(HOVED);
    expect(appUrlFra(fra({}))).toBe(HOVED);
    expect(appUrlFra(undefined)).toBe(HOVED);
    // En annen nettside (eller noe som ligner) får aldri tilbakeadressene til å peke dit.
    expect(appUrlFra(fra({ origin: "https://angriper.test" }))).toBe(HOVED);
    expect(appUrlFra(fra({ origin: `${ANDRE}.angriper.test` }))).toBe(HOVED);
    expect(appUrlFra(fra({ referer: "ikke en adresse" }))).toBe(HOVED);
    expect(appUrlFra(fra({ origin: "http://faktura.gammel.test" }))).toBe(HOVED);
  });

  it("banken sender brukeren tilbake til domenet brukeren startet fra", () => {
    expect(tilbakeUrl(appUrlFra(fra({ origin: ANDRE })))).toBe(`${ANDRE}/bank/tilbake`);
    expect(tilbakeUrl()).toBe(`${HOVED}/bank/tilbake`);
  });

  it("Google Disk: domenet ligger i den signerte staten, og bare appens egne godtas", () => {
    expect(lesState(signerState({ bruker: "b1", adresse: ANDRE }))).toEqual({ bruker: "b1", adresse: ANDRE });
    expect(lesState(signerState({ bruker: "b1", adresse: "https://angriper.test" }))).toEqual({ bruker: "b1", adresse: HOVED });
    expect(lesState(signerState({ bruker: "b1" }))).toEqual({ bruker: "b1", adresse: HOVED });
  });

  it("Altinn: systemregisteret får tilbakeadressen på alle domenene", () => {
    expect(systemdefinisjon().allowedRedirectUrls).toEqual([`${HOVED}/skattekort/godkjent`, `${ANDRE}/skattekort/godkjent`]);
  });

  it("appen spør etter hoveddomenet, og om domenet den er på er et den er flyttet fra", async () => {
    c.gamleAppUrler = [ANDRE];
    const r = await lagApi().request("/api/offentlig/adresse");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ hovedadresse: HOVED, gamle: [ANDRE] });
  });
});
