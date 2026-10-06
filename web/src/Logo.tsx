// HI4 Faktura-logoen: en faktura der linjene skrives, et «betalt»-merke spretter fram
// og en glans sveiper over flisen. Animasjonen ligger i styles.css (.logo-ikon) og
// stopper når brukeren har valgt redusert bevegelse.
import { useId } from "react";

export function LogoIkon({ storrelse = 36, animert = true }: { storrelse?: number; animert?: boolean }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg
      className={`logo-ikon${animert ? " animert" : ""}`}
      width={storrelse}
      height={storrelse}
      viewBox="0 0 48 48"
      role="img"
      aria-label="HI4 Faktura"
    >
      <defs>
        <linearGradient id={`${id}-flis`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3b6fe0" />
          <stop offset="1" stopColor="#1f3a73" />
        </linearGradient>
        <linearGradient id={`${id}-glans`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0.45" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <clipPath id={`${id}-klipp`}>
          <rect width="48" height="48" rx="12" />
        </clipPath>
      </defs>

      <g clipPath={`url(#${id}-klipp)`}>
        <rect width="48" height="48" fill={`url(#${id}-flis)`} />

        {/* Fakturaarket med brettet hjørne */}
        <g className="logo-ark">
          <path d="M14 9h15l6 6v22a3 3 0 0 1-3 3H14a3 3 0 0 1-3-3V12a3 3 0 0 1 3-3z" fill="#fff" />
          <path d="M29 9v4a2 2 0 0 0 2 2h4z" fill="#c9d6f2" />
        </g>

        {/* Linjene skrives inn én etter én */}
        <g stroke="#9db4e8" strokeWidth="2.4" strokeLinecap="round" fill="none">
          <path className="logo-linje l1" d="M15.5 18.5h11" pathLength="1" />
          <path className="logo-linje l2" d="M15.5 23.5h15" pathLength="1" />
          <path className="logo-linje l3" d="M15.5 28.5h8" pathLength="1" />
        </g>

        {/* Glans som sveiper over */}
        <rect className="logo-glans" x="-30" y="-10" width="18" height="70" fill={`url(#${id}-glans)`} transform="rotate(20 24 24)" />
      </g>

      {/* «Betalt»-merke */}
      <g className="logo-merke">
        <circle cx="34.5" cy="34.5" r="8" fill="#22b573" stroke="#fff" strokeWidth="2" />
        <path className="logo-hake" d="M30.8 34.7l2.5 2.5 4.6-4.9" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" pathLength="1" />
      </g>
    </svg>
  );
}

export function Logo({ storrelse = 32 }: { storrelse?: number }) {
  return (
    <span className="logo-merkevare">
      <LogoIkon storrelse={storrelse} />
      <span className="logo-tekst">
        HI4 <span>Faktura</span>
      </span>
    </span>
  );
}
