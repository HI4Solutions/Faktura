// AI-assistenten: knappen nederst til høyre på alle sider. Trykk på den, og velg å snakke
// eller skrive. Tale skrives ned i feltet først, så du ser hva som ble hørt (og kan rette
// det) før du sender. Så tolker Gemini kommandoen. Spørsmål («har Kari betalt?», «hvem jobber
// i dag?») besvares, og det som endrer noe (sende en faktura, registrere en betaling, melde
// fravær, sette inn en vikar, føre eller godkjenne timer) vises som forslag du bekrefter med
// ett trykk. Forslagene utføres med de vanlige rutene i API-et, med dine tilganger.
// Hva assistenten kan, følger brukeren (GET /ai/assistent/status): fakturaene for dem som har
// tilgang til dem, og personalet når personalmodulen er slått på, også for de ansatte.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, hent, sendLyd } from "./api";
import { dataEndret, Feil, useData } from "./felles";
import { kanTaOpp, useOpptak, type AiUtkast } from "./ai";
import { IkonGnist, IkonLukk, IkonMikrofon, IkonTastatur } from "./ikoner";
import { useKonto } from "./konto";
import { mandag } from "./uke";

type FForslag =
  | { type: "ny_faktura"; tekst: string; knapp: string; send: boolean; gebyr: boolean; utkast: AiUtkast }
  | { type: "send_utkast"; tekst: string; knapp: string; faktura_id: string }
  | { type: "send_igjen"; tekst: string; knapp: string; faktura_id: string; fakturanummer: number }
  | { type: "betaling"; tekst: string; knapp: string; faktura_id: string; fakturanummer: number; belop: number; dato: string }
  | { type: "purring"; tekst: string; knapp: string; faktura_id: string; fakturanummer: number; purring: "paaminnelse" | "inkassovarsel" };
// Personal (server/src/aiPersonal.ts). ansatt_id null: brukeren selv.
type PForslag =
  | {
      type: "fravaer";
      tekst: string;
      knapp: string;
      ansatt_id: string | null;
      fravaerstype: "syk" | "sykt_barn" | "ferie" | "permisjon" | "kurs" | "annet";
      fra: string;
      til: string;
      notat: string | null;
      vikar_id: string | null; // vikaren for vaktene i perioden
      faste: string[]; // faste arbeidsdager uten vakt, som også får vikar
    }
  | { type: "vikar"; tekst: string; knapp: string; vakt_id: string | null; fast: { ansatt_id: string; dato: string } | null; vikar_id: string }
  | { type: "ny_vakt"; tekst: string; knapp: string; ansatt_id: string | null; dato: string; fra: string; til: string; pause_min: number; oppgave: string | null; notat: string | null }
  | { type: "publiser"; tekst: string; knapp: string; fra: string; til: string }
  | { type: "ta_vakt"; tekst: string; knapp: string; vakt_id: string }
  | { type: "plassering"; tekst: string; knapp: string; plasser: { dato: string; fase_id: string; oppgave_id: string; ansatt_id: string }[] }
  | { type: "rullering"; tekst: string; knapp: string; fra: string; til: string }
  | {
      type: "timer";
      tekst: string;
      knapp: string;
      ansatt_id: string | null;
      dato: string;
      fra: string | null;
      til: string | null;
      pause_min: number;
      timer: number | null;
      beskrivelse: string | null;
      vakt_id: string | null;
    }
  | { type: "lever_timer"; tekst: string; knapp: string; ansatt_id: string | null; fra: string; til: string }
  | { type: "godkjenn_timer"; tekst: string; knapp: string; ider: string[]; godkjent: boolean; grunn: string | null }
  | { type: "overforing"; tekst: string; knapp: string; ansatt_id: string | null; dager: number; begrunnelse: string | null; godkjent: boolean }
  | { type: "svar_overforing"; tekst: string; knapp: string; id: string; godkjent: boolean; svar: string | null };
