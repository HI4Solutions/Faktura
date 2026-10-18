// Merknadene Skatteetaten godtar på en linje i mva-meldingen som har motsatt fortegn av det som er
// vanlig for linjen (regel R020 og R021: salg og utgående avgift er positive, fradrag negative, og
// justeringen for kapitalvarer positiv). Fra kodelisten merknadTilsvarendeMvaKode (alminnelig
// næring), med navnene fra kodelisten merknad. «fritekstfelt» betyr at en egen forklaring også godtas.
// Kilde: https://github.com/Skatteetaten/mva-meldingen (docs/informasjonsmodell_filer/kodelister,
// Apache License 2.0), hentet oktober 2026. Generert fra kodelistene; lag filen på nytt når de endres.

// Navnet brukeren ser på hver merknad.
export const MERKNAD_NAVN: Record<string, string> = {
  "anskaffelser foretatt før mva registrering": "Anskaffelser foretatt før mva registrering (tilbakegående avgiftsoppgjør)",
  "avvikende fakturering": "Avvikende fakturering",
  "feil i regnskapsprogram": "Feil i regnskapsprogram",
  "feil mva-kode brukt tidligere": "Feil mva-kode brukt tidligere",
  "kreditnota": "Kreditnota",
  "omberegning eller retur": "Omberegning eller retur",
  "omsetning før registrering": "Omsetning før registrering",
  "periodisering": "Periodisering",
  "store anskaffelser": "Store anskaffelser",
  "tolldeklarasjon på feil organisasjonsnummer": "Tolldeklarasjon på feil organisasjonsnummer",
};

