// Konfigurasjon fra miljøvariabler. I Cloud Run settes de av Terraform (infra/terraform/run.tf).

function valgfri(navn: string): string | undefined {
  const v = process.env[navn];
  return v && v.length > 0 ? v : undefined;
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
  epostAvsender: valgfri("EPOST_AVSENDER") ?? "faktura@hi4.no",
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
  altinnSystemnavn: valgfri("ALTINN_SYSTEMNAVN") ?? "HI4 Faktura",
  // Adressene (standard etter miljøet over); settes i tester.
  maskinportenUrl: valgfri("MASKINPORTEN_URL"),
  altinnUrl: valgfri("ALTINN_URL"),
  skattekortUrl: valgfri("SKATTEKORT_URL"),

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