type Forslag = FForslag | PForslag;
type Lenke = { tekst: string; til: string };
type Svar = { tekst: string; forslag: Forslag[]; lenker: Lenke[]; gaa_til: string | null; utkast: AiUtkast | null };
type Utfort = { melding: string; lenke?: Lenke; advarsel?: string };
type Utfall = { status: "venter" | "utforer" | "ferdig" | "feil" | "avvist"; melding?: string; lenke?: Lenke; advarsel?: string };
type Melding = {
  id: number;
  rolle: "bruker" | "assistent";
  tekst: string;
  feil?: boolean;
  forslag?: { f: Forslag; u: Utfall }[];
  lenker?: Lenke[];
  utkast?: AiUtkast | null;
};
// Det assistenten kan for brukeren (personal: leder er eier og administrator, se også regnskap).
type Status = {
  tilgjengelig: boolean;
  faktura: boolean;
  personal: { leder: boolean; se: boolean; ansatt: boolean; vaktplan: boolean; tavle: boolean } | null;
};

const tid = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const eller = (x: string[]) => (x.length < 2 ? (x[0] ?? "") : `${x.slice(0, -1).join(", ")} eller ${x.at(-1)}`);
const antall = (n: number, en: string, flere: string) => `${n} ${n === 1 ? en : flere}`;

// Eksemplene og forklaringen følger det brukeren kan gjøre med assistenten.
function veiledning(s: Status): { si: string[]; eksempler: string[]; bekreft: string } {
  const p = s.personal;
  const si: string[] = [];
  const eksempler: string[] = [];
  if (s.faktura) {
    si.push("Send faktura til Kari Hansen for husleie oktober", "Har Fjordline betalt?");
    eksempler.push("Hvem skylder oss penger?", "Har det kommet noen betalinger?");
    if (!p) {
      si.push("Registrer betaling på faktura 1043");
      eksempler.push("Send purring på alle forfalte", "Vis utkastene");
    }
  }
  if (p) {
    const ps: string[] = [];
    const pe: string[] = [];
    if (p.leder) {
      ps.push(p.vaktplan ? "Kari er syk i dag, Per tar vaktene" : "Før 7,5 timer for Kari i går");
      if (p.vaktplan) ps.push(p.tavle ? "Sett Ola på kassa i formiddag" : "Legg inn vakt for Ola fredag 08–16");
      ps.push("Godkjenn timene for forrige uke");
      if (p.vaktplan) pe.push("Hvem jobber i dag?", "Hvem er borte denne uka?");
      pe.push("Hvem har ikke levert timer?", p.vaktplan ? (p.tavle ? "Lag rullering for i morgen" : "Publiser neste uke") : "Godkjenn alle leverte timer");
    } else if (p.se) {
      ps.push(p.vaktplan ? "Hvem jobber i dag?" : "Hvem har ikke levert timer?", "Hvor mange timer har Kari ført denne uka?");
      if (p.vaktplan) pe.push("Hvem jobber i dag?", "Hvem er borte denne uka?");
      pe.push("Hvem har ikke levert timer?");
    } else {
      if (p.vaktplan) ps.push("Jeg er syk i dag");
      ps.push("Før 7,5 timer i dag", p.vaktplan ? "Når jobber jeg neste gang?" : "Lever timene for denne uka");
      if (p.vaktplan) pe.push("Når jobber jeg neste gang?", "Er det noen ledige vakter?");
      pe.push("Hvor mange timer har jeg ført denne uka?");
      if (p.vaktplan) pe.push("Hvor mange feriedager har jeg igjen?");
    }
    // Med fakturaene også: litt av begge.
    si.push(...(s.faktura ? ps.slice(0, 1) : ps));
    eksempler.push(...(s.faktura ? pe.slice(0, 2) : pe));
  }
  return {
    si: si.map((x) => `«${x}»`),
    eksempler: eksempler.slice(0, 4),
    bekreft: !p
      ? "Alt som sender, registrerer eller purrer, må du bekrefte."
      : s.faktura
        ? "Alt som sender, registrerer eller endrer noe, må du bekrefte."
        : "Alt som endrer noe, må du bekrefte.",
  };
}

// Knappen som bekrefter alle forslagene av samme slag på én gang («Send alle 3»).
function masseKnapp(f: Forslag): string | null {
  switch (f.type) {
    case "purring":
      return "Send alle";
    case "ny_vakt":
      return "Lag alle";
    case "vikar":
      return "Sett inn alle";
    case "timer":
      return "Før alle";
    case "godkjenn_timer":
      return f.godkjent ? "Godkjenn alle" : "Avvis alle";
    case "svar_overforing":
      return f.godkjent ? "Godkjenn alle" : "Avslå alle";
    default:
      return null;
  }
}

