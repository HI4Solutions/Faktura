// Nettstedet (landingsside/). Måler høyden på toppen (--hode), så delene på forsiden og lenkene til
// en del av siden legger seg rett under den, og sender kontaktskjemaet uten at siden lastes på nytt.
// Sideskiftet (arkene som glir over hverandre) gjør nettleseren selv (index.html). Uten skriptet
// virker alt likevel: --hode har en standardverdi i felles.css, og skjemaet sendes som et vanlig
// skjema.
(() => {
  "use strict";
  const rot = document.documentElement;
  const hode = document.querySelector("header.top");
  const maal = () => {
    if (hode) rot.style.setProperty("--hode", `${Math.round(hode.getBoundingClientRect().height)}px`);
  };
  maal();
  if (hode && window.ResizeObserver) new ResizeObserver(maal).observe(hode);
  else window.addEventListener("resize", maal);

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