// Nøkkel: «kode|fortegn|spesifikasjon», med fortegnet linjen har (+ eller -).
export const MERKNADER_MOTSATT: Record<string, string[]> = {
  "1|+|": ["feil i regnskapsprogram", "feil mva-kode brukt tidligere", "fritekstfelt", "kreditnota", "periodisering", "avvikende fakturering"],
  "1|-|justering": ["fritekstfelt"],
  "3|-|": ["fritekstfelt", "feil i regnskapsprogram", "feil mva-kode brukt tidligere", "kreditnota", "omsetning før registrering", "periodisering", "avvikende fakturering"],
  "5|-|": ["fritekstfelt", "feil i regnskapsprogram", "feil mva-kode brukt tidligere", "kreditnota", "omsetning før registrering", "periodisering", "avvikende fakturering"],
  "6|-|": ["fritekstfelt", "feil i regnskapsprogram", "feil mva-kode brukt tidligere", "kreditnota", "omsetning før registrering", "periodisering", "avvikende fakturering"],
  "11|+|": ["feil i regnskapsprogram", "feil mva-kode brukt tidligere", "kreditnota", "periodisering", "fritekstfelt", "avvikende fakturering"],
  "12|+|": ["anskaffelser foretatt før mva registrering", "feil i regnskapsprogram", "feil mva-kode brukt tidligere", "kreditnota", "periodisering", "store anskaffelser", "fritekstfelt", "avvikende fakturering"],
  "13|+|": ["feil i regnskapsprogram", "feil mva-kode brukt tidligere", "kreditnota", "periodisering", "fritekstfelt", "avvikende fakturering"],
  "14|+|": ["feil i regnskapsprogram", "feil mva-kode brukt tidligere", "periodisering", "fritekstfelt", "avvikende fakturering", "omberegning eller retur", "tolldeklarasjon på feil organisasjonsnummer"],
  "15|+|": ["feil i regnskapsprogram", "feil mva-kode brukt tidligere", "periodisering", "fritekstfelt", "avvikende fakturering", "omberegning eller retur", "tolldeklarasjon på feil organisasjonsnummer"],
  "31|-|": ["feil i regnskapsprogram", "feil mva-kode brukt tidligere", "kreditnota", "omsetning før registrering", "periodisering", "fritekstfelt", "avvikende fakturering"],
  "32|-|": ["feil i regnskapsprogram", "feil mva-kode brukt tidligere", "kreditnota", "periodisering", "fritekstfelt", "avvikende fakturering"],
  "33|-|": ["feil i regnskapsprogram", "feil mva-kode brukt tidligere", "kreditnota", "omsetning før registrering", "periodisering", "fritekstfelt", "avvikende fakturering"],
  "51|-|": ["feil i regnskapsprogram", "feil mva-kode brukt tidligere", "kreditnota", "periodisering", "fritekstfelt", "avvikende fakturering"],
  "52|-|": ["feil i regnskapsprogram", "feil mva-kode brukt tidligere", "kreditnota", "periodisering", "tolldeklarasjon på feil organisasjonsnummer", "fritekstfelt", "avvikende fakturering"],
  "81|+|": ["feil mva-kode brukt tidligere", "kreditnota", "fritekstfelt", "periodisering", "avvikende fakturering", "feil i regnskapsprogram", "omberegning eller retur", "tolldeklarasjon på feil organisasjonsnummer"],
  "81|-|": ["feil i regnskapsprogram", "fritekstfelt", "avvikende fakturering", "periodisering", "feil mva-kode brukt tidligere", "omberegning eller retur", "tolldeklarasjon på feil organisasjonsnummer"],
  "81|-|justering": ["fritekstfelt"],
  "82|-|": ["feil i regnskapsprogram", "feil mva-kode brukt tidligere", "periodisering", "avvikende fakturering", "fritekstfelt", "omberegning eller retur", "tolldeklarasjon på feil organisasjonsnummer"],
  "83|+|": ["feil i regnskapsprogram", "feil mva-kode brukt tidligere", "avvikende fakturering", "fritekstfelt", "omsetning før registrering", "kreditnota", "periodisering", "omberegning eller retur", "tolldeklarasjon på feil organisasjonsnummer"],
  "83|-|": ["feil i regnskapsprogram", "avvikende fakturering", "fritekstfelt", "periodisering", "feil mva-kode brukt tidligere", "omberegning eller retur", "tolldeklarasjon på feil organisasjonsnummer"],
  "84|-|": ["feil i regnskapsprogram", "feil mva-kode brukt tidligere", "periodisering", "avvikende fakturering", "fritekstfelt", "omberegning eller retur", "tolldeklarasjon på feil organisasjonsnummer"],
  "85|-|": ["feil i regnskapsprogram", "feil mva-kode brukt tidligere", "periodisering", "avvikende fakturering", "fritekstfelt", "omberegning eller retur", "tolldeklarasjon på feil organisasjonsnummer"],
  "86|+|": ["feil i regnskapsprogram", "feil mva-kode brukt tidligere", "periodisering", "avvikende fakturering", "fritekstfelt", "kreditnota"],
  "86|-|": ["feil i regnskapsprogram", "avvikende fakturering", "fritekstfelt", "feil mva-kode brukt tidligere", "kreditnota", "periodisering"],
  "87|-|": ["kreditnota", "periodisering", "fritekstfelt", "avvikende fakturering", "feil mva-kode brukt tidligere", "feil i regnskapsprogram"],
  "88|+|": ["feil i regnskapsprogram", "feil mva-kode brukt tidligere", "kreditnota", "omsetning før registrering", "periodisering", "avvikende fakturering", "fritekstfelt"],
  "88|-|": ["feil i regnskapsprogram", "avvikende fakturering", "fritekstfelt", "feil mva-kode brukt tidligere", "kreditnota", "periodisering"],
  "89|-|": ["feil i regnskapsprogram", "feil mva-kode brukt tidligere", "kreditnota", "periodisering", "avvikende fakturering", "fritekstfelt"],
  "91|+|": ["kreditnota", "periodisering", "avvikende fakturering", "feil mva-kode brukt tidligere", "feil i regnskapsprogram", "fritekstfelt"],
  "91|-|": ["feil i regnskapsprogram", "feil mva-kode brukt tidligere", "kreditnota", "omsetning før registrering", "periodisering", "avvikende fakturering", "fritekstfelt"],
  "92|-|": ["feil i regnskapsprogram", "feil mva-kode brukt tidligere", "kreditnota", "omsetning før registrering", "periodisering", "avvikende fakturering", "fritekstfelt"],
};