const erFaktura = (f: Forslag): f is FForslag => ["ny_faktura", "send_utkast", "send_igjen", "betaling", "purring"].includes(f.type);

// Utfører et bekreftet forslag med de vanlige rutene.
async function utfor(orgId: string, f: Forslag, hvem: { meg: string | null; leder: boolean }): Promise<Utfort> {
  return erFaktura(f) ? utforFaktura(orgId, f) : utforPersonal(orgId, f, hvem);
}

async function utforFaktura(orgId: string, f: FForslag): Promise<Utfort> {
  const til = (id: string) => ({ tekst: "Åpne fakturaen", til: `/fakturaer/${id}` });
  if (f.type === "ny_faktura") {
    const u = f.utkast;
    const ny = await api("POST", `/org/${orgId}/fakturaer`, {
      kunde_id: u.kunde_id,
      fakturadato: u.fakturadato,
      forfallsdato: u.forfallsdato,
      periode_fra: u.periode_fra,
      periode_til: u.periode_til,
      deres_referanse: u.deres_referanse,
      kommentar: u.kommentar,
      gebyr: f.gebyr,
      linjer: u.linjer.map((l) => ({
        produkt_id: l.produkt_id,
        beskrivelse: l.beskrivelse,
        antall: l.antall,
        enhet: l.enhet,
        enhetspris: l.enhetspris ?? 0,
        mva_sats: l.mva_sats,
        rabatt_prosent: l.rabatt_prosent,
      })),
    });
    if (!f.send) return { melding: "Utkastet er lagret.", lenke: til(ny.id) };
    try {
      const s = await api("POST", `/org/${orgId}/fakturaer/${ny.id}/utsted`, { send_epost: true });
      return { melding: `Faktura ${s.fakturanummer} er sendt.`, lenke: til(ny.id) };
    } catch (e) {
      throw Object.assign(new Error(`Utkastet er lagret, men ikke sendt: ${(e as Error).message}`), { lenke: til(ny.id) });
    }
  }
  if (f.type === "send_utkast") {
    const s = await api("POST", `/org/${orgId}/fakturaer/${f.faktura_id}/utsted`, { send_epost: true });
    return { melding: `Faktura ${s.fakturanummer} er sendt.`, lenke: til(f.faktura_id) };
  }
  if (f.type === "send_igjen") {
    await api("POST", `/org/${orgId}/fakturaer/${f.faktura_id}/send`, {});
    return { melding: `Faktura ${f.fakturanummer} er sendt på nytt.`, lenke: til(f.faktura_id) };
  }
  if (f.type === "betaling") {
    await api("POST", `/org/${orgId}/fakturaer/${f.faktura_id}/betalinger`, { belop: f.belop, dato: f.dato, notat: "Registrert med AI-assistenten" });
    return { melding: `Betalingen er registrert på faktura ${f.fakturanummer}.`, lenke: til(f.faktura_id) };
  }
  await api("POST", `/org/${orgId}/fakturaer/${f.faktura_id}/purring`, { type: f.purring });
  return { melding: `${f.purring === "paaminnelse" ? "Påminnelsen" : "Inkassovarselet"} på faktura ${f.fakturanummer} er sendt.`, lenke: til(f.faktura_id) };
}

// --- Personal ----------------------------------------------------------------------------

const tavla = (dato: string): Lenke => ({ tekst: "Tavla", til: `/vakter?fane=tavle&dato=${dato}` });
const mineVakter: Lenke = { tekst: "Mine vakter", til: "/vakter?fane=mine" };
const ansatt = (id: string | null) => (id ? { ansatt_id: id } : {}); // uten: den innloggede selv

