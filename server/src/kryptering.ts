// Kryptering med Cloud KMS. API-et kan bare kryptere; workeren kan også dekryptere.
// Byttes ut i tester med settKryptering.
import { KeyManagementServiceClient } from "@google-cloud/kms";
import { config } from "./config.js";

let kms: KeyManagementServiceClient | undefined;

export let krypter = async (tekst: string): Promise<Buffer> => {
  kms ??= new KeyManagementServiceClient();
  const [r] = await kms.encrypt({ name: config.kmsNokkel, plaintext: Buffer.from(tekst) });
  return Buffer.from(r.ciphertext as Uint8Array);
};

export let dekrypter = async (data: Buffer): Promise<string> => {
  kms ??= new KeyManagementServiceClient();
  const [r] = await kms.decrypt({ name: config.kmsNokkel, ciphertext: data });
  return Buffer.from(r.plaintext as Uint8Array).toString();
};

export function settKryptering(k: typeof krypter, d: typeof dekrypter) {
  krypter = k;
  dekrypter = d;
}
