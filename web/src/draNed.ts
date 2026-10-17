// Ark nederst på skjermen (mobil) lukkes ved å dra dem ned, som i iOS og Android: grepet øverst på
// arket viser at det går. Draget kan begynne i toppen av arket (fra), eller hvor som helst i det
// når fra ikke er satt; i lista som ruller (liste), bare når den er rullet helt opp (ellers ruller
// den som før). Arket følger fingeren, og bakgrunnen blekner (--dra i styles.css). Slippes det en
// tredel ned (høyst 150 px), eller med fart nedover, glir det ut og lukkes; ellers glir det
// tilbake. Bare med berøring, og bare når dialogen er et ark (medie).
import { useEffect, useRef, type MutableRefObject, type RefObject } from "react";

type Valg = {
  // Mediespørringen der dialogen er et ark nederst på skjermen.
  medie: string;
  // Der draget kan begynne (CSS-velger); uten: hvor som helst i arket.
  fra?: string;
  // Lista i arket som ruller (CSS-velger): et drag i den teller bare når den er rullet helt opp.
  liste?: string;
};

// Bevegelsen (px) før det avgjøres om fingeren drar arket ned, eller ruller eller trykker.
const TERSKEL = 6;
const UT_MS = 200;
const UT = `transform ${UT_MS}ms ease-in, --dra ${UT_MS}ms ease-in`;
const TILBAKE = "transform .24s cubic-bezier(.2, .8, .2, 1), --dra .24s ease-out";

export function useDraNed(ref: RefObject<HTMLDialogElement | null>, lukk: () => void, valg: Valg) {
  const lukkRef = useRef(lukk);
  const valgRef = useRef(valg);
  const koblet = useRef<{ ark: HTMLDialogElement; fjern: () => void } | null>(null);
  // Etter hver tegning: siste lukk og valg, og hendelsene på dialogen (den kan komme til senere,
  // som når assistenten blir tilgjengelig).
  useEffect(() => {
    lukkRef.current = lukk;
    valgRef.current = valg;
    const ark = ref.current;
    if (koblet.current?.ark === ark) return;
    koblet.current?.fjern();
    koblet.current = ark ? { ark, fjern: kobleTil(ark, lukkRef, valgRef) } : null;
  });
  useEffect(
    () => () => {
      koblet.current?.fjern();
      koblet.current = null;
    },
    [],
  );
}

function kobleTil(ark: HTMLDialogElement, lukk: MutableRefObject<() => void>, valg: MutableRefObject<Valg>) {
  let start: { x: number; y: number } | null = null;
  let rull: HTMLElement | null = null;
  let drar = false;
  let fot = 0; // der fingeren var da arket begynte å følge den
  let spor: { y: number; t: number }[] = [];
  let tid: ReturnType<typeof setTimeout> | undefined;

  const flytt = (dy: number, overgang = "") => {
    ark.style.transition = overgang;
    ark.style.transform = dy > 0 ? `translateY(${dy}px)` : "";
    ark.style.setProperty("--dra", String(Math.min(1, Math.max(0, dy) / Math.max(1, ark.offsetHeight))));
  };
  const nullstill = () => {
    clearTimeout(tid);
    ark.style.removeProperty("transition");
    ark.style.removeProperty("transform");
    ark.style.removeProperty("--dra");
  };
  const tilbake = () => {
    clearTimeout(tid);
    flytt(0, TILBAKE);
    tid = setTimeout(nullstill, 260);
  };

  const ned = (e: TouchEvent) => {
    start = null;
    drar = false;
    const { medie, fra, liste } = valg.current;
    if (e.touches.length !== 1 || !ark.open || !matchMedia(medie).matches) return;
    const mal = e.target instanceof Element ? e.target : null;
    // Bare i dette arket (ikke på bakgrunnen eller i en dialog oppå det), og ikke i tekstfelt.
    if (!mal || mal === ark || mal.closest("dialog") !== ark) return;
    if (mal.closest("textarea, input[type=range], [contenteditable=true]")) return;
    rull = liste ? mal.closest<HTMLElement>(liste) : null;
    if (!rull && fra && !mal.closest(fra)) return;
    const t = e.touches[0]!;
    start = { x: t.clientX, y: t.clientY };
    spor = [];
  };
  const beveg = (e: TouchEvent) => {
    if (!start) return;
    const t = e.touches[0];
    if (!t) return;
    if (!drar) {
      const dy = t.clientY - start.y;
      const dx = t.clientX - start.x;
      const overst = !rull || rull.scrollTop <= 0;
      // Nedover fra toppen: nettleseren skal ikke begynne å rulle eller sprette mens det avgjøres.
      if (dy > 0 && overst && e.cancelable) e.preventDefault();
      if (Math.abs(dy) < TERSKEL && Math.abs(dx) < TERSKEL) return;
      if (!(dy > Math.abs(dx) && overst)) {
        start = null; // rulling eller sidelengs: ikke et drag
        return;
      }
      drar = true;
      fot = t.clientY;
      clearTimeout(tid);
    }
    if (e.cancelable) e.preventDefault();
    spor.push({ y: t.clientY, t: e.timeStamp });
    if (spor.length > 10) spor.shift();
    flytt(t.clientY - fot);
  };
  const slipp = (e: TouchEvent) => {
    if (!start) return;
    start = null;
    if (!drar) return;
    drar = false;
    const dy = Math.max(0, (e.changedTouches[0]?.clientY ?? fot) - fot);
    // Farten nedover de siste 100 ms (px per ms).
    const sist = spor[spor.length - 1];
    const forst = sist && spor.find((p) => sist.t - p.t <= 100);
    const fart = sist && forst && sist.t > forst.t ? (sist.y - forst.y) / (sist.t - forst.t) : 0;
    const h = ark.offsetHeight;
    if (dy > Math.min(150, h / 3) || (fart > 0.45 && dy > 20)) {
      flytt(h + 30, UT);
      clearTimeout(tid);
      tid = setTimeout(() => {
        lukk.current();
        // Lukkes ikke dialogen likevel, kommer arket tilbake.
        tid = setTimeout(() => ark.open && tilbake(), 300);
      }, UT_MS);
    } else tilbake();
  };
  const avbryt = () => {
    if (drar) tilbake();
    start = null;
    drar = false;
  };

  ark.addEventListener("touchstart", ned, { passive: true });
  ark.addEventListener("touchmove", beveg, { passive: false });
  ark.addEventListener("touchend", slipp);
  ark.addEventListener("touchcancel", avbryt);
  // Lukket (dratt ned, X, Esc eller fra koden): neste gang åpnes arket på plass.
  ark.addEventListener("close", nullstill);
  return () => {
    ark.removeEventListener("touchstart", ned);
    ark.removeEventListener("touchmove", beveg);
    ark.removeEventListener("touchend", slipp);
    ark.removeEventListener("touchcancel", avbryt);
    ark.removeEventListener("close", nullstill);
    nullstill();
  };
}
