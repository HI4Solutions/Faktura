// Det som mangler på en ansatt før lønnen og a-meldingen kan kjøres: fødselsnummer, kontonummer,
// lønn, og med Lønn også skattekortet og yrkeskoden (a-meldingen avvises uten). Med feltet i
// ansattskjemaet det fylles ut i (id-en «felt-…»), så «Mangler»-lista kan hoppe dit.
import { iDag } from "./format";

export type Manglende = { felt: string; navn: string };

type Ansattfelt = {
  arbeidstaker: boolean;
  aktiv: boolean;
  ansatt_til: string | null;
  har_fnr: boolean;
  kontonr: string | null;
  lonnstype: "maaned" | "time";
  maanedslonn: number | null;
  timelonn: number | null;
  skattekort: string | null;
  yrkeskode: string | null;
};

export function mangler(a: Ansattfelt, valg: { lonn: boolean }): Manglende[] {
  // De som ikke er ansatt (en rolle for dem som ikke er ansatt) og de som har sluttet, mangler ikke noe.
  if (a.arbeidstaker === false || !a.aktiv || (a.ansatt_til && a.ansatt_til < iDag())) return [];
  const m: Manglende[] = [];
  if (!a.har_fnr) m.push({ felt: "fnr", navn: "fødselsnummer" });
  if (!a.kontonr) m.push({ felt: "kontonr", navn: "kontonummer" });
  if (a.lonnstype === "maaned" ? a.maanedslonn == null : a.timelonn == null) m.push({ felt: a.lonnstype === "maaned" ? "maanedslonn" : "timelonn", navn: "lønn" });
  if (valg.lonn) {
    // Uten fødselsnummer kan ikke skattekortet hentes; det er nok å si at nummeret mangler.
    if (a.har_fnr && !a.skattekort) m.push({ felt: "skattekort", navn: "skattekort" });
    if (!a.yrkeskode) m.push({ felt: "yrkeskode", navn: "yrkeskode" });
  }
  return m;
}

export const manglerTekst = (m: Manglende[]) => {
  const navn = m.map((x) => x.navn);
  return navn.length > 1 ? `${navn.slice(0, -1).join(", ")} og ${navn.at(-1)}` : (navn[0] ?? "");
};

// Hopper til feltet i skjemaet (rulles fram og får fokus).
export function tilFelt(felt: string) {
  const el = document.getElementById(`felt-${felt}`);
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  setTimeout(() => (el as HTMLElement).focus({ preventScroll: true }), 250);
}
