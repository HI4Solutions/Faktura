import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { startPwa } from "./pwa";
import { startTema } from "./tema";

startTema();
startPwa();

// Testflaten (test.adminkonsoll.no, docs/miljoer.md) merkes, så den ikke forveksles med produksjon.
if (/^test\.|-test\.(web\.app|firebaseapp\.com)$/.test(location.hostname)) {
  document.documentElement.dataset.miljo = "test";
  document.title = `Test · ${document.title}`;
}

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
