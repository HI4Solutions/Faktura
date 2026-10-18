// Nettstedet (landingsside/). Måler hvor toppen slutter (--hode), så delene på forsiden og lenkene til
// en del av siden legger seg rett under den, og sender kontaktskjemaet uten at siden lastes på nytt.
// Sideskiftet (arkene som glir over hverandre) gjør nettleseren selv (index.html). Åpnes nettstedet
// fra Hjem-skjermen av en som er logget inn i appen på samme domene, går det rett til appen. Uten
// skriptet virker alt likevel: --hode har en standardverdi i felles.css, og skjemaet sendes som et
// vanlig skjema.
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

  // Åpnet fra Hjem-skjermen (snarveien er appen) mens brukeren er logget inn i appen på dette domenet
  // (den ligger under /app, ved siden av nettstedet; docs/domene.md): gå rett til appen, som en app.
  // Appen husker hvem som er logget inn i localStorage («faktura.innlogget», web/src/applaas.ts). Ligger
  // appen på et annet domene, kan den ikke åpnes inne i snarveien, og nettstedet vises som det er.
  const appLenke = document.querySelector(".top .act a[href]");
  const hjemskjerm = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if (appLenke && hjemskjerm && appLenke.origin === location.origin) {
    let innlogget = false;
    try {
      innlogget = Boolean(localStorage.getItem("faktura.innlogget"));
    } catch {}
    if (innlogget) location.replace(appLenke.href);
  }

  const skjema = document.querySelector("form[data-kontakt]");

  // Kontaktskjemaet (del 7): sendes som JSON, og svaret vises under skjemaet.
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
