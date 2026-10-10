// Reiser (0083_naturalytelser_reiser.sql): kostgodtgjørelse (diett), nattillegg,
// kilometergodtgjørelse og utlegg for en reiseregning, etter statens satser (særavtalen for reiser
// innenlands) eller de trekkfrie satsene (Skattedirektoratets satsforskrift), og hvor mye av det
// som er trekkfritt.
//
// Det som betales innenfor de trekkfrie satsene, er trekkfri utgiftsgodtgjørelse (i a-meldingen med
// antall døgn, netter eller km, uten trekk og avgift); det som er over, er trekkpliktig og gir
// arbeidsgiveravgift. Er vilkårene for trekkfri godtgjørelse ikke oppfylt (f.eks. mangler
// reiseregningen det den skal ha), er alt trekkpliktig. Utlegg etter regning refunderes og
// rapporteres ikke.
//
// Kost: dagsreise (over 15 km og minst 6 timer) med satsen for 6–12 timer eller over 12 timer. Med
// overnatting døgnsatsen per hele døgn fra avreisen. Statens særavtale innenlands (§ 9) gir for tiden
// ut over hele døgn satsen for 6–12 timer eller satsen for over 12 timer uten overnatting (en reise
// med overnatting som er kortere enn et døgn, får døgnsatsen når den er over 12 timer). De trekkfrie
// satsene regner et påbegynt døgn på 6 timer eller mer som et helt døgn, med satsen for overnattingen
// (hotell, hybel uten kokemulighet, eller hybel med kokemulighet og privat). Måltider som er dekket,
// trekkes fra dagens sats: frokost 20 %, lunsj 30 % og middag 50 % (ikke frokost når det er
// nattillegg); de trekkfrie satsene rundes til hele kroner. Det trekkfrie regnes per døgn: det som
// betales over den trekkfrie satsen et døgn, er trekkpliktig selv om et annet døgn er under. Etter
// 28 døgn (langvarig opphold) er kosten her regnet som trekkpliktig. Utland (statens særavtale
// utenfor Norge, § 8): satsen for landet per døgn, 50 % av den for 6–12 timer og hele fra 12 timer
// (dagsreisen og tiden ut over hele døgn), og 25 % lavere fra det 29. døgnet; de trekkfrie satsene
// er de samme som i Norge. Nattillegg (ulegitimert) per natt, bare innenlands og ikke på hotell.
//
// Kilometergodtgjørelse: egen bil (statens sats eller den trekkfrie per km; det som er over den
// trekkfrie, er trekkpliktig), tillegg for skogsvei og tilhenger, passasjertillegg per passasjer og
// km, og andre kjøretøy (motorsykkel, moped, snøscooter, båt) med satsene, som er de samme.
import { rund, tall } from "./lonnsberegning.js";

export type Overnatting = "ingen" | "hotell" | "hybel" | "privat";
export type Kjoretoy = "bil" | "mc" | "moped" | "snoscooter" | "baat";
export type Etappe = { dato: string; fra: string; til: string; km: number; kjoretoy: Kjoretoy; passasjerer: string[]; skogsvei: number; tilhenger: boolean };
export type Utlegg = { dato: string; tekst: string; belop: number };
export type Reise = {
  formaal: string;
  sted: string | null;
  fra: string; // avreise, ÅÅÅÅ-MM-DDTtt:mm (norsk tid)
  til: string; // hjemkomst
  overnatting: Overnatting;
  nattillegg: boolean;
  utland: boolean;
  land: string | null;
  kostsats: number | null; // statens sats per døgn i landet (utland)
  diett: boolean;
  maaltider: Record<string, string>; // dekket per døgn, f.eks. {"1": "F", "2": "FLM"}
  kjoring: Etappe[];
  utlegg: Utlegg[];
  trekkfri: boolean;
};
export type Reisesatser = "staten" | "trekkfri";
export type Reiselinje = { lonnsart: string; tekst: string; antall: number | null; sats: number | null; belop: number };
export type Dogn = { nr: number; fra: string; til: string; timer: number; maaltider: string; sats: number; trekkfri: number };
export type Reiseberegning = {
  linjer: Reiselinje[];
  dogn: Dogn[];
  belop: number; // det som utbetales
  trekkfritt: number;
  trekkpliktig: number;
  utlegg: number;
  aar: number; // året satsene er fra
  merknader: string[];
};

