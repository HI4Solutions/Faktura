// Nettstedet (landingsside/). Toppen står fast øverst, og på forsiden legger hver del (et ark) seg
// oppå den forrige når man ruller, som når man blar om i en blokk. Skriptet måler toppen og arkene,
// så hvert ark blir liggende der hele arket er lest før det neste dekker det, og det sender
// kontaktskjemaet uten at siden lastes på nytt. Uten skriptet ligger arkene under hverandre, og
// skjemaet sendes som et vanlig skjema.
(() => {
  "use strict";
  const rot = document.documentElement;
  const hode = document.querySelector("header.top");
  const bunke = document.querySelector(".bunke");
  const ark = bunke ? Array.from(bunke.children).filter((e) => e.classList.contains("ark")) : [];
  const LUFT = 16; // mellom toppen og arket som ligger øverst (--luft i felles.css)
  const rolig = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };

  // Høyden på det minste vinduet (100svh). Den endrer seg ikke når adresselinjen på mobilen kommer
  // og går, så arkene står stille mens man ruller.
  const vindu = document.createElement("div");
  vindu.setAttribute("aria-hidden", "true");
  vindu.style.cssText = "position:fixed;left:0;top:0;width:0;height:100vh;height:100svh;visibility:hidden;pointer-events:none";
  document.body.appendChild(vindu);

  let hodeHoyde = 0;
  let stabel = false;
  let blad = []; // der hvert ark blir liggende (avstand fra toppen av vinduet)
  let hjem = []; // der hvert ark hører hjemme på siden, som om det ikke lå fast

  // Plassene arkene hører hjemme: rett etter hverandre i bunken. Et ark som ligger fast, flytter
  // ikke de andre, så de regnes ut fra bunken, høydene og marginene.
  function hjemmeAlle() {
    const b = getComputedStyle(bunke);
    let y = bunke.getBoundingClientRect().top + window.scrollY + parseFloat(b.borderTopWidth) + parseFloat(b.paddingTop);
    let forrige = 0;
    return ark.map((a, i) => {
      const s = getComputedStyle(a);
      y += i === 0 ? parseFloat(s.marginTop) : Math.max(forrige, parseFloat(s.marginTop)); // marginene slås sammen
      const topp = y;
      y += a.offsetHeight;
      forrige = parseFloat(s.marginBottom);
      return topp;
    });
  }

  function maal() {
    hodeHoyde = hode ? Math.round(hode.getBoundingClientRect().height) : 0;
    rot.style.setProperty("--hode", `${hodeHoyde}px`);
    if (!stabel) return;
    const h = vindu.offsetHeight || window.innerHeight;
    // Et lavt ark legger seg rett under toppen. Et ark som er høyere enn vinduet, ruller til
    // bunnen av det er synlig, og blir liggende der.
    blad = ark.map((a) => Math.round(Math.min(hodeHoyde + LUFT, h - a.offsetHeight - LUFT)));
    ark.forEach((a, i) => a.style.setProperty("--blad", `${blad[i]}px`));
    hjem = hjemmeAlle();
    overst = -2;
    begrav();
  }

  // Bare arket øverst i bunken (det siste som har nådd plassen sin) og arkene etter det vises.
  // Arkene under det blekner bort, så et høyere ark under ikke stikker fram.
  let overst = -2;
  function begrav() {
    if (!stabel) return;
    const y = window.scrollY;
    let s = -1;
    for (let i = 0; i < ark.length; i++) if (hjem[i] - y <= blad[i] + 0.5) s = i;
    if (s === overst) return;
    overst = s;
    ark.forEach((a, i) => a.classList.toggle("begravet", i < s));
  }

  let ramme = 0;
  const planlegg = () => {
    if (!ramme) ramme = requestAnimationFrame(() => ((ramme = 0), maal()));
  };

  function settStabel() {
    stabel = ark.length > 1 && !rolig.matches;
    rot.classList.toggle("stabel", stabel);
    if (!stabel)
      for (const a of ark) {
        a.style.removeProperty("--blad");
        a.classList.remove("begravet");
      }
    maal();
  }

  settStabel();
  window.addEventListener("resize", planlegg);
  let rulle = 0;
  window.addEventListener("scroll", () => {
    if (stabel && !rulle) rulle = requestAnimationFrame(() => ((rulle = 0), begrav()));
  }, { passive: true });
  window.addEventListener("load", planlegg);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(planlegg);
  if (rolig.addEventListener) rolig.addEventListener("change", settStabel);
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(planlegg);
    [hode, vindu, ...ark].forEach((e) => e && ro.observe(e));
  }

  // Lenker til en del av forsiden. Et ark som ligger under et annet, står for nettleseren der det
  // ligger nå, ikke der det hører hjemme, så nettleseren ville ikke rullet tilbake til det. Vi
  // ruller dit selv.
  function hjemme(el) {
    hjem = hjemmeAlle();
    const i = ark.findIndex((a) => a.contains(el));
    if (i < 0) return el.getBoundingClientRect().top + window.scrollY; // ikke i et ark (main)
    return hjem[i] + el.getBoundingClientRect().top - ark[i].getBoundingClientRect().top;
  }
  function gaaTil(el, myk) {
    window.scrollTo({ top: Math.max(0, hjemme(el) - hodeHoyde - LUFT), behavior: myk ? "smooth" : "auto" });
    // Fokus dit lenken peker, som når nettleseren følger den selv.
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
    el.focus({ preventScroll: true });
  }
  const maalFor = (hash) => {
    if (!bunke || hash.length < 2) return null;
    let id;
    try {
      id = decodeURIComponent(hash.slice(1));
    } catch {
      return null;
    }
    const el = document.getElementById(id);
    return el && bunke.contains(el) ? el : null;
  };
  document.addEventListener("click", (e) => {
    if (!stabel || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (!a) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || url.pathname !== location.pathname || url.search !== location.search) return;
    const el = maalFor(url.hash);
    if (!el) return;
    e.preventDefault();
    if (location.hash !== url.hash) history.pushState(null, "", url.hash);
    gaaTil(el, true);
  });
  // Adressen endret for hånd (eller tilbake og fram i historikken).
  window.addEventListener("hashchange", () => {
    const el = stabel && maalFor(location.hash);
    if (el) gaaTil(el, false);
  });

  // Kontaktskjemaet (del 8): sendes som JSON, og svaret vises under skjemaet.
  const skjema = document.querySelector("form[data-kontakt]");
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
