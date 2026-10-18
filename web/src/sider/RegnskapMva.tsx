// Regnskap → Mva (server/src/mva.ts): mva-meldingen for terminen regnet fra bilagene, med linjene
// slik de føres i Altinn (koden, grunnlaget og satsen for utgående avgift, fradraget for inngående),
// summen å betale eller til gode, fristen, kontrollene, oppgjøret (bilagserie V) og om meldingen er
// levert. Når innsendingen er slått på, sendes meldingen til Skatteetaten herfra (mvaInnsending.ts):
// brukeren logger inn i ID-porten og kommer tilbake til /mva/idporten (MvaIdporten under), og siden
// viser sendingen til tilbakemeldingen med kvitteringen er hentet. Ellers leveres meldingen i Altinn og
// merkes som levert. Terminene i året står under, og mva-justeringen for kapitalvarene i året
// (RegnskapMvaJustering.tsx).
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, hent, lastNed } from "../api";
import { Feil, Laster, Tom, useData, useHandling } from "../felles";
import { useKonto } from "../konto";
import { dato, iDag, kr } from "../format";
import { IkonHoyre, IkonRegnskap, IkonVenstre } from "../ikoner";
import { visKontonr } from "../personnummer";
import { MvaJustering } from "./RegnskapMvaJustering";

// Merknadene en linje med motsatt fortegn kan forklares med (fritekst: egen forklaring godtas).
type Merknadsvalg = { koder: { kode: string; navn: string }[]; fritekst: boolean };
// spesifikasjon: «justering» for justeringen for kapitalvarer.
type Linje = {
  kode: string;
  beskrivelse: string;
  grunnlag: number | null;
  sats: number | null;
  merverdiavgift: number;
  fradrag: boolean;
  spesifikasjon: "justering" | null;
  merknad_valg?: Merknadsvalg | null;
};
type Avvik = { alvor: "ugyldig" | "avvik" | "info"; tekst: string; kode: string | null; regel: string | null; sti: string | null; mvaKode: string | null };
type Merknad = { utvalgt: string } | { beskrivelse: string };
// Den siste sendingen til Skatteetaten for terminen (linjer: det som ble sendt, med merknadene).
type Innsending = {
  id: string;
  linjer?: { kode: string; spesifikasjon: string | null; merknad: Merknad | null }[];
  status: "innlogging" | "sender" | "sendt" | "mottatt" | "feil" | "avbrutt";
  steg: string | null;
  feil: string | null;
  avvik: Avvik[] | null;
  betaling: { kid: string | null; belop: number | null; frist: string | null; konto: string | null; betaleTil: string | null; informasjon: string | null } | null;
  tilbakemelding: { status?: string | null; beskrivelse?: string | null; resultat?: string | null; melding?: string } | null;
  har_kvittering: boolean;
  sum: number;
  opprettet: string;
  sendt_at: string | null;
  mottatt_at: string | null;
  startet_av: string | null;
  egen: boolean;
};
type Termin = { aar: number; type: "tomaaneder" | "aar" | "maaned"; termin: number; fra: string; til: string; navn: string; frist: string };
type Status = {
  type: Termin["type"];
  termin: Termin;
  over: boolean;
  registrert: boolean;
  linjer: Linje[];
  sum: number;
  kontroller: string[];
  oppgjor: { bilag: { id: string; bilagsnummer: string } | null; stemmer: boolean; trengs: boolean };
  levert: { dato: string; belop: number; av: string | null } | null;
  endret: boolean;
  terminer: { termin: number; navn: string; frist: string; over: boolean; sum: number | null; levert: boolean | null }[];
  laast_til: string | null;
  innsending_paa: boolean;
  innsending: Innsending | null;
};

