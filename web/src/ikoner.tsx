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
// Regnskapsbok: regnskapet (anleggsmidler og saldoavskrivninger).
export const IkonRegnskap = (p: P) => (
  <Ikon {...p}>
    <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H18a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H6.5A1.5 1.5 0 0 1 5 18.5z" />
    <path d="M5 17.5A1.5 1.5 0 0 1 6.5 16H19" />
    <path d="M9 7.5h6M9 10.5h6" />
  </Ikon>
);
// Lommebok: lønn og lønnsslipper.
export const IkonLonn = (p: P) => (
  <Ikon {...p}>
    <path d="M5 7.5V6.2A2.2 2.2 0 0 1 7.2 4h10.3" />
    <rect x="3.5" y="7.5" width="17" height="12.5" rx="2.2" />
    <path d="M20.5 11.5h-3.8a2 2 0 0 0 0 4h3.8" />
    <path d="M16.8 13.5h.01" />
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
export const IkonBinders = (p: P) => (
  <Ikon {...p}>
    <path d="M20.5 11.5l-8.2 8.2a5.2 5.2 0 0 1-7.4-7.4l8.6-8.6a3.5 3.5 0 0 1 5 5l-8.6 8.6a1.75 1.75 0 0 1-2.5-2.5l7.9-7.9" />
  </Ikon>
);
export const IkonSkjerm = (p: P) => (
  <Ikon {...p}>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8.5 20h7M12 16v4" />
  </Ikon>
);
export const IkonSol = (p: P) => (
  <Ikon {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
  </Ikon>
);
export const IkonMaane = (p: P) => (
  <Ikon {...p}>
    <path d="M20 14.6A8.2 8.2 0 0 1 9.4 4a8.2 8.2 0 1 0 10.6 10.6z" />
  </Ikon>
);
export const IkonKopier = (p: P) => (
  <Ikon {...p}>
    <rect x="8.5" y="8.5" width="12" height="12" rx="2.2" />
    <path d="M15.5 8.5V5.7a2.2 2.2 0 0 0-2.2-2.2H5.7a2.2 2.2 0 0 0-2.2 2.2v7.6a2.2 2.2 0 0 0 2.2 2.2h2.8" />
  </Ikon>
);
export const IkonOye = (p: P) => (
  <Ikon {...p}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="3" />
  </Ikon>
);
export const IkonOyeAv = (p: P) => (
  <Ikon {...p}>
    <path d="M10 5.7A9.3 9.3 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.4 3.2M6.5 7.3C4 9 2.5 12 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4.9-1.4" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M3.5 3.5l17 17" />
  </Ikon>
);
// AI: gnister.
export const IkonGnist = (p: P) => (
  <Ikon {...p}>
    <path d="M10 3.5c.5 3.6 2.4 5.5 6 6-3.6.5-5.5 2.4-6 6-.5-3.6-2.4-5.5-6-6 3.6-.5 5.5-2.4 6-6z" />
    <path d="M18 13.5c.3 1.9 1.1 2.7 3 3-1.9.3-2.7 1.1-3 3-.3-1.9-1.1-2.7-3-3 1.9-.3 2.7-1.1 3-3z" />
  </Ikon>
);
export const IkonMikrofon = (p: P) => (
  <Ikon {...p}>
    <rect x="9" y="2.5" width="6" height="11.5" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v4M8.5 21.5h7" />
  </Ikon>
);
export const IkonKamera = (p: P) => (
  <Ikon {...p}>
    <path d="M3.5 8.5a2 2 0 0 1 2-2h2.2l1.6-2.5h5.4l1.6 2.5h2.2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    <circle cx="12" cy="13" r="3.5" />
  </Ikon>
);
export const IkonTastatur = (p: P) => (
  <Ikon {...p}>
    <rect x="2.5" y="5.5" width="19" height="13" rx="2.5" />
    <path d="M6.5 9.5h.01M10 9.5h.01M13.5 9.5h.01M17 9.5h.01M6.5 12.5h.01M17 12.5h.01M10 12.5h4M8 15.5h8" />
  </Ikon>
);
export const IkonAnsatte = (p: P) => (
  <Ikon {...p}>
    <rect x="3" y="5" width="18" height="14.5" rx="2.2" />
    <circle cx="8.8" cy="11" r="2.2" />
    <path d="M5.6 16.3a3.4 3.4 0 0 1 6.4 0M14.5 10h3.5M14.5 13.5h3.5" />
  </Ikon>
);
export const IkonVenstre = (p: P) => (
  <Ikon {...p}>
    <path d="m14.5 6-6 6 6 6" />
  </Ikon>
);
export const IkonHoyre = (p: P) => (
  <Ikon {...p}>
    <path d="m9.5 6 6 6-6 6" />
  </Ikon>
);
export const IkonKalender = (p: P) => (
  <Ikon {...p}>
    <rect x="3.5" y="5" width="17" height="15.5" rx="2.2" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
  </Ikon>
);
// Mine vakter: kalenderen med en hake.
export const IkonMineVakter = (p: P) => (
  <Ikon {...p}>
    <rect x="3.5" y="5" width="17" height="15.5" rx="2.2" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
    <path d="M9 15.2l2 2 4-4.2" />
  </Ikon>
);
export const IkonTavle = (p: P) => (
  <Ikon {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2.2" />
    <path d="M3 9.5h18M9 9.5V20M15 9.5V20" />
  </Ikon>
);
export const IkonRullering = (p: P) => (
  <Ikon {...p}>
    <path d="M20.5 4v5.5H15" />
    <path d="M3.5 20v-5.5H9" />
    <path d="M5.3 9.2a7.5 7.5 0 0 1 12.4-3l2.8 3.3" />
    <path d="M3.5 14.5l2.8 3.3a7.5 7.5 0 0 0 12.4-3" />
  </Ikon>
);
export const IkonOpp = (p: P) => (
  <Ikon {...p}>
    <path d="m6 14.5 6-6 6 6" />
  </Ikon>
);
export const IkonNed = (p: P) => (
  <Ikon {...p}>
    <path d="m6 9.5 6 6 6-6" />
  </Ikon>
);
export const IkonFerie = (p: P) => (
  <Ikon {...p}>
    <rect x="3.5" y="7.5" width="17" height="12" rx="2.2" />
    <path d="M9 7.5V5.6A1.6 1.6 0 0 1 10.6 4h2.8A1.6 1.6 0 0 1 15 5.6v1.9M8 7.5v12M16 7.5v12" />
  </Ikon>
);