async function utforPersonal(orgId: string, f: PForslag, hvem: { meg: string | null; leder: boolean }): Promise<Utfort> {
  const o = `/org/${orgId}`;
  switch (f.type) {
    case "fravaer": {
      const r = await api<{ vakter: { id: string; dato: string }[] }>("POST", `${o}/fravaer`, {
        ...ansatt(f.ansatt_id),
        type: f.fravaerstype,
        fra: f.fra,
        til: f.til,
        notat: f.notat,
      });
      // Vikaren tar vaktene i perioden, og de faste arbeidsdagene (som først blir vakter fra planen).
      let satt = 0;
      const feil: string[] = [];
      if (f.vikar_id) {
        const vakter = r.vakter.map((v) => v.id);
        const borte = f.ansatt_id ?? hvem.meg;
        for (const dato of f.faste.filter((d) => !r.vakter.some((v) => v.dato === d)))
          try {
            if (borte) vakter.push((await api<{ id: string }>("POST", `${o}/vakter/fra-plan`, { ansatt_id: borte, dato })).id);
          } catch (e) {
            feil.push((e as Error).message);
          }
        for (const id of vakter)
          try {
            await api("POST", `${o}/vakter/${id}/vikar`, { ansatt_id: f.vikar_id });
            satt++;
          } catch (e) {
            feil.push((e as Error).message);
          }
      }
      const deler = [f.ansatt_id || hvem.leder ? "Fraværet er registrert." : "Fraværet er meldt, og lederen din har fått beskjed."];
      if (satt) deler.push(satt === 1 ? "Vikaren er satt inn." : `Vikaren er satt inn på ${satt} vakter.`);
      return {
        melding: deler.join(" "),
        lenke: hvem.leder ? tavla(f.fra) : mineVakter,
        advarsel: feil.length ? `Vikaren ble ikke satt inn på ${antall(feil.length, "vakt", "vakter")} (${feil[0]}). Sett den inn på tavla.` : undefined,
      };
    }
    case "vikar": {
      const id = f.vakt_id ?? (f.fast ? (await api<{ id: string }>("POST", `${o}/vakter/fra-plan`, f.fast)).id : null);
      if (!id) throw new Error("Fant ikke vakten");
      const v = await api<{ dato: string }>("POST", `${o}/vakter/${id}/vikar`, { ansatt_id: f.vikar_id });
      return { melding: "Vikaren er satt inn og har fått beskjed.", lenke: tavla(v.dato) };
    }
    case "ny_vakt":
      await api("POST", `${o}/vakter`, { ansatt_id: f.ansatt_id, dato: f.dato, fra: f.fra, til: f.til, pause_min: f.pause_min, oppgave: f.oppgave, notat: f.notat });
      return { melding: "Vakten er lagt inn som utkast. Publiser når planen er klar.", lenke: { tekst: "Vaktplanen", til: `/vakter?uke=${mandag(f.dato)}` } };
    case "publiser": {
      const r = await api<{ publisert: number }>("POST", `${o}/vakter/publiser`, { fra: f.fra, til: f.til });
      return { melding: `${antall(r.publisert, "vakt er publisert", "vakter er publisert")}, og de ansatte har fått beskjed.`, lenke: { tekst: "Vaktplanen", til: `/vakter?uke=${mandag(f.fra)}` } };
    }
    case "ta_vakt":
      await api("POST", `${o}/vakter/${f.vakt_id}/ta`, {});
      return { melding: "Vakten er din.", lenke: mineVakter };
    case "plassering":
      for (const p of f.plasser) await api("PUT", `${o}/tavle/plassering`, p);
      return { melding: "Plassert på tavla.", lenke: tavla(f.plasser[0]?.dato ?? "") };
    case "rullering":
      await api("POST", `${o}/tavle/rullering`, { fra: f.fra, til: f.til, lagre: true });
      return { melding: "Rulleringen er lagret på tavla.", lenke: tavla(f.fra) };
    case "timer":
      await api("POST", `${o}/timer`, {
        ...ansatt(f.ansatt_id),
        dato: f.dato,
        fra: f.fra,
        til: f.til,
        pause_min: f.pause_min,
        timer: f.fra ? null : f.timer,
        beskrivelse: f.beskrivelse,
        ...(f.vakt_id ? { vakt_id: f.vakt_id } : {}),
      });
      return {
        melding: "Timene er ført.",
        lenke: f.ansatt_id
          ? { tekst: "Timene", til: `/timer?fane=alle&ansatt=${f.ansatt_id}&uke=${mandag(f.dato)}` }
          : { tekst: "Mine timer", til: `/timer?fane=mine&uke=${mandag(f.dato)}` },
      };
    case "lever_timer": {
      const r = await api<{ levert: number }>("POST", `${o}/timer/lever`, { ...ansatt(f.ansatt_id), fra: f.fra, til: f.til });
      return { melding: `${antall(r.levert, "føring er levert", "føringer er levert")} til godkjenning.` };
    }
    case "godkjenn_timer":
      if (f.godkjent) {
        const r = await api<{ godkjent: number }>("POST", `${o}/timer/godkjenn`, { ider: f.ider });
        return { melding: `${antall(r.godkjent, "føring er godkjent", "føringer er godkjent")}.` };
      } else {
        const r = await api<{ avvist: number }>("POST", `${o}/timer/avvis`, { ider: f.ider, ...(f.grunn ? { grunn: f.grunn } : {}) });
        return { melding: `${antall(r.avvist, "føring er avvist", "føringer er avvist")}, og den ansatte har fått beskjed.` };
      }
    case "overforing":
      await api("POST", `${o}/ferie/overforinger`, { ...ansatt(f.ansatt_id), dager: f.dager, begrunnelse: f.begrunnelse, godkjent: f.godkjent });
      return { melding: f.godkjent ? "Feriedagene er overført." : "Søknaden er sendt." };
    case "svar_overforing":
      await api("POST", `${o}/ferie/overforinger/${f.id}/behandle`, { godkjent: f.godkjent, svar: f.svar });
      return { melding: f.godkjent ? "Søknaden er godkjent." : "Søknaden er avslått." };
  }
}

