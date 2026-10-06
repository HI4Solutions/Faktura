// Innstillinger for appen (installering) og push-varsler på denne og andre enheter.
import { useEffect, useState } from "react";
import { api, ApiFeil, hent } from "../api";
import { Feil, useData, useHandling } from "../felles";
import { dato } from "../format";
import { IkonBjelle, IkonInstaller } from "../ikoner";
import { usePwa } from "../Pwa";
import { erInstallert, erIos, hentAbonnement, installer, pushStotte, slaAvVarsler, slaPaVarsler } from "../pwa";
import { useKonto } from "../konto";
import { foreslattNavn, leggTilPasskey, passkeyFeil } from "../passkey";
import { bekreftMedServer, biometriNavn, hentPasskeyIder, lagreLaas, lesLaas, lyttPaLaas, merkAktiv, stotterApplaas } from "../applaas";
import { settTema, useTema, type Tema } from "../tema";

// Lyst, mørkt eller som systemet, på denne enheten (samme valg som bryteren i toppfeltet).
function UtseendeValg() {
  const tema = useTema();
  const valg: [Tema, string][] = [
    ["system", "System"],
    ["lys", "Lys"],
    ["mork", "Mørk"],
  ];
  return (
    <>
      <h3>Utseende</h3>
      <div className="faner utseende" role="radiogroup" aria-label="Utseende">
        {valg.map(([v, navn]) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={tema === v}
            className={tema === v ? "valgt" : undefined}
            onClick={() => settTema(v)}
          >
            {navn}
          </button>
        ))}
      </div>
      <p className="dempet liten">«System» følger innstillingen på enheten, også når den bytter mellom lyst og mørkt. Valget gjelder denne enheten.</p>
    </>
  );
}

const LAASETIDER: [number, string][] = [
  [0, "Hver gang appen åpnes"],
  [1, "Etter 1 minutt i bakgrunnen"],
  [5, "Etter 5 minutter i bakgrunnen"],
  [15, "Etter 15 minutter i bakgrunnen"],
  [60, "Etter 1 time i bakgrunnen"],
];

