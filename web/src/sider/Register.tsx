// Kunder og produkter: liste og skjema i dialog.
import { useState, type FormEvent } from "react";
import { api, hent } from "../api";
import { Dialog, Feil, Laster, tall, useData, useHandling } from "../felles";
import { kanSkrive, useKonto } from "../konto";
import { kr, orgnr } from "../format";

export function Kunder() {
  const { org } = useKonto();
  const [sok, settSok] = useState("");
  const [redigerer, settRedigerer] = useState<any | null>(null);
  const { data, feil, laster, last } = useData(() => hent(`/org/${org!.id}/kunder${sok ? `?sok=${encodeURIComponent(sok)}` : ""}`), [org?.id, sok]);

  return (
    <>
      <div className="topp">
        <h1>Kunder</h1>
        {kanSkrive(org?.rolle) && (
          <button className="primar" onClick={() => settRedigerer({ type: "firma", aktiv: true })}>
            Ny kunde
          </button>
        )}
      </div>
      <input placeholder="Søk etter navn" value={sok} onChange={(e) => settSok(e.target.value)} style={{ maxWidth: 320, marginBottom: 12 }} />
      <Feil melding={feil} />
      {laster && !data ? (
        <Laster />
      ) : (
        <div className="kort tabell">
          <table>
            <thead>
              <tr>
                <th>Nr.</th>
                <th>Navn</th>
                <th>Org.nr.</th>
                <th>E-post</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(data ?? []).map((k: any) => (
                <tr key={k.id} className="klikkbar" onClick={() => kanSkrive(org?.rolle) && settRedigerer(k)}>
                  <td>{k.kundenummer}</td>
                  <td>{k.navn}</td>
                  <td>{orgnr(k.orgnr)}</td>
                  <td>{k.epost ?? <span className="merke merke-advarsel">Mangler e-post</span>}</td>
                  <td>{!k.aktiv && <span className="merke merke-noytral">Inaktiv</span>}</td>
                </tr>
              ))}
              {data?.length === 0 && (
                <tr>
                  <td colSpan={5} className="dempet">
                    Ingen kunder ennå.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <Dialog apen={!!redigerer} lukk={() => settRedigerer(null)} tittel={redigerer?.id ? "Endre kunde" : "Ny kunde"}>
        <KundeSkjema
          kunde={redigerer}
          lagret={() => {
            settRedigerer(null);
            last();
          }}
          avbryt={() => settRedigerer(null)}
        />
      </Dialog>
    </>
  );
}

export function KundeSkjema({ kunde, lagret, avbryt }: { kunde: any; lagret: (k: any) => void; avbryt: () => void }) {
  const { org } = useKonto();
  const [k, settK] = useState<any>({ ...kunde });
  const { opptatt, feil, kjor } = useHandling();
  const felt = (navn: string) => ({ value: k[navn] ?? "", onChange: (e: any) => settK({ ...k, [navn]: e.target.value }) });

  async function slaOpp() {
    const e = await kjor(() => hent(`/brreg/${(k.orgnr ?? "").replace(/\s/g, "")}`));
    if (e) settK({ ...k, navn: e.navn, adresse: e.adresse, postnr: e.postnr, poststed: e.poststed });
  }

  async function lagre(ev: FormEvent) {
    ev.preventDefault();
    const kropp = {
      type: k.type,
      navn: k.navn,
      orgnr: k.orgnr ? k.orgnr.replace(/\s/g, "") : null,
      adresse: k.adresse || null,
      postnr: k.postnr || null,
      poststed: k.poststed || null,
      epost: k.epost || null,
      telefon: k.telefon || null,
      deres_referanse: k.deres_referanse || null,
      notat: k.notat || null,
      aktiv: k.aktiv,
    };
    const r = await kjor(() => (k.id ? api("PATCH", `/org/${org!.id}/kunder/${k.id}`, kropp) : api("POST", `/org/${org!.id}/kunder`, kropp)));
    if (r) lagret(r);
  }

  return (
    <form onSubmit={lagre}>
      <div className="rad">
        <label>
          Type
          <select {...felt("type")}>
            <option value="firma">Firma</option>
            <option value="person">Privatperson</option>
          </select>
        </label>
        {k.type === "firma" && (
          <label>
            Org.nr.
            <div className="knapper">
              <input style={{ flex: 1 }} inputMode="numeric" {...felt("orgnr")} />
              <button type="button" onClick={slaOpp} disabled={(k.orgnr ?? "").replace(/\s/g, "").length !== 9}>
                Hent
              </button>
            </div>
          </label>
        )}
      </div>
      <label>
        Navn
        <input required {...felt("navn")} />
      </label>
      <label>
        Adresse
        <input {...felt("adresse")} />
      </label>
      <div className="rad">
        <label>
          Postnr.
          <input {...felt("postnr")} />
        </label>
        <label>
          Poststed
          <input {...felt("poststed")} />
        </label>
      </div>
      <div className="rad">
        <label>
          E-post for faktura
          <input type="email" {...felt("epost")} />
        </label>
        <label>
          Telefon
          <input {...felt("telefon")} />
        </label>
      </div>
      <label>
        Deres referanse (standard)
        <input {...felt("deres_referanse")} />
      </label>
      <label>
        Notat
        <textarea rows={2} {...felt("notat")} />
      </label>
      <label>
        <input type="checkbox" checked={k.aktiv !== false} onChange={(e) => settK({ ...k, aktiv: e.target.checked })} />
        Aktiv
      </label>
      <Feil melding={feil} />
      <div className="knapper">
        <button className="primar" disabled={opptatt}>
          Lagre
        </button>
        <button type="button" onClick={avbryt}>
          Avbryt
        </button>
      </div>
    </form>
  );
}

export function Produkter() {
  const { org } = useKonto();
  const [redigerer, settRedigerer] = useState<any | null>(null);
  const { data, feil, laster, last } = useData(() => hent(`/org/${org!.id}/produkter`), [org?.id]);

  return (
    <>
      <div className="topp">
        <h1>Produkter og tjenester</h1>
        {kanSkrive(org?.rolle) && (
          <button className="primar" onClick={() => settRedigerer({ enhet: "stk", mva_sats: 25, aktiv: true })}>
            Nytt produkt
          </button>
        )}
      </div>
      <Feil melding={feil} />
      {laster && !data ? (
        <Laster />
      ) : (
        <div className="kort tabell">
          <table>
            <thead>
              <tr>
                <th>Varenr.</th>
                <th>Navn</th>
                <th>Enhet</th>
                <th className="hoyre">Pris eks. mva</th>
                <th className="hoyre">Mva</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(data ?? []).map((p: any) => (
                <tr key={p.id} className="klikkbar" onClick={() => kanSkrive(org?.rolle) && settRedigerer(p)}>
                  <td>{p.varenummer}</td>
                  <td>{p.navn}</td>
                  <td>{p.enhet}</td>
                  <td className="tall">{kr(p.enhetspris)}</td>
                  <td className="tall">{p.mva_sats} %</td>
                  <td>{!p.aktiv && <span className="merke merke-noytral">Inaktiv</span>}</td>
                </tr>
              ))}
              {data?.length === 0 && (
                <tr>
                  <td colSpan={6} className="dempet">
                    Ingen produkter ennå.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <Dialog apen={!!redigerer} lukk={() => settRedigerer(null)} tittel={redigerer?.id ? "Endre produkt" : "Nytt produkt"}>
        <ProduktSkjema
          produkt={redigerer}
          lagret={() => {
            settRedigerer(null);
            last();
          }}
          avbryt={() => settRedigerer(null)}
        />
      </Dialog>
    </>
  );
}

function ProduktSkjema({ produkt, lagret, avbryt }: { produkt: any; lagret: () => void; avbryt: () => void }) {
  const { org } = useKonto();
  const [p, settP] = useState<any>({ ...produkt, enhetspris: produkt?.enhetspris?.toString().replace(".", ",") ?? "" });
  const { opptatt, feil, kjor } = useHandling();
  const felt = (navn: string) => ({ value: p[navn] ?? "", onChange: (e: any) => settP({ ...p, [navn]: e.target.value }) });

  async function lagre(ev: FormEvent) {
    ev.preventDefault();
    const kropp = {
      varenummer: p.varenummer || null,
      navn: p.navn,
      beskrivelse: p.beskrivelse || null,
      enhet: p.enhet || "stk",
      enhetspris: tall(String(p.enhetspris)),
      mva_sats: Number(p.mva_sats),
      aktiv: p.aktiv !== false,
    };
    const r = await kjor(() => (p.id ? api("PATCH", `/org/${org!.id}/produkter/${p.id}`, kropp) : api("POST", `/org/${org!.id}/produkter`, kropp)));
    if (r) lagret();
  }

  return (
    <form onSubmit={lagre}>
      <div className="rad">
        <label>
          Varenummer
          <input {...felt("varenummer")} />
        </label>
        <label>
          Enhet
          <input {...felt("enhet")} placeholder="stk, time, mnd" />
        </label>
      </div>
      <label>
        Navn
        <input required {...felt("navn")} />
      </label>
      <label>
        Beskrivelse
        <textarea rows={2} {...felt("beskrivelse")} />
      </label>
      <div className="rad">
        <label>
          Pris eks. mva
          <input required inputMode="decimal" {...felt("enhetspris")} />
        </label>
        <label>
          Mva-sats
          <select {...felt("mva_sats")}>
            <option value="25">25 %</option>
            <option value="15">15 %</option>
            <option value="12">12 %</option>
            <option value="0">0 % (fritatt/utenfor)</option>
          </select>
        </label>
      </div>
      <label>
        <input type="checkbox" checked={p.aktiv !== false} onChange={(e) => settP({ ...p, aktiv: e.target.checked })} />
        Aktiv
      </label>
      <Feil melding={feil} />
      <div className="knapper">
        <button className="primar" disabled={opptatt}>
          Lagre
        </button>
        <button type="button" onClick={avbryt}>
          Avbryt
        </button>
      </div>
    </form>
  );
}
