import { initializeApp, type FirebaseOptions } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";

// Firebase Hosting serverer prosjektets web-konfigurasjon på /__/firebase/init.json,
// så ingen nøkler trenger å bygges inn. Lokalt brukes VITE_FIREBASE_*.
async function hentKonfig(): Promise<FirebaseOptions> {
  if (import.meta.env.VITE_FIREBASE_API_KEY) {
    return {
      apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
      authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
      projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
      appId: import.meta.env.VITE_FIREBASE_APP_ID,
    };
  }
  const r = await fetch("/__/firebase/init.json");
  if (!r.ok) throw new Error("Fant ikke Firebase-konfigurasjonen");
  return r.json();
}

let auth: Promise<Auth> | undefined;

export function hentAuth(): Promise<Auth> {
  auth ??= hentKonfig().then((k) => {
    const a = getAuth(initializeApp(k));
    a.languageCode = "no";
    return a;
  });
  return auth;
}
