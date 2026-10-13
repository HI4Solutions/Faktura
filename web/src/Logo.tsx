// Admin Konsoll-logoen: et avrundet kvadrat delt i fire moduler der mellomrommene danner en K
// (Modul-K), og ordmerket i Schibsted Grotesk. Kilen mellom armene har aksentfargen. Fargene
// kommer fra styles.css (--logo-farge og --logo-kile), så logoen er nattblå på lys bunn og hvit
// på mørk. Samme tegning som favicon.svg, app-ikonene og filene i docs/merkevare.
import { KILE, LOGO_BREDDE, ORDMERKE, STAMME } from "./logoStier";

// Bare symbolet, f.eks. på låseskjermen.
export function LogoIkon({ storrelse = 36 }: { storrelse?: number }) {
  return (
    <svg className="logo-ikon" width={storrelse} height={storrelse} viewBox="0 0 48 48" role="img" aria-label="Admin Konsoll">
      <path d={STAMME} fill="currentColor" />
      <path className="logo-kile" d={KILE} />
    </svg>
  );
}

// Symbolet og ordmerket. `storrelse` er høyden; bredden følger av den.
export function Logo({ storrelse = 32 }: { storrelse?: number }) {
  return (
    <svg
      className="logo-merkevare"
      width={(storrelse * LOGO_BREDDE) / 48}
      height={storrelse}
      viewBox={`0 0 ${LOGO_BREDDE} 48`}
      style={{ aspectRatio: `${LOGO_BREDDE} / 48` }}
      role="img"
      aria-label="Admin Konsoll"
    >
      <path d={STAMME} fill="currentColor" />
      <path className="logo-kile" d={KILE} />
      <path d={ORDMERKE} fill="currentColor" />
    </svg>
  );
}