// Applås per enhet: Face ID / Touch ID (eller Windows Hello) når appen åpnes.
function AppLaasValg() {
  const { meg, bruker } = useKonto();
  const id = meg!.bruker.id;
  const [laas, settLaas] = useState(() => lesLaas(id));
  const [stotte, settStotte] = useState<boolean | null>(null);
  const [trengerPasskey, settTrengerPasskey] = useState(false);
  const [minutter, settMinutter] = useState(laas?.minutter ?? 5);
  const h = useHandling();
  const navn = biometriNavn();

  useEffect(() => {
    stotterApplaas().then(settStotte);
  }, []);
  useEffect(() => lyttPaLaas(() => settLaas(lesLaas(id))), [id]);

  // Låsen låses opp med kontoens passkeys; den som nettopp ble brukt, er alltid med.
  const aktiver = async (brukt: string) => {
    const alle = await hentPasskeyIder().catch(() => [] as string[]);
    merkAktiv(); // først, så appen ikke låses i det låsen slås på
    lagreLaas({ bruker: id, uid: bruker?.uid, minutter, legitimasjon: alle.includes(brukt) ? alle : [brukt, ...alle] });
    settTrengerPasskey(false);
  };

  const slaPa = () =>
    h.kjor(async () => {
      try {
        await aktiver(await bekreftMedServer());
        return true;
      } catch (e) {
        if (e instanceof ApiFeil && e.status === 409) {
          settTrengerPasskey(true);
          throw new Error("Du har ingen passkey ennå. Lag en på denne enheten, så kan du bruke " + navn + " til å låse opp appen.");
        }
        if ((e as Error).name === "NotAllowedError") {
          settTrengerPasskey(true);
          throw new Error(`Det ble avbrutt, eller det finnes ingen passkey for kontoen din på denne enheten. Lag en her om nødvendig.`);
        }
        throw e;
      }
    });

  const lagPasskey = () =>
    h.kjor(async () => {
      let p: { id: string };
      try {
        p = await leggTilPasskey(foreslattNavn());
      } catch (e) {
        throw new Error(passkeyFeil(e));
      }
      await aktiver(p.id);
      return true;
    });

  const endreTid = (m: number) => {
    settMinutter(m);
    if (laas) lagreLaas({ ...laas, minutter: m });
  };

  if (stotte === null) return null;

  return (
    <>
      <h3>Applås</h3>
      {!stotte ? (
        <p className="dempet liten">
          Denne enheten har ikke Face ID, Touch ID, Windows Hello eller annen skjermlås som nettleseren kan bruke til å låse appen.
        </p>
      ) : (
        <>
          <p className="dempet liten">
            Krev {navn} for å åpne HI4 Faktura på denne enheten, så ingen andre ser fakturaene om de får tak i telefonen eller PC-en din.
            {navn} starter av seg selv når appen åpnes. Låsen bruker passkeyen din på enheten.
          </p>
          <label>
            Lås
            <select value={minutter} onChange={(e) => endreTid(Number(e.target.value))}>
              {LAASETIDER.map(([m, tekst]) => (
                <option key={m} value={m}>
                  {tekst}
                </option>
              ))}
            </select>
          </label>
          <div className="knapper">
            {laas ? (
              <>
                <span className="merke merke-ok">På for denne enheten</span>
                <button className="lenke" disabled={h.opptatt} onClick={() => lagreLaas(null)}>
                  Slå av
                </button>
              </>
            ) : (
              <button className="primar" data-passkey disabled={h.opptatt} onClick={slaPa}>
                Slå på applås med {navn}
              </button>
            )}
            {trengerPasskey && !laas && (
              <button data-passkey disabled={h.opptatt} onClick={lagPasskey}>
                Lag passkey på denne enheten
              </button>
            )}
          </div>
        </>
      )}
      <Feil melding={h.feil} />
    </>
  );
}

interface PushData {
  nokkel: string | null;
  typer: Record<string, string>;
  valg: Record<string, boolean>;
  abonnementer: { id: string; endpoint: string; enhet: string | null; opprettet: string; sist_sendt: string | null }[];
}

