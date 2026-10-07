// Nøkler og hemmeligheter (API-nøkler, applikasjons-ID-er, private nøkler) er skjult som
// standard. Øyet viser dem.
import { useState, type InputHTMLAttributes } from "react";
import { IkonOye, IkonOyeAv } from "./ikoner";

function Oye({ vis, bytt }: { vis: boolean; bytt: () => void }) {
  const tekst = vis ? "Skjul" : "Vis";
  return (
    <button type="button" className="oye" aria-label={tekst} aria-pressed={vis} title={tekst} onClick={bytt}>
      {vis ? <IkonOyeAv /> : <IkonOye />}
    </button>
  );
}

type Felt = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type">;

// Felt for en nøkkel: skjult mens den skrives eller limes inn.
export function HemmeligFelt({ verdi, endre, ...rest }: { verdi: string; endre: (v: string) => void } & Felt) {
  const [vis, settVis] = useState(false);
  return (
    <span className="hemmelig-felt">
      <input
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        data-1p-ignore
        data-lpignore="true"
        {...rest}
        type={vis ? "text" : "password"}
        value={verdi}
        onChange={(e) => endre(e.target.value)}
      />
      <Oye vis={vis} bytt={() => settVis(!vis)} />
    </span>
  );
}

// En lagret nøkkel i teksten.
export function HemmeligTekst({ verdi }: { verdi: string }) {
  const [vis, settVis] = useState(false);
  return (
    <span className="hemmelig-tekst">
      <code className="hemmelig">{vis ? verdi : "••••••••••"}</code>
      <Oye vis={vis} bytt={() => settVis(!vis)} />
    </span>
  );
}
