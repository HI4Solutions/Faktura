// Konfigurasjon fra miljøvariabler. I Cloud Run settes de av Terraform (infra/terraform/run.tf).

function valgfri(navn: string): string | undefined {
  const v = process.env[navn];
  return v && v.length > 0 ? v : undefined;
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

  // Kun for lokal utvikling og tester: godta «x-test-bruker» i stedet for et ekte token.
  testInnlogging: process.env.AUTH_TEST === "1" && process.env.NODE_ENV !== "production",
};
