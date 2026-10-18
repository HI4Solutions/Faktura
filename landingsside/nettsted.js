// Nettstedet (landingsside/). Måler hvor toppen slutter (--hode), så delene på forsiden og lenkene til
// en del av siden legger seg rett under den, og sender kontaktskjemaet uten at siden lastes på nytt.
// Sideskiftet (arkene som glir over hverandre) gjør nettleseren selv (index.html). Åpnes nettstedet
// fra en snarvei på Hjem-skjermen mens appen ligger på en annen adresse, vises en side om hvordan
// appen legges på Hjem-skjermen. Uten skriptet virker alt likevel: --hode har en standardverdi i
// felles.css, og skjemaet sendes som et vanlig skjema.
(() => {
  "use strict";
  const rot = document.documentElement;
  const hode = document.querySelector("header.top");
  // Fra toppen av skjermen til bunnen av toppen: høyden på toppen, og fra Hjem-skjermen også
  // statuslinjen over den (felles.css).
  const maal = () => {
    if (hode) rot.style.setProperty("--hode", `${Math.round(hode.getBoundingClientRect().bottom)}px`);
  };
  maal();
  if (hode && window.ResizeObserver) new ResizeObserver(maal).observe(hode);
  else window.addEventListener("resize", maal);

  // Åpnet fra Hjem-skjermen som app, mens appen ligger på en annen adresse (app.<domene>): snarveien
  // ble lagt til fra nettstedet, eller den er fra da appen lå på dette domenet. Appen er et annet
  // nettsted og kan ikke åpnes inne i snarveien (iPhone åpner den som en ny side), så siden viser hvor
  // appen ligger og hvordan den legges på Hjem-skjermen. Lenkene til appen åpnes i nettleseren, der
  // den kan legges til. Ligger appen på dette domenet (før appen har flyttet), vises ingenting.
  const appLenke = document.querySelector(".top .act a[href]");
  const app = appLenke ? new URL(appLenke.href) : null;
  const hjemskjerm = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if (hode && app && hjemskjerm && app.origin !== location.origin) {
    for (const a of document.querySelectorAll("a[href]")) {
      if (a.origin === app.origin) {
        a.target = "_blank";
        a.rel = "noopener";
      }
    }
    let vist = false;
    try {
      vist = sessionStorage.getItem("nettsted.vis") === "1";
    } catch {}
    if (!vist) {
      const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
      const steg = ios
        ? ["Trykk «Åpne appen». Den åpnes i Safari.", "Trykk på Del-knappen og velg «Legg til på Hjem-skjerm».", "Slett denne snarveien: hold fingeren på ikonet og velg å fjerne det."]
        : ["Trykk «Åpne appen». Den åpnes i nettleseren.", "Åpne menyen i nettleseren og velg «Installer app» eller «Legg til på startskjermen».", "Fjern denne snarveien: hold fingeren på ikonet og velg å fjerne det."];
      const side = document.createElement("main");
      side.className = "ark dok app-flyttet";
      side.id = "app-flyttet";
      side.tabIndex = -1;
      side.setAttribute("aria-labelledby", "app-flyttet-h");
      side.innerHTML =
        '<span class="sidetall" aria-hidden="true">AK-1 · Hjem-skjerm</span><div class="inn">' +
        '<div class="delband"><span class="nr">APPEN</span><h1 id="app-flyttet-h"></h1></div>' +
        '<p class="ingress">Denne snarveien på Hjem-skjermen åpner nettstedet. Legg appen på Hjem-skjermen i stedet, så logger du inn og jobber inne i appen.</p>' +
        '<ol class="steg"></ol>' +
        '<div class="knapper"><a class="btn pri" target="_blank" rel="noopener">Åpne appen →</a><button class="btn txt" type="button">Vis nettstedet</button></div></div>';
      side.querySelector("h1").textContent = `Appen ligger på ${app.host}`;
      const liste = side.querySelector(".steg");
      for (const s of steg) liste.append(Object.assign(document.createElement("li"), { textContent: s }));
      side.querySelector("a.btn").href = `${app.origin}/`;
      const hopp = document.querySelector(".hopp");
      const hoppTil = hopp ? hopp.getAttribute("href") : null;
      if (hopp) hopp.setAttribute("href", "#app-flyttet");
      side.querySelector("button").addEventListener("click", () => {
        try {
          sessionStorage.setItem("nettsted.vis", "1");
        } catch {}
        rot.classList.remove("app-andre-sted");
        side.remove();
        if (hopp && hoppTil) hopp.setAttribute("href", hoppTil);
        maal();
        window.scrollTo(0, 0);
      });
      hode.after(side);
      rot.classList.add("app-andre-sted");
      maal();
    }
  }

  const skjema = document.querySelector("form[data-kontakt]");

  // Kontaktskjemaet (del 8): sendes som JSON, og svaret vises under skjemaet.
  if (skjema && window.fetch) {
    const sendt = document.getElementById("kontakt-sendt");
    const feil = document.getElementById("kontakt-feil");
    const grunn = feil ? feil.querySelector(".grunn") : null;
    const knapp = skjema.querySelector('button[type="submit"]');
    const punktum = (s) => (/[.!?]$/.test(s) ? s : `${s}.`);
    const vis = (el) => {
      for (const k of [sendt, feil]) if (k) k.classList.toggle("vis", k === el);
      if (el) el.focus();
    };
    skjema.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (knapp.disabled) return;
      const tekst = knapp.textContent;
      knapp.disabled = true;
      knapp.textContent = "Sender …";
      try {
        const svar = await fetch(skjema.action, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(Object.fromEntries(new FormData(skjema))),
        });
        if (svar.ok) {
          skjema.reset();
          vis(sendt);
        } else {
          const data = await svar.json().catch(() => null);
          if (grunn) grunn.textContent = punktum((data && data.error) || "Prøv igjen om litt");
          vis(feil);
        }
      } catch {
        if (grunn) grunn.textContent = "Fikk ikke kontakt med oss. Sjekk nettforbindelsen og prøv igjen.";
        vis(feil);
      } finally {
        knapp.disabled = false;
        knapp.textContent = tekst;
      }
    });
  }
})();