const prosent = (n: number) => `${String(n).replace(".", ",")} %`;
const belopTekst = (sum: number) => (sum >= 0 ? `${kr(sum)} kr å betale` : `${kr(-sum)} kr til gode`);
// Dato og klokkeslett (norsk tid), f.eks. «18.10.2026 kl. 10.15».
const tidspunkt = (iso: string) => {
  const d = new Date(iso);
  const t = new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return `${dato(new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(d))} kl. ${t.replace(":", ".")}`;
};
// Hvor langt sendingen har kommet (steget workeren er i).
const STEG: Record<string, string> = {
  innlogging: "Fullfører innloggingen",
  validering: "Skatteetaten validerer meldingen",
  instans: "Sender meldingen i Altinn",
  utfylt: "Sender meldingen i Altinn",
  bekreftelse: "Sender meldingen i Altinn",
};
// Venter på workeren: sendingen pågår, eller tilbakemeldingen er ikke hentet.
const venter = (i: Innsending | null) => i !== null && (i.status === "sender" || (i.status === "sendt" && !i.tilbakemelding));

// Terminen før eller etter (året rundt).
function flytt(t: Termin, n: number): [number, number] {
  if (t.type === "aar") return [t.aar + n, 1];
  const antall = t.type === "tomaaneder" ? 6 : 12;
  const x = t.aar * antall + (t.termin - 1) + n;
  return [Math.floor(x / antall), (x % antall) + 1];
}

function Statusmerke({ s }: { s: Status }) {
  if (!s.over) return <span className="merke merke-noytral">Terminen pågår</span>;
  if (s.levert) return s.endret ? <span className="merke merke-advarsel">Endret etter levering</span> : <span className="merke merke-ok">Levert {dato(s.levert.dato)}</span>;
  return <span className="merke merke-advarsel">{iDag() > s.termin.frist ? "Fristen er ute" : "Ikke levert"}</span>;
}

