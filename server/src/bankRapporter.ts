// Banken i rapportmodulen (modulen Regnskap, bankAvstemming.ts): bankavstemmingen ved slutten av
// perioden (saldoen i banken mot kontoen i regnskapet, med postene som ikke er ført og bilagene uten
// bankpost) og bankpostene i perioden med hvordan hver er ført. Eier, administrator og regnskap
// (funksjonen «Regnskap»).
import { kontoavstemming } from "./bankAvstemming.js";
import { alle, en } from "./db.js";
import type { Rapportdef } from "./rapportmodul.js";

const krTekst = (n: number) => `${n.toLocaleString("nb-NO", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/[  ]/g, " ").replace(/−/g, "-")} kr`;
const datoTekst = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const STATUS: Record<string, string> = { avstemt: "Ført", forslag: "Forslag", uavklart: "Må avklares", ny: "Ikke vurdert" };

export const bankRapporter: Rapportdef[] = [
  {
    id: "regnskap.bankavstemming",
    modul: "regnskap",
    navn: "Bankavstemming",
    beskrivelse:
      "Saldoen i banken ved slutten av perioden mot bankkontoen i regnskapet, for hver bankkonto: bankpostene som ikke er ført i regnskapet, bilagene på bankkontoen som ikke er koblet til en bankpost, og differansen som står igjen.",
    funksjon: "regnskap",
    tilgang: "regnskap",
    parameter: "periode",
    maanedlig: true,
    hent: async (db, org, v) => {
      const kontoer = await kontoavstemming(db, org, v.til);
      const merknad = kontoer.length
        ? kontoer
            .map((k) =>
              [
                `${k.navn ? `${k.navn} ` : ""}${k.vis} (konto ${k.regnskapskonto}) ${datoTekst(k.dato)}:`,
                k.saldo === null ? "saldoen i banken er ikke kjent;" : `${krTekst(k.saldo)} i banken,`,
                `${krTekst(k.regnskap)} i regnskapet;`,
                `${k.apne.antall} bankposter er ikke ført (${krTekst(k.apne.sum)}), ${k.uten_post.antall} bilag er uten bankpost (${krTekst(k.uten_post.sum)})`,
                k.delt ? "(kontoen i regnskapet gjelder flere bankkontoer)." : k.differanse === null ? "." : `; differanse ${krTekst(k.differanse)}.`,
              ].join(" "),
            )
            .join(" ")
        : "Ingen bankposter er hentet. Koble til banken under Innstillinger → Faktura.";
      return {
        merknad,
        kolonner: [
          { nokkel: "konto", navn: "Bankkonto", type: "tekst" },
          { nokkel: "hva", navn: "Hva" },
          { nokkel: "dato", navn: "Dato", type: "dato" },
          { nokkel: "tekst", navn: "Tekst" },
          { nokkel: "belop", navn: "Beløp", type: "kr", sum: true },
        ],
        rader: kontoer.flatMap((k) => [
          ...k.apne.poster.map((p) => ({ konto: k.vis, hva: "Ikke ført i regnskapet", dato: p.dato, tekst: p.tekst, belop: p.belop })),
          ...k.uten_post.bilag.map((b) => ({ konto: k.vis, hva: `Bilag ${b.nummer} uten bankpost`, dato: b.dato, tekst: b.tekst, belop: -b.belop })),
        ]),
      };
    },
  },
  {
    id: "regnskap.bankposter",
    modul: "regnskap",
    navn: "Bankposter",
    beskrivelse: "Alle transaksjonene på bankkontoene i perioden, inn og ut, med hvordan hver er ført i regnskapet (bilaget og regelen) eller hva som mangler.",
    funksjon: "regnskap",
    tilgang: "regnskap",
    parameter: "periode",
    maanedlig: true,
    hent: async (db, org, v) => {
      const rader = await alle<{
        dato: string;
        konto: string;
        motpart: string | null;
        melding: string | null;
        belop: number;
        status: string;
        bilag: string | null;
        regel: string | null;
        auto: boolean;
        for_start: boolean;
      }>(
        db,
        `select to_char(p.dato, 'YYYY-MM-DD') as dato, p.konto, p.motpart, p.melding, p.belop::float8 as belop, p.status,
                b.serie || '-' || b.aar || '-' || b.nummer as bilag, p.regel, p.avstemt_av is null as auto,
                (r.bank_fra is not null and p.dato < r.bank_fra) as for_start
           from faktura.bankposter p
           left join faktura.bilag b on b.id = p.bilag_id
           left join faktura.regnskap_oppsett r on r.org_id = p.org_id
          where p.org_id = $1 and p.dato between $2::date and $3::date
          order by p.dato, p.konto, p.opprettet`,
        [org, v.fra, v.til],
      );
      const fort = rader.filter((r) => r.status === "avstemt");
      const auto = fort.filter((r) => r.auto);
      const apne = rader.filter((r) => r.status !== "avstemt" && !r.for_start);
      const start = (await en<{ fra: string | null }>(db, "select to_char(bank_fra, 'YYYY-MM-DD') as fra from faktura.regnskap_oppsett where org_id = $1", [org]))?.fra;
      return {
        merknad: [
          `${rader.length} bankposter i perioden: ${fort.length} er ført${auto.length ? ` (${auto.length} av seg selv)` : ""}, ${apne.length} må avklares under Regnskap → Bank.`,
          start && rader.some((r) => r.for_start) ? `Postene før ${datoTekst(start)} hører til den inngående balansen og føres ikke.` : "",
        ]
          .filter(Boolean)
          .join(" "),
        kolonner: [
          { nokkel: "dato", navn: "Dato", type: "dato" },
          { nokkel: "konto", navn: "Bankkonto", type: "tekst", pdf: false },
          { nokkel: "motpart", navn: "Motpart" },
          { nokkel: "melding", navn: "Melding" },
          { nokkel: "belop", navn: "Beløp", type: "kr", sum: true },
          { nokkel: "status", navn: "Status" },
          { nokkel: "bilag", navn: "Bilag" },
          { nokkel: "regel", navn: "Hvorfor", pdf: false },
        ],
        rader: rader.map((r) => ({
          dato: r.dato,
          konto: r.konto,
          motpart: r.motpart ?? "",
          melding: r.melding ?? "",
          belop: r.belop,
          status: r.for_start ? "Før startdatoen" : (STATUS[r.status] ?? r.status),
          bilag: r.bilag ?? "",
          regel: r.regel ?? "",
        })),
      };
    },
  },
];
