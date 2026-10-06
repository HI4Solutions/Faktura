import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

// Henter data og gir laster/feil/last-på-nytt.
export function useData<T>(fn: () => Promise<T>, avhengigheter: unknown[]) {
  const [data, settData] = useState<T | undefined>();
  const [feil, settFeil] = useState<string | null>(null);
  const [laster, settLaster] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const last = useCallback(async () => {
    settLaster(true);
    settFeil(null);
    try {
      settData(await fnRef.current());
    } catch (e) {
      settFeil((e as Error).message);
    } finally {
      settLaster(false);
    }
  }, []);

  useEffect(() => {
    last();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, avhengigheter);

  return { data, feil, laster, last, settData };
}

// Kjører en handling og viser feilmeldingen hvis den feiler.
export function useHandling() {
  const [opptatt, settOpptatt] = useState(false);
  const [feil, settFeil] = useState<string | null>(null);
  const kjor = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    settOpptatt(true);
    settFeil(null);
    try {
      return await fn();
    } catch (e) {
      settFeil((e as Error).message);
      return undefined;
    } finally {
      settOpptatt(false);
    }
  }, []);
  return { opptatt, feil, settFeil, kjor };
}

export function Feil({ melding }: { melding: string | null | undefined }) {
  if (!melding) return null;
  return (
    <div className="melding feil" role="alert">
      {melding}
    </div>
  );
}

export function Laster() {
  return (
    <div className="laster" role="status">
      <span className="spinner" /> Laster …
    </div>
  );
}

// Tom tilstand i lister: ikon, kort forklaring og gjerne en handling.
export function Tom({ ikon, tittel, children }: { ikon?: ReactNode; tittel: string; children?: ReactNode }) {
  return (
    <div className="tom">
      {ikon && <div className="ikonboks">{ikon}</div>}
      <strong>{tittel}</strong>
      {children}
    </div>
  );
}

export function Dialog({ apen, lukk, tittel, children }: { apen: boolean; lukk: () => void; tittel: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (apen && !d.open) d.showModal();
    if (!apen && d.open) d.close();
  }, [apen]);
  return (
    <dialog ref={ref} onClose={lukk} onCancel={lukk}>
      <div className="dialog-topp">
        <h2>{tittel}</h2>
        <button type="button" aria-label="Lukk" onClick={lukk}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
      <div className="dialog-innhold">{apen && children}</div>
    </dialog>
  );
}

// Tall-felt som tåler norsk desimalkomma.
export function tall(v: string): number {
  return Number(v.replace(/\s/g, "").replace(",", "."));
}
