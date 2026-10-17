// Konfigurasjon fra miljøvariabler. I Cloud Run settes de av Terraform (infra/terraform/run.tf).

function valgfri(navn: string): string | undefined {
  const v = process.env[navn];
  return v && v.length > 0 ? v : undefined;
}

// Kommaseparerte adresser, uten skråstrek til slutt.
function adresser(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((a) => a.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

// I produksjon må APP_URL være satt: den bestemmer passkey-domenet og lenkene i e-post.
// Mangler den, starter ikke tjenesten, og Cloud Run beholder forrige revisjon.
if (process.env.NODE_ENV === "production" && !valgfri("APP_URL")) {
  throw new Error("APP_URL må være satt i produksjon");
}

export const config = {
  rolle: (valgfri("ROLLE") ?? "api") as "api" | "worker",
  port: Number(valgfri("PORT") ?? 8080),
  produksjon: process.env.NODE_ENV === "production",

  prosjekt: valgfri("PROJECT_ID"),
  region: valgfri("REGION") ?? "europe-north1",

  // Database: Cloud SQL med IAM-innlogging i skyen, DATABASE_URL lokalt og i tester.
  dbInstans: valgfri("DB_INSTANCE"),
  dbNavn: valgfri("DB_NAME") ?? "faktura",
  dbBruker: valgfri("DB_USER"),
  databaseUrl: valgfri("DATABASE_URL"),

  fakturaBucket: valgfri("FAKTURA_BUCKET"),
  filerBucket: valgfri("FILER_BUCKET"),
  tasksKo: valgfri("TASKS_QUEUE"),
  tasksInvokerSa: valgfri("TASKS_INVOKER_SA"),
  workerUrl: valgfri("WORKER_URL"),
  pubsubTopic: valgfri("PUBSUB_TOPIC"),

  appUrl: valgfri("APP_URL") ?? "http://localhost:5173",
  // Andre adresser den samme appen svarer på (kommaseparert), f.eks. det nye domenet før det blir
  // hoveddomenet, eller det gamle etter flyttingen. Det brukeren gjør i nettleseren (passkeys,
  // tilbakeadressene fra banken, Altinn og Google) følger adressen brukeren er på (appadresse.ts).
  andreAppUrler: adresser(valgfri("ANDRE_APP_URLER")),
  // De av dem appen er flyttet fra: der vises en melding om den nye adressen.
  gamleAppUrler: adresser(valgfri("GAMLE_APP_URLER")),
  epostAvsender: valgfri("EPOST_AVSENDER") ?? "post@adminkonsoll.no",
  // Brukes når Resend sier at avsenderdomenet over ikke er verifisert (tjenester.ts), så e-posten
  // likevel går.
  epostAvsenderReserve: valgfri("EPOST_AVSENDER_RESERVE") ?? "faktura@hi4.no",
  resendNokkel: valgfri("RESEND_API_KEY"),
  resendWebhookHemmelighet: valgfri("RESEND_WEBHOOK_SECRET"),
  googleClientId: valgfri("GOOGLE_OAUTH_CLIENT_ID"),
  googleClientSecret: valgfri("GOOGLE_OAUTH_CLIENT_SECRET"),
  kmsNokkel: valgfri("KMS_KEY"),
  // Google Picker (mappevalg i nettleseren): offentlig API-nøkkel og prosjektnummer.
  googlePickerNokkel: valgfri("GOOGLE_PICKER_NOKKEL"),
  googleProsjektnummer: valgfri("GOOGLE_PROSJEKTNUMMER"),

  // Oppslag i PEPPOL (DNS og SMP) om kunder kan motta EHF. Slås av i testene.
  ehfOppslag: valgfri("EHF_OPPSLAG") !== "av",
  // Aksesspunktet EHF sendes gjennom. Hver organisasjon bruker sin egen konto der.
  recommandUrl: valgfri("RECOMMAND_URL") ?? "https://app.recommand.eu",
  // Open banking: innbetalinger leses fra organisasjonens egen bankkonto gjennom Enable
  // Banking. Hver organisasjon bruker sin egen applikasjon der.
  enableBankingUrl: valgfri("ENABLE_BANKING_URL") ?? "https://api.enablebanking.com",

  // Skatteetaten (skattekort til arbeidsgiver) gjennom Maskinporten og systembruker i Altinn.
  // Leverandøren av løsningen har én Maskinporten-klient og ett system i Altinns
  // systemregister; hver organisasjon gir systemet tilgang i Altinn. Uten klient er
  // funksjonen avslått. Nøkkelen (privat RSA-nøkkel, PEM) har bare workeren.
  skatteetatenMiljo: (valgfri("SKATTEETATEN_MILJO") === "prod" ? "prod" : "test") as "test" | "prod",
  maskinportenKlientId: valgfri("MASKINPORTEN_KLIENT_ID"),
  maskinportenNokkelId: valgfri("MASKINPORTEN_NOKKEL_ID"),
  maskinportenNokkel: ((v) => (v && v !== "ikke-satt" ? v : undefined))(valgfri("MASKINPORTEN_NOKKEL")),
  leverandorOrgnr: valgfri("LEVERANDOR_ORGNR") ?? "936564046", // Medinnova AS
  altinnSystemId: valgfri("ALTINN_SYSTEM_ID"),
  // Navnet kunden ser i Altinn når tilgangen godkjennes.
  altinnSystemnavn: valgfri("ALTINN_SYSTEMNAVN") ?? "Admin Konsoll",
  // A-meldingen til Skatteetatens API (docs/amelding.md): på når Medinnova AS har fått scopet
  // skatteetaten:innrapporteringamelding. Da ber systemet også om tilgangspakken «A-ordningen».
  // Uten: a-meldingen lastes ned som XML og lastes opp på skatteetaten.no.
  ameldingInnsending: ["1", "true", "ja"].includes((valgfri("AMELDING_INNSENDING") ?? "").toLowerCase()),
  // Adressene (standard etter miljøet over); settes i tester.
  maskinportenUrl: valgfri("MASKINPORTEN_URL"),
  altinnUrl: valgfri("ALTINN_URL"),
  skattekortUrl: valgfri("SKATTEKORT_URL"),
  ameldingUrl: valgfri("AMELDING_URL"),
  // Avstemmingsrapporten for a-meldingen (ansatte fra a-ordningen, aordning.ts); samme scope og
  // tilgangspakke som innsendingen.
  avstemmingUrl: valgfri("AVSTEMMING_URL"),
  // Sykepenger fra NAV (docs/nav.md): sykmeldingene og forespørslene om inntektsmelding hentes, og
  // inntektsmeldingen sendes, når Medinnova AS har lagt scopet nav:helseytelser/sykepenger på
  // Maskinporten-klienten. Da ber systemet også om tilgangspakken «Lønn med personopplysninger av
  // særlig kategori». Adressen følger miljøet; den kan overstyres (tester).
  navSykepenger: ["1", "true", "ja"].includes((valgfri("NAV_SYKEPENGER") ?? "").toLowerCase()),
  navUrl: valgfri("NAV_SYKEPENGER_URL"),
  // Krav og betalinger og frister fra Skatteetaten (docs/skatteetaten-krav.md): på når Medinnova
  // AS har lagt scopene skatteetaten:kravogbetalinger og skatteetaten:frister på
  // Maskinporten-klienten. Da ber systemet også om tilgangspakken «Krav, betalinger og utlegg», og
  // Regnskap får fanen «Skatteetaten». Adressene følger miljøet; de kan overstyres (tester).
  kravOgFrister: ["1", "true", "ja"].includes((valgfri("KRAV_OG_FRISTER") ?? "").toLowerCase()),
  kravUrl: valgfri("KRAV_OG_BETALINGER_URL"),
  fristerUrl: valgfri("FRISTER_URL"),
  // Årsregnskapet til Brønnøysundregistrene gjennom Altinn (docs/aarsregnskap.md): på når Medinnova
  // AS har lagt scopene altinn:instances.read og altinn:instances.write på Maskinporten-klienten. Da
  // ber systemet også om tilgangspakken «Regnskap og økonomirapportering», og årsregnskapet kan sendes
  // til signering i Altinn. Adressen til Brønnøysunds app følger miljøet; den kan overstyres (tester).
  aarsregnskapInnsending: ["1", "true", "ja"].includes((valgfri("AARSREGNSKAP_INNSENDING") ?? "").toLowerCase()),
  brregAppUrl: valgfri("BRREG_APP_URL"),

  // AI: Gemini på Vertex AI i prosjektet (uten prosjekt er AI-funksjonene skjult), i EU.
  // Regionen kan også være multiregionen «eu» eller «global».
  aiProsjekt: valgfri("AI_PROSJEKT"),
  aiRegion: valgfri("AI_REGION") ?? "europe-west3",
  aiModell: valgfri("AI_MODELL") ?? "gemini-3.5-flash",
  // Høyst så mange AI-forespørsler per organisasjon per måned (tak på kostnaden).
  aiGrense: Math.max(0, Math.floor(Number(valgfri("AI_GRENSE") ?? 1000))) || 1000,

  // Plattformadministratorer (e-post, kommaseparert). Kan verifisere og sperre organisasjoner.
  adminEposter: (valgfri("ADMIN_EPOSTER") ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),

  // Kun i tester: egen tilkobling som workerens rolle, se scripts/test-db.sh.
  systemDatabaseUrl: process.env.NODE_ENV !== "production" ? valgfri("SYSTEM_DATABASE_URL") : undefined,

  // Kun for lokal utvikling og tester: godta «x-test-bruker» i stedet for et ekte token.
  testInnlogging: process.env.AUTH_TEST === "1" && process.env.NODE_ENV !== "production",
};
