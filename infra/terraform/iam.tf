# Én tjenestekonto per tjeneste, med bare de rettighetene den trenger.

resource "google_service_account" "api" {
  account_id   = "faktura-api"
  display_name = "Faktura API (Cloud Run)"
}

resource "google_service_account" "worker" {
  account_id   = "faktura-worker"
  display_name = "Faktura worker: PDF, e-post, gjentakelser, integrasjoner"
}

resource "google_service_account" "migrate" {
  account_id   = "faktura-migrate"
  display_name = "Faktura databasemigrering (Cloud Run job)"
}

resource "google_service_account" "invoker" {
  account_id   = "faktura-invoker"
  display_name = "Cloud Scheduler, Cloud Tasks og Pub/Sub push mot workeren"
}

locals {
  run_sas = {
    api     = google_service_account.api.email
    worker  = google_service_account.worker.email
    migrate = google_service_account.migrate.email
  }
}

resource "google_project_iam_member" "sql_client" {
  for_each = local.run_sas
  project  = var.project_id
  role     = "roles/cloudsql.client"
  member   = "serviceAccount:${each.value}"
}

resource "google_project_iam_member" "sql_instance_user" {
  for_each = { api = local.run_sas.api, worker = local.run_sas.worker }
  project  = var.project_id
  role     = "roles/cloudsql.instanceUser"
  member   = "serviceAccount:${each.value}"
}

resource "google_project_iam_member" "log_writer" {
  for_each = local.run_sas
  project  = var.project_id
  role     = "roles/logging.logWriter"
  member   = "serviceAccount:${each.value}"
}

# API-et legger jobber i køen og publiserer hendelser; worker publiserer utboksen.
resource "google_cloud_tasks_queue_iam_member" "api_enqueue" {
  name     = google_cloud_tasks_queue.utsending.name
  location = var.region
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:${google_service_account.api.email}"
}

resource "google_cloud_tasks_queue_iam_member" "worker_enqueue" {
  name     = google_cloud_tasks_queue.utsending.name
  location = var.region
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:${google_service_account.worker.email}"
}

# For å lage OIDC-tokens på vegne av invoker-kontoen når oppgaver legges i køen.
resource "google_service_account_iam_member" "act_as_invoker" {
  for_each           = { api = local.run_sas.api, worker = local.run_sas.worker }
  service_account_id = google_service_account.invoker.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${each.value}"
}

resource "google_pubsub_topic_iam_member" "worker_publish" {
  topic  = google_pubsub_topic.hendelser.name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${google_service_account.worker.email}"
}

# Pub/Sub sin tjenesteagent finnes ikke før den blir bedt om; lag den eksplisitt.
resource "google_project_service_identity" "pubsub" {
  provider   = google-beta
  project    = var.project_id
  service    = "pubsub.googleapis.com"
  depends_on = [google_project_service.apis]
}

# Pub/Sub må kunne lage tokens for push og flytte meldinger til dead-letter.
resource "google_service_account_iam_member" "pubsub_token_creator" {
  service_account_id = google_service_account.invoker.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_project_service_identity.pubsub.email}"
}

resource "google_pubsub_topic_iam_member" "dlq_publish" {
  topic  = google_pubsub_topic.hendelser_dlq.name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${google_project_service_identity.pubsub.email}"
}

# Identity Platform: API-et verifiserer tokens og kan sette egne claims.
resource "google_project_iam_member" "api_firebase_auth" {
  project = var.project_id
  role    = "roles/firebaseauth.admin"
  member  = "serviceAccount:${google_service_account.api.email}"
}

resource "google_project_iam_member" "api_recaptcha" {
  project = var.project_id
  role    = "roles/recaptchaenterprise.agent"
  member  = "serviceAccount:${google_service_account.api.email}"
}

# Signerte URL-er (V4) uten nøkkelfil: tjenestekontoen signerer via IAM Credentials.
resource "google_service_account_iam_member" "self_sign" {
  for_each           = { api = google_service_account.api, worker = google_service_account.worker }
  service_account_id = each.value.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${each.value.email}"
}
