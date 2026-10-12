// Admin Konsoll-logoen: tre skyvekontroller som på et miksebord, på en flis i blått og fiolett.
// Den midterste kontrollen er mintgrønn og lyser. I appen mikser kontrollene litt med jevne
// mellomrom og en glans sveiper over flisen; animasjonen ligger i styles.css (.logo-ikon) og
// stopper når brukeren har valgt redusert bevegelse. Samme tegning som favicon.svg og app-ikonene.
import { useId } from "react";

// Kontrollene: midten av sporet (x) og knottens hvileposisjon (y), i en flis på 48 × 48.
const KONTROLLER = [
  { x: 14, y: 27.5 },
  { x: 24, y: 17 },
  { x: 34, y: 22 },
];
const AKTIV = 1; // den mintgrønne
const SPOR = { topp: 10.5, bunn: 37.5, bredde: 3.4 };
const KNOTT = { bredde: 10.4, hoyde: 6 };

export function LogoIkon({ storrelse = 36, animert = true }: { storrelse?: number; animert?: boolean }) {
  const id = useId().replace(/:/g, "");
  const { topp, bunn, bredde } = SPOR;
  return (
    <svg
      className={`logo-ikon${animert ? " animert" : ""}`}
      width={storrelse}
      height={storrelse}
      viewBox="0 0 48 48"
      role="img"
      aria-label="Admin Konsoll"
    >
      <defs>
        <linearGradient id={`${id}-flis`} x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#6489ff" />
          <stop offset="0.5" stopColor="#4a4ff0" />
          <stop offset="1" stopColor="#2a1b8e" />
        </linearGradient>
        <radialGradient id={`${id}-lys`} cx="12" cy="0" r="38" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity="0.3" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${id}-glod`}>
          <stop offset="0" stopColor="#5ef0c4" stopOpacity="0.6" />
          <stop offset="1" stopColor="#5ef0c4" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-mint`} x1="0" y1="10" x2="0" y2={bunn} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#7af7d2" />
          <stop offset="1" stopColor="#14b386" />
        </linearGradient>
        <linearGradient id={`${id}-glans`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0.35" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <clipPath id={`${id}-klipp`}>
          <rect width="48" height="48" rx="12" />
        </clipPath>
        {/* Nivået under knotten fylles bare innenfor sporet, også når knotten flytter seg. */}
        <clipPath id={`${id}-spor`}>
          {KONTROLLER.map((k) => (
            <rect key={k.x} x={k.x - bredde / 2} y={topp} width={bredde} height={bunn - topp} rx={bredde / 2} />
          ))}
        </clipPath>
      </defs>

      <rect width="48" height="48" rx="12" fill={`url(#${id}-flis)`} />
      <rect width="48" height="48" rx="12" fill={`url(#${id}-lys)`} />
      <rect x="0.5" y="0.5" width="47" height="47" rx="11.5" fill="none" stroke="#fff" strokeOpacity="0.16" />

      {/* Sporene */}
      {KONTROLLER.map((k) => (
        <rect key={k.x} x={k.x - bredde / 2} y={topp} width={bredde} height={bunn - topp} rx={bredde / 2} fill="#0a0f3d" fillOpacity="0.32" />
      ))}

      {/* Nivåene: fra knotten og ned */}
      <g clipPath={`url(#${id}-spor)`}>
        {KONTROLLER.map((k, i) => (
          <rect
            key={k.x}
            className={`logo-kontroll k${i + 1}`}
            x={k.x - bredde / 2}
            y={k.y}
            width={bredde}
            height={bunn - topp + 8}
            fill={i === AKTIV ? `url(#${id}-mint)` : "#fff"}
            fillOpacity={i === AKTIV ? 1 : 0.72}
          />
        ))}
      </g>

      {/* Gløden rundt den mintgrønne knotten */}
      <g className={`logo-kontroll k${AKTIV + 1}`}>
        <circle className="logo-glod" cx={KONTROLLER[AKTIV].x} cy={KONTROLLER[AKTIV].y} r="11.5" fill={`url(#${id}-glod)`} />
      </g>

      {/* Knottene, med skygge og rille */}
      {KONTROLLER.map((k, i) => (
        <g key={k.x} className={`logo-kontroll k${i + 1}`}>
          <rect x={k.x - KNOTT.bredde / 2} y={k.y - KNOTT.hoyde / 2 + 1.2} width={KNOTT.bredde} height={KNOTT.hoyde} rx={KNOTT.hoyde / 2} fill="#070b33" fillOpacity="0.3" />
          <rect x={k.x - KNOTT.bredde / 2} y={k.y - KNOTT.hoyde / 2} width={KNOTT.bredde} height={KNOTT.hoyde} rx={KNOTT.hoyde / 2} fill={i === AKTIV ? "#5ef0c4" : "#fff"} />
          <path
            d={`M${k.x - KNOTT.bredde / 4} ${k.y}h${KNOTT.bredde / 2}`}
            stroke={i === AKTIV ? "#0a6a4e" : "#2b3a8f"}
            strokeOpacity="0.42"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </g>
      ))}

      {/* Glans som sveiper over */}
      <g clipPath={`url(#${id}-klipp)`}>
        <rect className="logo-glans" x="-30" y="-10" width="18" height="70" fill={`url(#${id}-glans)`} transform="rotate(20 24 24)" />
      </g>
    </svg>
  );
}

export function Logo({ storrelse = 32 }: { storrelse?: number }) {
  return (
    <span className="logo-merkevare">
      <LogoIkon storrelse={storrelse} />
      <span className="logo-tekst">
        Admin <span>Konsoll</span>
      </span>
    </span>
  );
}