// Sendingen til Skatteetaten: hvor langt den har kommet, feilen, avvikene fra valideringen,
// betalingsinformasjonen og kvitteringen.
function Sending({ inn, kvittering }: { inn: Innsending; kvittering: () => void }) {
  const avvik = (inn.avvik ?? []).filter((a) => a.alvor !== "info");
  const ugyldig = avvik.some((a) => a.alvor === "ugyldig");
  const b = inn.betaling;
  const av = inn.startet_av ? ` av ${inn.startet_av}` : "";
  return (
    <>
      {inn.status === "innlogging" && (
        <p className="liten dempet">
          Innloggingen i ID-porten ble startet {tidspunkt(inn.opprettet)}
          {av}, men er ikke fullført. Meldingen er ikke sendt.
        </p>
      )}
      {inn.status === "sender" && (
        <div className="melding info mva-sender" role="status">
          <span className="spinner" aria-hidden="true" />
          <span>{STEG[inn.steg ?? "innlogging"] ?? "Sender meldingen"} …</span>
        </div>
      )}
      {inn.status === "sendt" && (
        <div className="melding ok" role="status">
          Sendt til Skatteetaten {inn.sendt_at ? tidspunkt(inn.sendt_at) : ""}
          {av}. {inn.tilbakemelding?.melding ?? "Venter på kvitteringen fra Skatteetaten."}
        </div>
      )}
      {inn.status === "mottatt" && (
        <div className="melding ok med-knapp" role="status">
          <span>
            Mottatt av Skatteetaten {inn.mottatt_at ? tidspunkt(inn.mottatt_at) : ""}
            {inn.tilbakemelding?.status && !/^mottatt$/i.test(inn.tilbakemelding.status) ? ` (${inn.tilbakemelding.status.toLowerCase()})` : ""}.
          </span>
          {inn.har_kvittering && (
            <button type="button" onClick={kvittering}>
              Last ned kvitteringen
            </button>
          )}
        </div>
      )}
      {inn.status === "feil" && inn.feil && (
        <div className="melding feil" role="alert">
          {inn.feil}
        </div>
      )}
      {inn.status === "avbrutt" && <p className="liten dempet">{inn.feil ?? "Innloggingen i ID-porten ble avbrutt. Meldingen er ikke sendt."}</p>}
      {avvik.length > 0 && (
        <div className={`melding ${ugyldig ? "feil" : "advarsel"}`}>
          <strong>{ugyldig ? "Feil Skatteetaten fant i meldingen" : "Avvik Skatteetaten kan følge opp"}</strong>
          <ul>
            {avvik.map((a, i) => (
              <li key={i}>
                {a.tekst}
                {a.mvaKode ? ` (kode ${a.mvaKode})` : ""}
                {a.kode ? ` – ${a.kode}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(inn.status === "sendt" || inn.status === "mottatt") && b && b.belop !== null && b.belop !== 0 && (
        <p className="liten mva-betaling">
          {b.belop > 0 ? (
            <>
              Betal <strong>{kr(b.belop)} kr</strong>
              {b.konto ? (
                <>
                  {" "}
                  til konto <strong>{visKontonr(b.konto)}</strong>
                </>
              ) : null}
              {b.kid ? (
                <>
                  {" "}
                  med KID <strong>{b.kid}</strong>
                </>
              ) : null}
              {b.frist ? ` innen ${dato(b.frist)}` : ""}.
            </>
          ) : (
            <>{kr(-b.belop)} kr til gode betales tilbake av Skatteetaten.</>
          )}
        </p>
      )}
    </>
  );
}

export function Mva({ aar, termin, velg }: { aar: string | null; termin: string | null; velg: (aar: string, termin: string) => void }) {
  const { org } = useKonto();
  const sti = `/org/${org!.id}/regnskap/mva`;
  const d = useData(() => hent<Status>(aar ? `${sti}?aar=${aar}&termin=${termin ?? 1}` : sti), [sti, aar, termin]);
  const h = useHandling();
  const [levertDato, settLevertDato] = useState(iDag());
  const [melding, settMelding] = useState<string | null>(null);
  // Merknadene brukeren velger for linjene med motsatt fortegn (per linje: koden eller «egen» med teksten).
  const [merknader, settMerknader] = useState<Record<number, { kode: string; tekst: string }>>({});
  // Sendingen slik den sist ble hentet mens appen venter på workeren (nyere enn d.data).
  const [fersk, settFersk] = useState<Innsending | null>(null);
  useEffect(() => settFersk(null), [d.data]);
  const inn = fersk && fersk.id === d.data?.innsending?.id ? fersk : (d.data?.innsending ?? null);
  const innSti = d.data ? `${sti}/${d.data.termin.aar}/${d.data.termin.termin}/innsending` : null;
  const venterNa = venter(inn);
  // Merknadene fra forrige sending for terminen (samme linjer), så de ikke må velges på nytt.
  useEffect(() => {
    const forrige = d.data?.innsending?.linjer;
    const linjer = d.data?.linjer;
    if (!forrige || !linjer || forrige.length !== linjer.length) return;
    const fra: Record<number, { kode: string; tekst: string }> = {};
    linjer.forEach((l, i) => {
      const f = forrige[i];
      if (!l.merknad_valg || !f?.merknad || f.kode !== l.kode || (f.spesifikasjon ?? null) !== l.spesifikasjon) return;
      fra[i] = "utvalgt" in f.merknad ? { kode: f.merknad.utvalgt, tekst: "" } : { kode: "egen", tekst: f.merknad.beskrivelse };
    });
    settMerknader((m) => (Object.keys(m).length ? m : fra));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.data?.innsending?.id]);
  useEffect(() => {
    if (!venterNa || !innSti || !inn) return;
    const status = inn.status;
    let stopp = false;
    const tid = window.setInterval(
      async () => {
        const r = await hent<{ innsending: Innsending | null }>(innSti).catch(() => null);
        if (stopp || !r?.innsending) return;
        settFersk(r.innsending);
        // Sendt eller feilet: terminen (levert) hentes på nytt.
        if (r.innsending.status !== status) void d.last();
      },
      status === "sender" ? 2500 : 10_000,
    );
    return () => {
      stopp = true;
      window.clearInterval(tid);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venterNa, innSti, inn?.id, inn?.status]);

  if (d.feil) return <Feil melding={d.feil} />;
  const s = d.data;
  if (!s) return <Laster />;
  const t = s.termin;
  const [na, nt] = flytt(t, 1);
  const [fa, ft] = flytt(t, -1);
  // Neste termin har begynt når dagen etter denne er i dag eller før.
  const nesteBegynt = new Date(Date.parse(`${t.til}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10) <= iDag();
  const sti2 = `${sti}/${t.aar}/${t.termin}`;
  const kjor = async (fn: () => Promise<unknown>, tekst?: (r: any) => string) => {
    settMelding(null);
    const r = await h.kjor(fn);
    if (r) {
      if (tekst) settMelding(tekst(r));
      void d.last();
    }
  };
  // Til Skatteetaten: meldingen fryses, og brukeren sendes til ID-porten (og kommer tilbake til MvaIdporten).
  const send = async () => {
    const valgt = s.linjer.map((l, i) => {
      const m = merknader[i];
      if (!l.merknad_valg || !m?.kode) return null;
      return m.kode === "egen" ? { beskrivelse: m.tekst } : { utvalgt: m.kode };
    });
    if (!confirm(`Sende mva-meldingen for ${t.navn} til Skatteetaten (${belopTekst(s.sum)})?\n\nDu logger inn med ID-porten og kommer tilbake hit mens meldingen sendes.`)) return;
    settMelding(null);
    const r = await h.kjor(() => api<{ id: string; url: string }>("POST", `${sti2}/send`, { merknader: valgt }));
    if (r) window.location.assign(r.url);
  };
  const kanSende = s.innsending_paa && s.over && (!s.levert || s.endret) && inn?.status !== "sender";
  const merknadslinjer = s.linjer.map((l, i) => [l, i] as const).filter(([l]) => l.merknad_valg);
  const sendSkjema = (
    <div className="mva-send">
      <p className="liten dempet">
        {s.levert ? "Send en korrigert melding" : "Send meldingen"} rett til Skatteetaten. Du logger inn med ID-porten, og den som logger inn, må ha rett til å sende
        mva-meldingen for {org!.navn} i Altinn (tilgangspakken «Merverdiavgift», eller regnskapsfører med signeringsrett).
      </p>
      {merknadslinjer.map(([l, i]) => {
        const m = merknader[i] ?? { kode: "", tekst: "" };
        const sett = (x: Partial<typeof m>) => settMerknader({ ...merknader, [i]: { ...m, ...x } });
        return (
          <div key={i} className="mva-merknad">
            <label>
              Merknad til kode {l.kode} ({kr(l.merverdiavgift)} kr)
              <select value={m.kode} onChange={(e) => sett({ kode: e.target.value })}>
                <option value="">Velg forklaring</option>
                {l.merknad_valg!.koder.map((k) => (
                  <option key={k.kode} value={k.kode}>
                    {k.navn}
                  </option>
                ))}
                {l.merknad_valg!.fritekst && <option value="egen">Egen forklaring</option>}
              </select>
              <span className="felt-hjelp">Linjen har motsatt fortegn av det vanlige, og Skatteetaten vil ha en forklaring.</span>
            </label>
            {m.kode === "egen" && (
              <label>
                Forklaring
                <input type="text" maxLength={4000} value={m.tekst} onChange={(e) => sett({ tekst: e.target.value })} />
              </label>
            )}
          </div>
        );
      })}
      <div className="knapper">
        <button type="button" className="primar" disabled={h.opptatt} onClick={() => void send()}>
          {s.levert ? "Send korrigert melding" : "Send til Skatteetaten"}
        </button>
      </div>
    </div>
  );
  // Merk som levert (meldingen levert i Altinn).
  const merkLevert = (
    <>
      <p className="liten dempet">Merk terminen når meldingen er levert; endres den etterpå, sier appen fra.</p>
      <div className="rad mva-levert">
        <label>
          Levert
          <input type="date" value={levertDato} max={iDag()} min={t.til} onChange={(e) => settLevertDato(e.target.value)} />
        </label>
        <button type="button" disabled={h.opptatt} onClick={() => void kjor(() => api("PUT", `${sti2}/levert`, { dato: levertDato }), () => "Merket som levert.")}>
          Merk som levert
        </button>
      </div>
    </>
  );

  return (
    <>
      <p className="dempet liten">
        Mva-meldingen regnes fra bilagene i terminen: salget med utgående avgift, kjøpene med fradrag og tjenestene kjøpt fra utlandet, etter Skatteetatens standard
        mva-koder. {s.innsending_paa ? "Send den til Skatteetaten herfra, eller lever den i Altinn med linjene under." : "Lever den i Altinn med linjene under."} Når
        terminen er over, føres oppgjøret av seg selv med månedsavslutningen (bilagserie V, avgiftskontoene mot oppgjørskontoen), og betalingen til Skatteetaten (eller
        det som kommer tilbake) føres når den kommer i banken.
      </p>
      {!s.registrert && !s.linjer.length ? (
        <div className="kort">
          <Tom ikon={<IkonRegnskap storrelse={22} />} tittel="Ikke registrert for merverdiavgift">
            <p>
              Organisasjonen er ikke registrert for merverdiavgift, og det er ingen avgift i bilagene. Er den registrert, krysser du av under{" "}
              <Link to="/innstillinger?fane=organisasjon">Innstillinger → Organisasjon</Link>.
            </p>
          </Tom>
        </div>
      ) : (
        <div className={`kort mva-termin${s.over && (!s.levert || s.endret) ? " gjenstar" : ""}`}>
          <div className="maaned-status-hode">
            <h3>Mva-melding</h3>
            <div className="ukevelger">
              <button type="button" className="ikon" aria-label="Forrige termin" title="Forrige termin" onClick={() => velg(String(fa), String(ft))}>
                <IkonVenstre storrelse={20} />
              </button>
              <div className="uke-navn" aria-live="polite">
                <strong>{t.navn.replace(/^./, (c) => c.toUpperCase())}</strong>
                <span>Frist {dato(t.frist)}</span>
              </div>
              <button type="button" className="ikon" aria-label="Neste termin" title="Neste termin" disabled={!nesteBegynt} onClick={() => velg(String(na), String(nt))}>
                <IkonHoyre storrelse={20} />
              </button>
            </div>
          </div>
          <div className="mva-sum">
            <span className="dempet">{s.sum >= 0 ? "Å betale" : "Til gode"}</span>
            <strong>{kr(Math.abs(s.sum))} kr</strong>
            <Statusmerke s={s} />
          </div>
          {melding && (
            <div className="melding ok" role="status">
              {melding}
            </div>
          )}
          {s.linjer.length ? (
            <div className="tabell">
              <table className="mva-linjer">
                <thead>
                  <tr>
                    <th>Kode</th>
                    <th className="tall">Grunnlag</th>
                    <th className="tall mva-sats">Sats</th>
                    <th className="tall">
                      <span className="mva-lang">Merverdiavgift</span>
                      <span className="mva-kort">Mva</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {s.linjer.map((l, i) => (
                    <tr key={`${l.kode}-${l.fradrag}-${i}`}>
                      <td>
                        <strong>{l.kode}</strong>
                        <div className="liten dempet">
                          {l.beskrivelse}
                          {l.fradrag && !l.spesifikasjon && ["81", "83", "86", "88", "91"].includes(l.kode) ? " (fradrag)" : ""}
                        </div>
                        {l.merknad_valg && <div className="liten mva-motsatt">Motsatt fortegn: forklares med en merknad</div>}
                      </td>
                      <td className="tall">
                        {l.grunnlag === null ? "–" : kr(l.grunnlag)}
                        {l.sats !== null && <div className="liten dempet mva-sats-under">{prosent(l.sats)}</div>}
                      </td>
                      <td className="tall mva-sats">{l.sats === null ? "–" : prosent(l.sats)}</td>
                      <td className="tall">{kr(l.merverdiavgift)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>{s.sum >= 0 ? "Å betale" : "Til gode"}</td>
                    <td />
                    <td className="mva-sats" />
                    <td className="tall">{kr(s.sum)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : (
            <p className="dempet liten">Ingen merverdiavgift i terminen; meldingen leveres likevel (med 0 kr) når organisasjonen er registrert.</p>
          )}
          {s.kontroller.length > 0 && (
            <div className="melding advarsel">
              <strong>Kontroller</strong>
              <ul>
                {s.kontroller.map((k) => (
                  <li key={k}>{k}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="mva-handlinger">
            <div>
              <strong>Oppgjøret</strong>
              <p className="liten dempet">
                {s.oppgjor.bilag
                  ? s.oppgjor.stemmer
                    ? `Bokført (${s.oppgjor.bilag.bilagsnummer}): avgiftskontoene mot oppgjørskontoen.`
                    : `Bokført (${s.oppgjor.bilag.bilagsnummer}), men terminen er endret etterpå.`
                  : !s.oppgjor.trengs
                    ? "Ingen avgift å gjøre opp."
                    : s.over
                      ? "Ikke bokført. Månedsavslutningen gjør det av seg selv, eller bokfør det nå."
                      : "Bokføres når terminen er over."}
              </p>
              {s.over && (
                <div className="knapper">
                  {s.oppgjor.trengs && !s.oppgjor.stemmer && (
                    <button
                      type="button"
                      className="primar"
                      disabled={h.opptatt}
                      onClick={() =>
                        void kjor(
                          () => api<{ bilag: { bilagsnummer: string } | null }>("POST", `${sti2}/oppgjor`, {}),
                          (r) => (r.bilag ? `Oppgjøret er bokført (${r.bilag.bilagsnummer}).` : "Oppgjøret stemte."),
                        )
                      }
                    >
                      {s.oppgjor.bilag ? "Bokfør oppgjøret på nytt" : "Bokfør oppgjøret"}
                    </button>
                  )}
                  {s.oppgjor.bilag && (
                    <button
                      type="button"
                      disabled={h.opptatt}
                      onClick={() => confirm("Angre oppgjøret? Bilaget reverseres.") && void kjor(() => api("DELETE", `${sti2}/oppgjor`), () => "Oppgjøret er angret.")}
                    >
                      Angre oppgjøret
                    </button>
                  )}
                </div>
              )}
            </div>
            <div>
              <strong>{s.innsending_paa ? "Levert til Skatteetaten" : "Levert i Altinn"}</strong>
              {inn && <Sending inn={inn} kvittering={() => void h.kjor(() => lastNed(`${sti}/innsending/${inn.id}/kvittering`, `mva-kvittering-${t.aar}-${t.termin}.pdf`))} />}
              {s.levert ? (
                <>
                  <p className="liten dempet">
                    Levert {dato(s.levert.dato)} med {belopTekst(s.levert.belop)}
                    {s.levert.av ? ` (av ${s.levert.av})` : ""}.
                    {s.endret
                      ? s.innsending_paa
                        ? ` Meldingen er endret etterpå (nå ${belopTekst(s.sum)}): send en korrigert melding, eller lever den i Altinn og merk den på nytt.`
                        : ` Meldingen er endret etterpå (nå ${belopTekst(s.sum)}): lever en korrigert melding i Altinn, og merk den på nytt.`
                      : ""}
                  </p>
                  {kanSende && sendSkjema}
                  {!s.endret && (!s.laast_til || s.laast_til < t.til) && (
                    <p className="liten dempet">
                      Lås terminen, så havner det som føres senere med en dato i terminen, i neste termin (meldingen endres ikke).{" "}
                      <button
                        type="button"
                        className="lenke"
                        disabled={h.opptatt}
                        onClick={() => void kjor(() => api("PUT", `/org/${org!.id}/regnskap/periodelas`, { til: t.til }), () => `Regnskapet er låst til og med ${dato(t.til)}.`)}
                      >
                        Lås til og med {dato(t.til)}
                      </button>
                    </p>
                  )}
                  <div className="knapper">
                    {s.endret && (
                      <button type="button" className="primar" disabled={h.opptatt} onClick={() => void kjor(() => api("PUT", `${sti2}/levert`, { dato: iDag() }), () => "Merket som levert.")}>
                        Korrigert melding levert i dag
                      </button>
                    )}
                    {/* Sendt fra appen: meldingen er hos Skatteetaten, og merket kan ikke angres. */}
                    {!(inn && (inn.status === "sendt" || inn.status === "mottatt")) && (
                      <button type="button" className="lenke" disabled={h.opptatt} onClick={() => void kjor(() => api("DELETE", `${sti2}/levert`))}>
                        Angre
                      </button>
                    )}
                  </div>
                </>
              ) : s.over ? (
                s.innsending_paa ? (
                  <>
                    {kanSende && sendSkjema}
                    <details className="mva-annen-levering">
                      <summary>Levert i Altinn i stedet?</summary>
                      {merkLevert}
                    </details>
                  </>
                ) : (
                  merkLevert
                )
              ) : (
                <p className="liten dempet">Meldingen leveres når terminen er over, senest {dato(t.frist)}.</p>
              )}
            </div>
          </div>
          <Feil melding={h.feil} />
        </div>
      )}
      {s.terminer.length > 1 && (
        <div className="kort liste mva-terminer">
          {s.terminer.map((x) => (
            <button key={x.termin} type="button" className={`liste-rad${x.termin === t.termin ? " valgt" : ""}`} onClick={() => velg(String(t.aar), String(x.termin))}>
              <span className="linje">
                <span className="tittel">{x.navn.replace(` ${t.aar}`, "").replace(/^./, (c) => c.toUpperCase())}</span>
                <span className="belop">{x.sum === null ? "" : belopTekst(x.sum)}</span>
              </span>
              <span className="linje">
                <span className="under">Frist {dato(x.frist)}</span>
                {!x.over ? (
                  <span className="merke merke-noytral">Pågår</span>
                ) : x.levert ? (
                  <span className="merke merke-ok">Levert</span>
                ) : (
                  <span className="merke merke-advarsel">Ikke levert</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
      <MvaJustering key={t.aar} aar={t.aar} endret={() => void d.last()} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Tilbake fra ID-porten
// ---------------------------------------------------------------------------

// Svaret fra API-et per innlogging (state): siden kan vises to ganger (React i utvikling, og når
// organisasjonen byttes), men koden gis bare én gang.
const behandlet = new Map<string, Promise<{ id: string; aar: number; termin: number; status: string }>>();

// ID-porten sender brukeren hit med koden (eller feilen) og state, som begynner med organisasjonens
// id. API-et legger sendingen i kø, og brukeren kommer tilbake til terminen under Regnskap → Mva.
export function MvaIdporten() {
  const nav = useNavigate();
  const [sok] = useSearchParams();
  const { velgOrg } = useKonto();
  const [feil, settFeil] = useState<string | null>(null);

  useEffect(() => {
    const state = sok.get("state");
    const orgId = state?.split(".")[0];
    if (!state || !orgId || !/^[0-9a-f-]{36}$/.test(orgId)) return void settFeil("Fikk ikke noe svar fra ID-porten. Start innsendingen på nytt under Regnskap → Mva.");
    velgOrg(orgId);
    let svar = behandlet.get(state);
    if (!svar) {
      const valgfri = (n: string) => sok.get(n) ?? undefined;
      svar = api("POST", `/org/${orgId}/regnskap/mva/idporten`, { state, code: valgfri("code"), error: valgfri("error"), error_description: valgfri("error_description") });
      behandlet.set(state, svar);
    }
    let aktiv = true;
    svar.then(
      (r) => aktiv && nav(`/regnskap?fane=mva&aar=${r.aar}&termin=${r.termin}`, { replace: true }),
      (e) => aktiv && settFeil((e as Error).message),
    );
    return () => {
      aktiv = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="kort" style={{ maxWidth: 560 }}>
      <h1 style={{ marginTop: 0 }}>Sender mva-meldingen</h1>
      {feil ? (
        <>
          <Feil melding={feil} />
          <Link className="knapp" to="/regnskap?fane=mva">
            Til Regnskap → Mva
          </Link>
        </>
      ) : (
        <>
          <p className="dempet">Innloggingen er fullført. Meldingen sendes til Skatteetaten.</p>
          <Laster />
        </>
      )}
    </div>
  );
}