type Statens = { dag6: number; dag12: number; dogn: number; natt: number; km: Record<Kjoretoy, number>; tillegg: number };
type Trekkfrie = { dag6: number; dag12: number; hotell: number; hybel: number; privat: number; natt: number; km: Record<Kjoretoy, number>; tillegg: number };

// Satsene per år: statens særavtale for reiser innenlands (2026–2027) og satsforskriften
// (forskuddssatsene) for året. Nye år legges inn her.
export const REISESATSER: Record<number, { staten: Statens; trekkfri: Trekkfrie }> = {
  2026: {
    staten: { dag6: 397, dag12: 736, dogn: 1012, natt: 452, km: { bil: 5.3, mc: 2.95, moped: 2, snoscooter: 10, baat: 7.5 }, tillegg: 1 },
    trekkfri: { dag6: 200, dag12: 400, hotell: 693, hybel: 400, privat: 107, natt: 452, km: { bil: 3.5, mc: 2.95, moped: 2, snoscooter: 10, baat: 7.5 }, tillegg: 1 },
  },
};

// Satsene for året, eller for det nærmeste året før (eller etter) når året ikke er lagt inn.
export function reisesatser(aar: number) {
  const aarene = Object.keys(REISESATSER)
    .map(Number)
    .sort((a, b) => a - b);
  const brukt = [...aarene].reverse().find((a) => a <= aar) ?? aarene[0]!;
  return { aar: brukt, kjent: brukt === aar, ...REISESATSER[brukt]! };
}

export const KJORETOY: Record<Kjoretoy, string> = {
  bil: "bil",
  mc: "motorsykkel over 125 ccm",
  moped: "moped eller motorsykkel til 125 ccm",
  snoscooter: "snøscooter eller ATV",
  baat: "båt",
};
const OVERNATTING_ART: Record<Exclude<Overnatting, "ingen">, string> = { hotell: "reise_kost_hotell", hybel: "reise_kost_hybel", privat: "reise_kost_privat" };
const OVERNATTING_NAVN: Record<Exclude<Overnatting, "ingen">, string> = { hotell: "hotell", hybel: "hybel/pensjonat/brakke", privat: "hybel med kokemulighet/privat" };
const ANDEL: [string, number][] = [
  ["F", 0.2],
  ["L", 0.3],
  ["M", 0.5],
];

const tid = (t: string) => Date.parse(`${t.slice(0, 16)}:00Z`);
const plussTimer = (t: string, h: number) => new Date(tid(t) + h * 3_600_000).toISOString().slice(0, 16);
const netter = (fra: string, til: string) => Math.round((Date.parse(`${til.slice(0, 10)}T12:00:00Z`) - Date.parse(`${fra.slice(0, 10)}T12:00:00Z`)) / 86_400_000);
const kort = (d: string) => `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}`;

// «Bergen 5.–7.10»: stedet (eller formålet) og datoene, til teksten på linjene.
export function reisenavn(r: Pick<Reise, "formaal" | "sted" | "fra" | "til">) {
  const navn = (r.sted || r.formaal).trim();
  const a = r.fra.slice(0, 10);
  const b = r.til.slice(0, 10);
  const datoer = a === b ? kort(a) : a.slice(0, 7) === b.slice(0, 7) ? `${Number(a.slice(8, 10))}.–${kort(b)}` : `${kort(a)}–${kort(b)}`;
  return `${navn.length > 40 ? `${navn.slice(0, 39)}…` : navn} ${datoer}`;
}

// Dagens sats etter måltidene som er dekket (høyst hele satsen).
function etterMaaltider(sats: number, maaltider: string, utenFrokost: boolean, heleKroner: boolean) {
  const andel = ANDEL.filter(([k]) => maaltider.includes(k) && !(k === "F" && utenFrokost)).reduce((x, [, a]) => x + a, 0);
  const igjen = Math.max(0, sats * (1 - Math.min(1, andel)));
  return heleKroner ? Math.round(igjen) : rund(igjen);
}

