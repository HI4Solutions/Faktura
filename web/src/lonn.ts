// Felles for lønnssidene (sider/Lonn.tsx og sider/LonnAar.tsx): månedsnavn og PDF-er i en ny fane.
import { api } from "./api";

export const MND = ["januar", "februar", "mars", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "desember"];
export const maaned = (periode: string) => `${MND[Number(periode.slice(5, 7)) - 1]} ${periode.slice(0, 4)}`;

// En PDF fra API-et i en ny fane (fanen åpnes med en gang, så nettleseren ikke stopper den).
export async function apnePdf(sti: string) {
  const vindu = window.open("", "_blank");
  try {
    const blob = await api<Blob>("GET", sti);
    const url = URL.createObjectURL(blob);
    if (vindu) vindu.location.href = url;
    else window.location.href = url;
  } catch (e) {
    vindu?.close();
    throw e;
  }
}
