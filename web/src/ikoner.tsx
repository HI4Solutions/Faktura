// Enkle strekikoner (24×24, 1.8 px strek) som arver tekstfargen.
import type { ReactNode } from "react";

function Ikon({ children, storrelse = 18 }: { children: ReactNode; storrelse?: number }) {
  return (
    <svg width={storrelse} height={storrelse} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

type P = { storrelse?: number };

export const IkonOversikt = (p: P) => (
  <Ikon {...p}>
    <rect x="3.5" y="3.5" width="7" height="8" rx="1.8" />
    <rect x="13.5" y="3.5" width="7" height="5" rx="1.8" />
    <rect x="13.5" y="11.5" width="7" height="9" rx="1.8" />
    <rect x="3.5" y="14.5" width="7" height="6" rx="1.8" />
  </Ikon>
);
export const IkonFaktura = (p: P) => (
  <Ikon {...p}>
    <path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
    <path d="M14 3v5h5M9 13h6M9 17h4" />
  </Ikon>
);
export const IkonGjenta = (p: P) => (
  <Ikon {...p}>
    <path d="M17 2.5 20 5.5l-3 3" />
    <path d="M4 11v-1.5a4 4 0 0 1 4-4h12" />
    <path d="M7 21.5 4 18.5l3-3" />
    <path d="M20 13v1.5a4 4 0 0 1-4 4H4" />
  </Ikon>
);
export const IkonKunder = (p: P) => (
  <Ikon {...p}>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
    <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8" />
  </Ikon>
);
export const IkonProdukter = (p: P) => (
  <Ikon {...p}>
    <path d="M12 2.8 20.5 7.5v9L12 21.2 3.5 16.5v-9z" />
    <path d="M3.5 7.5 12 12l8.5-4.5M12 12v9.2" />
  </Ikon>
);
export const IkonRapport = (p: P) => (
  <Ikon {...p}>
    <path d="M4 20h16" />
    <rect x="5.5" y="11" width="3" height="6" rx="1" />
    <rect x="10.5" y="6" width="3" height="11" rx="1" />
    <rect x="15.5" y="9" width="3" height="8" rx="1" />
  </Ikon>
);
export const IkonInnstillinger = (p: P) => (
  <Ikon {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </Ikon>
);
export const IkonSkjold = (p: P) => (
  <Ikon {...p}>
    <path d="M12 2.8 19.5 6v5.5c0 4.6-3.2 8.3-7.5 9.7-4.3-1.4-7.5-5.1-7.5-9.7V6z" />
    <path d="m8.8 12 2.2 2.2 4.3-4.4" />
  </Ikon>
);
export const IkonNokkel = (p: P) => (
  <Ikon {...p}>
    <circle cx="8" cy="15" r="4.5" />
    <path d="m11.2 11.8 8.3-8.3M16.5 6.5l2.5 2.5M14 9l2 2" />
  </Ikon>
);
export const IkonLoggUt = (p: P) => (
  <Ikon {...p}>
    <path d="M9 21H5.5A2.5 2.5 0 0 1 3 18.5v-13A2.5 2.5 0 0 1 5.5 3H9" />
    <path d="m16 17 5-5-5-5M21 12H9" />
  </Ikon>
);
export const IkonMeny = (p: P) => (
  <Ikon {...p}>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </Ikon>
);
export const IkonLukk = (p: P) => (
  <Ikon {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Ikon>
);
export const IkonPluss = (p: P) => (
  <Ikon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Ikon>
);
export const IkonVelg = (p: P) => (
  <Ikon {...p}>
    <path d="m8 9 4-4 4 4M8 15l4 4 4-4" />
  </Ikon>
);
export const IkonOpplasting = (p: P) => (
  <Ikon {...p}>
    <path d="M12 15V4M7.5 8.5 12 4l4.5 4.5" />
    <path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
  </Ikon>
);
export const IkonHake = (p: P) => (
  <Ikon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="m8.2 12.2 2.6 2.6 5-5.2" />
  </Ikon>
);
export const IkonKlokke = (p: P) => (
  <Ikon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Ikon>
);
export const IkonVarsel = (p: P) => (
  <Ikon {...p}>
    <path d="M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    <path d="M12 9v4M12 17h.01" />
  </Ikon>
);
export const IkonKroner = (p: P) => (
  <Ikon {...p}>
    <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
    <circle cx="12" cy="12" r="2.5" />
    <path d="M6 9.5v.01M18 14.5v.01" />
  </Ikon>
);
export const IkonUtkast = (p: P) => (
  <Ikon {...p}>
    <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" />
    <path d="m13.5 6.5 4 4" />
  </Ikon>
);
export const IkonInstaller = (p: P) => (
  <Ikon {...p}>
    <rect x="5" y="2.5" width="14" height="19" rx="2.5" />
    <path d="M12 7v7M9 11l3 3 3-3M10 18.5h4" />
  </Ikon>
);
export const IkonBjelle = (p: P) => (
  <Ikon {...p}>
    <path d="M6 9a6 6 0 1 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9z" />
    <path d="M10 20a2 2 0 0 0 4 0" />
  </Ikon>
);
