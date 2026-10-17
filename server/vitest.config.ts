import { defineConfig } from "vitest/config";

// EHF-reglene kompileres før testene starter (test/forbered.ts).
export default defineConfig({
  test: { globalSetup: ["test/forbered.ts"] },
});