export function Assistent() {
  const { org } = useKonto();
  const status = useData(() => hent<Status>(`/org/${org!.id}/ai/assistent/status`), [org?.id]);
  const nav = useNavigate();
  const tilgjengelig = !!status.data?.tilgjengelig;
  const hjelp = status.data ? veiledning(status.data) : null;
  const [apen, settApen] = useState(false);
  const [logg, settLogg] = useState<Melding[]>([]);
  const [tekst, settTekst] = useState("");
  const [fraTale, settFraTale] = useState(false); // teksten i feltet er skrevet ned fra tale
  const [skriverNed, settSkriverNed] = useState(false);
  const [tenker, settTenker] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  const loggRef = useRef<HTMLDivElement>(null);
  const feltRef = useRef<HTMLTextAreaElement>(null);
  const nesteId = useRef(1);
  const iGang = useRef(new Set<string>()); // forslag som utføres eller er utført (mot dobbelttrykk)
  const avbrutt = useRef(false);
  const opptak = useOpptak((lyd) => !avbrutt.current && void skrivNed(lyd), { stilleStopp: true, maksSek: 60 });
  const stotter = kanTaOpp();

  // Plass til knappen nederst på sidene, og ny samtale i en annen organisasjon.
  useEffect(() => {
    document.body.classList.toggle("med-assistent", tilgjengelig);
    return () => document.body.classList.remove("med-assistent");
  }, [tilgjengelig]);
  useEffect(() => settLogg([]), [org?.id]);

  // Knappen glir bort mens man blar nedover (så den ikke dekker felt), og kommer tilbake
  // når man blar opp eller er nederst.
  const [skjult, settSkjult] = useState(false);
  useEffect(() => {
    let forrige = window.scrollY;
    const blar = () => {
      const y = window.scrollY;
      const nederst = window.innerHeight + y >= document.documentElement.scrollHeight - 40;
      if (Math.abs(y - forrige) > 8) settSkjult(y > forrige && y > 80 && !nederst);
      forrige = y;
    };
    window.addEventListener("scroll", blar, { passive: true });
    return () => window.removeEventListener("scroll", blar);
  }, []);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (apen && !d.open) {
      d.showModal();
      // Med mus og tastatur kan man skrive med en gang; på mobil kommer tastaturet først når man velger «Skriv».
      if (window.matchMedia("(pointer: fine)").matches) feltRef.current?.focus();
    }
    if (!apen && d.open) d.close();
  }, [apen]);
  useEffect(() => {
    loggRef.current?.scrollTo({ top: loggRef.current.scrollHeight, behavior: "smooth" });
  }, [logg, tenker, opptak.tar, skriverNed]);
  // Feltet vokser med teksten (opptil fire–fem linjer), så en lengre kommando kan leses før den sendes.
  useEffect(() => {
    const f = feltRef.current;
    if (!f) return;
    f.style.height = "auto";
    f.style.height = `${Math.min(f.scrollHeight + 2, 140)}px`;
  }, [tekst, apen, skriverNed, opptak.tar]);

  const lukk = () => {
    if (opptak.tar) {
      avbrutt.current = true;
      opptak.stopp();
    }
    settApen(false);
  };
  const gaa = (til: string, state?: unknown) => {
    lukk();
    nav(til, state ? { state } : undefined);
  };
  const leggTil = (m: Omit<Melding, "id">) => {
    const id = nesteId.current++;
    settLogg((l) => [...l, { ...m, id }]);
    return id;
  };
  const endre = (id: number, endring: (m: Melding) => Melding) => settLogg((l) => l.map((m) => (m.id === id ? endring(m) : m)));

  // Det assistenten har sagt og gjort, så den forstår «den» og «henne» i neste kommando.
  const historikk = () =>
    logg
      .filter((m) => !m.feil)
      .slice(-8)
      .map((m) => ({
        rolle: m.rolle,
        tekst: [m.tekst, ...(m.forslag ?? []).filter((x) => x.u.status === "ferdig").map((x) => `Utført: ${x.u.melding}`)].join(" "),
      }));

  async function spor(t: string) {
    opptak.settFeil(null);
    leggTil({ rolle: "bruker", tekst: t });
    settTenker(true);
    try {
      const s = await api<Svar>("POST", `/org/${org!.id}/ai/assistent`, { tekst: t, historikk: historikk() });
      leggTil({
        rolle: "assistent",
        tekst: s.tekst,
        forslag: s.forslag.map((f) => ({ f, u: { status: "venter" } })),
        lenker: s.lenker,
        utkast: s.forslag.length ? null : s.utkast,
      });
      if (s.gaa_til) gaa(s.gaa_til);
    } catch (e) {
      leggTil({ rolle: "assistent", tekst: (e as Error).message, feil: true });
    } finally {
      settTenker(false);
    }
  }

  // Tale til tekst: det som ble hørt, kommer i feltet (etter det som står der fra før).
  async function skrivNed(lyd: Blob) {
    settSkriverNed(true);
    try {
      const { tekst: hort } = await sendLyd<{ tekst: string }>(`/org/${org!.id}/ai/assistent/tale`, lyd);
      settTekst((t) => (t.trim() ? `${t.trim()} ${hort}` : hort));
      settFraTale(true);
    } catch (e) {
      opptak.settFeil((e as Error).message);
    } finally {
      settSkriverNed(false);
    }
  }

  async function bekreft(meldingId: number, indekser: number[]) {
    const m = logg.find((x) => x.id === meldingId);
    if (!m?.forslag) return;
    const hvem = { meg: org?.ansatt_id ?? null, leder: !!status.data?.personal?.leder };
    let endret = false;
    for (const i of indekser) {
      const { f, u } = m.forslag[i];
      const nokkel = `${meldingId}:${i}`;
      if ((u.status !== "venter" && u.status !== "feil") || iGang.current.has(nokkel)) continue;
      iGang.current.add(nokkel);
      const sett = (ny: Utfall) =>
        endre(meldingId, (x) => ({ ...x, forslag: x.forslag!.map((y, j) => (j === i ? { ...y, u: ny } : y)) }));
      sett({ status: "utforer" });
      try {
        const r = await utfor(org!.id, f, hvem);
        sett({ status: "ferdig", ...r });
        endret = true;
      } catch (e) {
        iGang.current.delete(nokkel);
        sett({ status: "feil", melding: (e as Error).message, lenke: (e as { lenke?: Lenke }).lenke });
      }
    }
    // Sidene under (fakturaer, vaktplan, timer, ferie) henter på nytt.
    if (endret) dataEndret();
  }
  const avvis = (meldingId: number, i: number) =>
    endre(meldingId, (x) => ({ ...x, forslag: x.forslag!.map((y, j) => (j === i ? { ...y, u: { status: "avvist" } } : y)) }));

  function snakk() {
    avbrutt.current = false;
    opptak.settFeil(null);
    void opptak.start();
  }
  function skriv() {
    opptak.settFeil(null);
    feltRef.current?.focus();
  }
  function send(ev?: FormEvent) {
    ev?.preventDefault();
    const t = tekst.trim();
    if (t.length < 2 || tenker || skriverNed || opptak.tar) return;
    settTekst("");
    settFraTale(false);
    void spor(t);
  }

  if (!tilgjengelig) return null;
  return (
    <>
      <button type="button" className={`assistent-knapp${skjult ? " skjult" : ""}`} onClick={() => settApen(true)} aria-label="AI-assistent" title="AI-assistent">
        <IkonGnist storrelse={26} />
      </button>
      <dialog ref={ref} className="assistent" onClose={lukk} onCancel={lukk} aria-label="AI-assistent">
        <div className="assistent-topp">
          <span className="ai-ikon" aria-hidden="true">
            <IkonGnist storrelse={18} />
          </span>
          <h2>AI-assistent</h2>
          {logg.length > 0 && (
            <button type="button" className="lenke" onClick={() => settLogg([])}>
              Ny samtale
            </button>
          )}
          <button type="button" className="ikon" aria-label="Lukk" onClick={lukk}>
            <IkonLukk storrelse={18} />
          </button>
        </div>

        <div className="assistent-logg" ref={loggRef} role="log" aria-live="polite">
          {logg.length === 0 && opptak.tar && (
            <div className="assistent-velkommen">
              <p>
                <strong>Jeg lytter.</strong> Si for eksempel {eller(hjelp?.si ?? [])}.
              </p>
            </div>
          )}
          {logg.length === 0 && !opptak.tar && (
            <div className="assistent-velkommen">
              <p>
                Hva vil du gjøre? {stotter ? "Snakk eller skriv" : "Skriv"}, for eksempel {eller(hjelp?.si ?? [])}.
              </p>
              <div className="assistent-valg">
                {stotter && (
                  <button type="button" className="primar" onClick={snakk} disabled={tenker || skriverNed}>
                    <IkonMikrofon storrelse={20} /> Snakk
                  </button>
                )}
                <button type="button" onClick={skriv}>
                  <IkonTastatur storrelse={20} /> Skriv
                </button>
              </div>
              <p className="liten dempet">Eller prøv:</p>
              <div className="assistent-eksempler">
                {(hjelp?.eksempler ?? []).map((e) => (
                  <button key={e} type="button" onClick={() => void spor(e)} disabled={tenker}>
                    {e}
                  </button>
                ))}
              </div>
              <p className="liten dempet">
                {stotter ? "Det du sier, skrives ned i feltet først, så du kan sjekke det før du sender. " : ""}
                {hjelp?.bekreft}
              </p>
            </div>
          )}
          {logg.map((m) =>
            m.rolle === "bruker" ? (
              <div key={m.id} className="boble bruker">
                {m.tekst}
              </div>
            ) : (
              <div key={m.id} className={`boble assistent${m.feil ? " feil" : ""}`}>
                <p>{m.tekst}</p>
                <Alle forslag={m.forslag} bekreft={(indekser) => void bekreft(m.id, indekser)} />
                {m.forslag?.map(({ f, u }, i) => (
                  <div key={i} className={`assistent-forslag ${u.status}`}>
                    <p>{f.tekst}</p>
                    {(u.status === "venter" || u.status === "feil") && (
                      <div className="knapper">
                        <button type="button" className="primar" onClick={() => void bekreft(m.id, [i])}>
                          {u.status === "feil" ? "Prøv igjen" : f.knapp}
                        </button>
                        {f.type === "ny_faktura" && (
                          <button type="button" onClick={() => gaa("/fakturaer/ny", { aiUtkast: f.utkast })}>
                            Åpne i skjemaet
                          </button>
                        )}
                        <button type="button" className="lenke" onClick={() => avvis(m.id, i)}>
                          Avbryt
                        </button>
                      </div>
                    )}
                    {u.status === "utforer" && (
                      <span className="dempet liten assistent-status">
                        <span className="spinner" /> Utfører …
                      </span>
                    )}
                    {u.status === "ferdig" && <p className="ok-tekst">✓ {u.melding}</p>}
                    {u.status === "ferdig" && u.advarsel && <p className="fare-tekst">{u.advarsel}</p>}
                    {u.status === "feil" && <p className="fare-tekst">{u.melding}</p>}
                    {u.status === "avvist" && <p className="dempet liten">Avbrutt.</p>}
                    {/* Lenken etter utførelsen, når den ikke står blant lenkene i svaret. */}
                    {u.lenke && (u.status === "ferdig" || u.status === "feil") && !m.lenker?.some((l) => l.til === u.lenke!.til) && (
                      <button type="button" className="lenke" onClick={() => gaa(u.lenke!.til)}>
                        {u.lenke.tekst}
                      </button>
                    )}
                  </div>
                ))}
                {m.utkast && (
                  <div className="knapper">
                    <button type="button" onClick={() => gaa("/fakturaer/ny", { aiUtkast: m.utkast })}>
                      Åpne i skjemaet
                    </button>
                  </div>
                )}
                {m.lenker && m.lenker.length > 0 && (
                  <div className="assistent-lenker">
                    {m.lenker.map((l) => (
                      <button key={l.til + l.tekst} type="button" className="lenke" onClick={() => gaa(l.til)}>
                        {l.tekst}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ),
          )}
          {tenker && (
            <div className="boble assistent tenker" role="status">
              <span className="spinner" /> Tenker …
            </div>
          )}
        </div>

        <Feil melding={opptak.feil} />
        {fraTale && tekst.trim() && !skriverNed && !opptak.tar && <p className="assistent-hint liten dempet">Skrevet ned fra tale. Sjekk teksten, og trykk Send.</p>}
        <form className="assistent-bunn" onSubmit={send}>
          {opptak.tar ? (
            <div className="assistent-lytter" role="status">
              <span className="assistent-niva" style={{ transform: `scaleX(${0.08 + opptak.niva * 0.92})` }} aria-hidden="true" />
              <span>Lytter … {tid(opptak.sek)}</span>
              <span className="dempet liten">Stopper når du tier</span>
            </div>
          ) : skriverNed ? (
            <div className="assistent-lytter" role="status">
              <span className="assistent-status">
                <span className="spinner" /> Skriver ned …
              </span>
            </div>
          ) : (
            <textarea
              ref={feltRef}
              rows={1}
              value={tekst}
              onChange={(e) => settTekst(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) send(e);
              }}
              placeholder={stotter ? "Skriv, eller trykk på mikrofonen" : "Skriv en kommando"}
              aria-label="Kommando til assistenten"
              enterKeyHint="send"
              maxLength={2000}
            />
          )}
          {stotter && (
            <button
              type="button"
              className={`assistent-mik${opptak.tar ? " tar" : ""}`}
              onClick={opptak.tar ? opptak.stopp : snakk}
              disabled={(tenker || skriverNed) && !opptak.tar}
              aria-label={opptak.tar ? "Stopp opptaket" : "Snakk"}
              title={opptak.tar ? "Stopp opptaket" : "Snakk"}
            >
              {opptak.tar ? <span className="assistent-stopp" aria-hidden="true" /> : <IkonMikrofon storrelse={22} />}
            </button>
          )}
          {tekst.trim() && !opptak.tar && !skriverNed && (
            <button type="submit" className="primar" disabled={tenker}>
              Send
            </button>
          )}
        </form>
      </dialog>
    </>
  );
}

// «Send alle 3», «Godkjenn alle 4»: når flere forslag av samme slag venter (og ingen utføres).
function Alle({ forslag, bekreft }: { forslag?: { f: Forslag; u: Utfall }[]; bekreft: (indekser: number[]) => void }) {
  if (forslag?.some((x) => x.u.status === "utforer")) return null;
  const venter = (forslag ?? []).map((x, i) => ({ ...x, i, knapp: masseKnapp(x.f) })).filter((x) => x.u.status === "venter" && x.knapp);
  if (venter.length < 2 || new Set(venter.map((x) => x.knapp)).size > 1) return null;
  return (
    <button type="button" className="primar" onClick={() => bekreft(venter.map((x) => x.i))}>
      {venter[0].knapp} {venter.length}
    </button>
  );
}