export function beregnReise(r: Reise, satser: Reisesatser, aar = Number(r.fra.slice(0, 4))): Reiseberegning {
  const s = reisesatser(aar);
  const st = s.staten;
  const tf = s.trekkfri;
  const staten = satser === "staten";
  const navn = reisenavn(r);
  const merknader: string[] = [];
  if (!s.kjent) merknader.push(`Satsene for reiser i ${aar} er ikke lagt inn; satsene for ${s.aar} er brukt.`);
  const linjer: Reiselinje[] = [];
  const linje = (lonnsart: string, tekst: string, belop: number, antall: number | null = null, sats: number | null = null) => {
    const b = rund(belop);
    const t = `${navn}: ${tekst}`;
    if (b > 0) linjer.push({ lonnsart, tekst: t.length > 120 ? `${t.slice(0, 119)}…` : t, antall: antall == null ? null : rund(antall), sats, belop: b });
  };

  // Kost: periodene (dagsreisen, eller hele døgn og resten) og satsene for hver.
  const timer = (tid(r.til) - tid(r.fra)) / 3_600_000;
  const perioder: { nr: number; fra: string; til: string; timer: number; hel: boolean }[] = [];
  if (r.overnatting === "ingen") perioder.push({ nr: 1, fra: r.fra, til: r.til, timer, hel: false });
  else {
    const hele = Math.floor(timer / 24 + 1e-9);
    for (let i = 0; i < hele; i++) perioder.push({ nr: i + 1, fra: plussTimer(r.fra, 24 * i), til: plussTimer(r.fra, 24 * (i + 1)), timer: 24, hel: true });
    const rest = rund(timer - hele * 24);
    if (rest > 0) perioder.push({ nr: hele + 1, fra: plussTimer(r.fra, 24 * hele), til: r.til, timer: rest, hel: false });
  }
  const utenFrokost = r.nattillegg;
  const overnattingSats = r.overnatting === "ingen" ? 0 : tf[r.overnatting];
  let utlandUtenSats = false;
  const dogn: Dogn[] = perioder.map((p) => {
    const maaltider = (r.maaltider[String(p.nr)] ?? "").toUpperCase();
    // Den trekkfrie satsen for perioden.
    let fri = 0;
    if (r.overnatting === "ingen") fri = p.timer > 12 ? tf.dag12 : p.timer >= 6 ? tf.dag6 : 0;
    else if ((p.hel || p.timer >= 6) && p.nr <= 28) fri = overnattingSats;
    // Satsen som betales.
    let sats = fri;
    if (staten) {
      if (r.utland && r.kostsats != null) {
        // Utenfor Norge: landets sats, 50 % for 6–12 timer, 25 % lavere fra det 29. døgnet.
        const full = p.nr > 28 ? r.kostsats * 0.75 : r.kostsats;
        sats = p.hel || p.timer >= 12 ? full : p.timer >= 6 ? full * 0.5 : 0;
      } else if (r.overnatting === "ingen") {
        if (r.utland) utlandUtenSats = true;
        sats = p.timer > 12 ? st.dag12 : p.timer >= 6 ? st.dag6 : 0;
      } else if (r.utland) {
        utlandUtenSats = true;
        sats = p.hel || p.timer >= 6 ? overnattingSats : 0;
      } else sats = p.hel || (p.nr === 1 && p.timer > 12) ? st.dogn : p.timer > 12 ? st.dag12 : p.timer >= 6 ? st.dag6 : 0;
    } else if (p.nr > 28 && (p.hel || p.timer >= 6)) sats = overnattingSats;
    return {
      nr: p.nr,
      fra: p.fra,
      til: p.til,
      timer: rund(p.timer),
      maaltider,
      sats: r.diett ? etterMaaltider(sats, maaltider, utenFrokost, !staten) : 0,
      trekkfri: r.diett && r.trekkfri ? etterMaaltider(fri, maaltider, utenFrokost, true) : 0,
    };
  });
  if (utlandUtenSats)
    merknader.push(
      `Statens sats for ${r.land || "landet"} er ikke ført; ${r.overnatting === "ingen" ? "satsene for dagsreiser i Norge er brukt" : "den trekkfrie satsen er brukt"}.`,
    );
  if (r.overnatting !== "ingen" && perioder.length > 28 && r.diett)
    merknader.push("Reisen er over 28 døgn: kosten etter 28 døgn er regnet som trekkpliktig (langvarig opphold). Kontroller satsene.");
  const kost = rund(dogn.reduce((x, d) => x + d.sats, 0));
  // Det trekkfrie per døgn (måltidstrekket og det som er over den trekkfrie satsen regnes per døgn).
  const kostFri = rund(dogn.reduce((x, d) => x + Math.min(d.sats, d.trekkfri), 0));
  if (r.overnatting === "ingen") {
    linje("reise_kost_dag", `kost på dagsreise (${tall(rund(timer))} t)`, kostFri, 1);
  } else {
    const antall = dogn.filter((d) => d.trekkfri > 0).length;
    linje(OVERNATTING_ART[r.overnatting], `kost ${antall} døgn (${OVERNATTING_NAVN[r.overnatting]})`, kostFri, antall);
  }
  linje("reise_kost_trekk", r.trekkfri ? "kost over den trekkfrie satsen" : "kost (trekkpliktig)", kost - kostFri);

  // Nattillegg (ulegitimert) per natt.
  if (r.nattillegg && r.overnatting !== "ingen" && !r.utland) {
    const n = netter(r.fra, r.til);
    const betalt = n * (staten ? st.natt : tf.natt);
    const fri = r.trekkfri ? Math.min(betalt, n * tf.natt) : 0;
    linje("reise_nattillegg", `nattillegg ${n} ${n === 1 ? "natt" : "netter"}`, fri, n, rund(fri / Math.max(1, n)));
    linje("reise_annet_trekk", r.trekkfri ? "nattillegg over den trekkfrie satsen" : "nattillegg (trekkpliktig)", betalt - fri);
  }

  // Kjøring: egen bil (med tillegg og passasjerer) og andre kjøretøy.
  let kmBil = 0;
  let bilBetalt = 0;
  let bilFri = 0;
  let tillegg = 0;
  let passasjerKm = 0;
  const andre = new Map<Kjoretoy, { km: number; belop: number }>();
  for (const e of r.kjoring) {
    const km = Number(e.km);
    if (e.kjoretoy === "bil") {
      kmBil += km;
      bilBetalt += km * (staten ? st.km.bil : tf.km.bil);
      bilFri += km * tf.km.bil;
      tillegg += (Math.min(Number(e.skogsvei) || 0, km) + (e.tilhenger ? km : 0)) * tf.tillegg;
      passasjerKm += km * e.passasjerer.length;
    } else {
      const x = andre.get(e.kjoretoy) ?? { km: 0, belop: 0 };
      x.km += km;
      x.belop += km * (staten ? st.km[e.kjoretoy] : tf.km[e.kjoretoy]);
      andre.set(e.kjoretoy, x);
    }
  }
  if (r.trekkfri) {
    const fri = Math.min(bilBetalt, bilFri);
    linje("km_bil", `${tall(rund(kmBil))} km med bil`, fri, kmBil, tf.km.bil);
    linje("km_tillegg", "tillegg for skogsvei og tilhenger", tillegg);
    linje("km_passasjer", `passasjertillegg (${tall(rund(passasjerKm))} km)`, passasjerKm * tf.tillegg, passasjerKm, tf.tillegg);
    linje("km_bil_trekk", `kilometergodtgjørelse over den trekkfrie satsen (${tall(rund(kmBil))} km à ${tall(rund(st.km.bil - tf.km.bil))} kr)`, bilBetalt - fri);
    for (const [k, x] of andre) linje("km_annet", `${tall(rund(x.km))} km med ${KJORETOY[k]}`, x.belop, x.km, rund(x.belop / x.km));
  } else {
    linje("km_bil_trekk", `${tall(rund(kmBil))} km med bil (trekkpliktig)`, bilBetalt + tillegg + passasjerKm * st.tillegg, kmBil);
    for (const [k, x] of andre) linje("km_annet_trekk", `${tall(rund(x.km))} km med ${KJORETOY[k]} (trekkpliktig)`, x.belop, x.km);
  }

  // Utlegg etter regning.
  const utlegg = rund(r.utlegg.reduce((x, u) => x + Number(u.belop), 0));
  linje("reise_utlegg", `utlegg etter regning (${r.utlegg.length} bilag)`, utlegg);

  if (!r.trekkfri) merknader.push("Vilkårene for trekkfri godtgjørelse er ikke oppfylt: alt utenom utleggene er trekkpliktig.");
  const trekkpliktige = new Set(["reise_kost_trekk", "reise_annet_trekk", "km_bil_trekk", "km_annet_trekk"]);
  const sum = (f: (l: Reiselinje) => boolean) => rund(linjer.filter(f).reduce((x, l) => x + l.belop, 0));
  return {
    linjer,
    dogn,
    belop: sum(() => true),
    trekkfritt: sum((l) => !trekkpliktige.has(l.lonnsart) && l.lonnsart !== "reise_utlegg"),
    trekkpliktig: sum((l) => trekkpliktige.has(l.lonnsart)),
    utlegg,
    aar: s.aar,
    merknader,
  };
}
