import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Lokalt: API-et på :8080 og Firebase-konfig fra VITE_FIREBASE_* (se src/firebase.ts).
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://localhost:8080" } },
});