export function AppOgVarsler() {
  const { data, last } = useData(() => hent<PushData>("/push"), []);
  const { kanInstallere } = usePwa();
  const [denne, settDenne] = useState<string | null>(null); // endepunktet til denne enheten
  const [tillatelse, settTillatelse] = useState(typeof Notification === "undefined" ? "default" : Notification.permission);
  const [testSendt, settTestSendt] = useState(false);
  const h = useHandling();
  const stotte = pushStotte();

  useEffect(() => {
    hentAbonnement().then((s) => settDenne(s?.endpoint ?? null));
  }, []);

  const paDenne = Boolean(denne && data?.abonnementer.some((a) => a.endpoint === denne));

  const slaPa = () =>
    h
      .kjor(async () => {
        const sub = await slaPaVarsler(data!.nokkel!);
        settDenne(sub.endpoint);
        return true;
      })
      .finally(() => {
        settTillatelse(Notification.permission);
        last();
      });
  const slaAv = () =>
    h
      .kjor(async () => {
        await slaAvVarsler();
        settDenne(null);
        return true;
      })
      .then(last);
  const test = () =>
    h.kjor(async () => {
      await api("POST", "/push/test");
      settTestSendt(true);
      setTimeout(() => settTestSendt(false), 6000);
      return true;
    });
  const velg = (type: string, pa: boolean) => h.kjor(() => api("PUT", "/push/valg", { [type]: pa })).then(last);
  const fjern = (id: string) => h.kjor(async () => (await api("DELETE", `/push/abonnement/${id}`), true)).then(last);

  return (
    <>
      <div className="kort">
        <h2 style={{ marginTop: 0 }}>App</h2>
        {erInstallert() ? (
          <p className="dempet liten">HI4 Faktura er installert som app på denne enheten.</p>
        ) : kanInstallere ? (
          <>
            <p className="dempet liten">Installer HI4 Faktura som en app på denne enheten, med eget ikon og vindu.</p>
            <button onClick={() => void installer()}>
              <IkonInstaller storrelse={16} /> Installer appen
            </button>
          </>
        ) : erIos() ? (
          <p className="dempet liten">
            Trykk på Del-knappen <span aria-hidden="true">⎋</span> i Safari og velg <strong>«Legg til på Hjem-skjerm»</strong> for å
            bruke HI4 Faktura som en app. Da kan du også få push-varsler.
          </p>
        ) : (
          <p className="dempet liten">
            Du kan installere HI4 Faktura som en app fra nettleserens meny («Installer app» eller «Legg til på startskjermen»).
          </p>
        )}
        <UtseendeValg />
        <AppLaasValg />
      </div>

      <div className="kort">
        <h2 style={{ marginTop: 0 }}>Varsler</h2>
        <p className="dempet liten">Få beskjed på telefonen eller PC-en når noe skjer med fakturaene, også når appen er lukket.</p>

        {stotte === "installer" ? (
          <div className="melding info">
            På iPhone og iPad må appen først legges til på Hjem-skjermen (se over). Åpne den derfra og slå på varsler.
          </div>
        ) : stotte === "nei" ? (
          <div className="melding info">Denne nettleseren støtter ikke push-varsler.</div>
        ) : !data ? null : !data.nokkel ? (
          <div className="melding info">Push-varsler er ikke satt opp på plattformen ennå.</div>
        ) : (
          <>
            {tillatelse === "denied" && !paDenne && (
              <div className="melding feil">
                Varsler er blokkert for denne siden. Tillat varsler i nettleserens innstillinger (ofte via hengelåsen ved adressefeltet), og
                last siden på nytt.
              </div>
            )}
            <div className="knapper">
              {paDenne ? (
                <>
                  <span className="merke merke-ok">På for denne enheten</span>
                  <button disabled={h.opptatt} onClick={test}>
                    Send testvarsel
                  </button>
                  <button className="lenke" disabled={h.opptatt} onClick={slaAv}>
                    Slå av her
                  </button>
                </>
              ) : (
                <button className="primar" disabled={h.opptatt || tillatelse === "denied"} onClick={slaPa}>
                  <IkonBjelle storrelse={16} /> Slå på varsler på denne enheten
                </button>
              )}
            </div>
            {testSendt && <p className="liten dempet" style={{ marginTop: 8 }}>Testvarselet er sendt. Det kommer i løpet av noen sekunder.</p>}
          </>
        )}

        {data && data.abonnementer.length > 0 && (
          <>
            <p className="liten" style={{ margin: "16px 0 0", fontWeight: 600 }}>
              Varsle meg om
            </p>
            <div className="valgliste">
              {Object.entries(data.typer).map(([type, navn]) => (
                <label key={type}>
                  <input type="checkbox" checked={data.valg[type] !== false} disabled={h.opptatt} onChange={(e) => velg(type, e.target.checked)} />
                  {navn}
                </label>
              ))}
            </div>
            <p className="liten" style={{ margin: "8px 0 0", fontWeight: 600 }}>
              Enheter med varsler
            </p>
            <ul className="enheter">
              {data.abonnementer.map((a) => (
                <li key={a.id}>
                  <span>
                    {a.enhet ?? "Ukjent enhet"}
                    {a.endpoint === denne && <span className="denne">denne</span>}
                    <span className="dempet liten" style={{ display: "block" }}>
                      Lagt til {dato(a.opprettet)}
                      {a.sist_sendt ? ` · siste varsel ${dato(a.sist_sendt)}` : ""}
                    </span>
                  </span>
                  <button className="lenke" disabled={h.opptatt} onClick={() => (a.endpoint === denne ? slaAv() : fjern(a.id))}>
                    Fjern
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        <Feil melding={h.feil} />
      </div>
    </>
  );
}
