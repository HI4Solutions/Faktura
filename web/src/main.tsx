import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { startPwa } from "./pwa";
import { startTema } from "./tema";
import { leggTilAppSti } from "./appsti";

// På nettstedets domene ligger appen under /app (appsti.ts): adressen får stien før ruteren leser den.
leggTilAppSti();
startTema();
startPwa();

// Testflaten (appen på app.test.adminkonsoll.no, docs/miljoer.md) merkes, så den ikke forveksles med
// produksjon: «test.» som eget ledd i adressen, eller testprosjektets sider i Firebase Hosting.
if (/(^|\.)test\.|-test(-app)?\.(web\.app|firebaseapp\.com)$/.test(location.hostname)) {
  document.documentElement.dataset.miljo = "test";
  document.title = `Test · ${document.title}`;
}

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
