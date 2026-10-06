// Logoer skaleres ned før de havner i PDF-en. Et stort bilde (f.eks. 4000 px PNG
// med gjennomsiktighet) gjør PDF-en tung og får Utforsker/Acrobat til å henge når
// de lager forhåndsvisning. Logoen vises høyst 150 × 50 pt; 600 × 200 px holder
// også for utskrift.
import sharp from "sharp";

export async function normaliserLogo(bytes: Uint8Array): Promise<Uint8Array> {
  const bilde = sharp(bytes, { failOn: "error", limitInputPixels: 50_000_000 }).rotate();
  const { hasAlpha } = await bilde.metadata();
  const skalert = bilde.resize({ width: 600, height: 200, fit: "inside", withoutEnlargement: true }).toColourspace("srgb");
  const ut = hasAlpha ? await skalert.png({ compressionLevel: 9 }).toBuffer() : await skalert.jpeg({ quality: 90, mozjpeg: true }).toBuffer();
  return new Uint8Array(ut);
}

export const erPng = (b: Uint8Array) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
