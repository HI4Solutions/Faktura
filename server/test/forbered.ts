// Kjøres én gang før testene (vitest.config.ts): kompilerer EHF-reglene til mellomlageret
// (ehfValidator.ts). Ellers kompilerer testfilene som validerer EHF, dem samtidig i hver sin
// prosess når mellomlageret er tomt (som på en ny maskin i GitHub Actions), og det tar så mye
// maskinkraft at andre tester kan gå ut på tid.
import { lagValidator } from "./ehfValidator.js";

export default function forbered() {
  lagValidator();
}
