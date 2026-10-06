# ---------------------------------------------------------------------------
# Cloud Run
#   api     offentlig REST-API for nettappen, kundeportalen og åpent API
#   worker  internt: PDF, e-post, gjentakelser, utboks, integrasjoner
#   migrate jobb som kjører databasemigreringene ved hver utrulling
#
# Terraform lager tjenestene med et startbilde; CI ruller ut nye bilder.
# ---------------------------------------------------------------------------

locals {
  db_env = {
    PROJECT_ID             = var.project_id
    REGION                 = var.region
    DB_INSTANCE            = google_sql_database_instance.db.connection_name
    DB_NAME                = google_sql_database.faktura.name
    FAKTURA_BUCKET         = google_storage_bucket.fakturaer.name
    FILER_BUCKET           = google_storage_bucket.filer.name
    KMS_KEY                = google_kms_crypto_key.tokens.id
    TASKS_QUEUE            = google_cloud_tasks_queue.utsending.id
    TASKS_INVOKER_SA       = google_service_account.invoker.email
    PUBSUB_TOPIC           = google_pubsub_topic.hendelser.id
    APP_URL                = "https://${var.app_domain}"
    GOOGLE_OAUTH_CLIENT_ID = var.google_oauth_client_id
    EPOST_AVSENDER         = var.epost_avsender
    TZ                     = "Europe/Oslo"
    NODE_ENV               = "production"
  }
}

resource "google_cloud_run_v2_service" "api" {
  name     = "faktura-api"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"
  labels   = local.labels

  template {
    service_account = google_service_account.api.email

    scaling {
      min_instance_count = 0
      max_instance_count = 10
    }

    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.vpc.id
        subnetwork = google_compute_subnetwork.run.id
      }
    }

    containers {
      image = var.placeholder_image

      dynamic "env" {
        for_each = merge(local.db_env, {
          ROLLE         = "api"
          ADMIN_EPOSTER = var.admin_eposter
          DB_USER       = google_sql_user.api.name
          WORKER_URL    = google_cloud_run_v2_service.worker.uri
          # Google Picker (mappevalg for Disk) kjører i nettleseren; nøkkelen er offentlig
          # og begrenset til Picker API og appens domener.
          GOOGLE_PICKER_NOKKEL  = google_apikeys_key.picker.key_string
          GOOGLE_PROSJEKTNUMMER = data.google_project.this.number
        })
        content {
          name  = env.key
          value = env.value
        }
      }

      env {
        name = "GOOGLE_OAUTH_CLIENT_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.manuell["google-oauth-client-secret"].secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "RESEND_WEBHOOK_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.manuell["resend-webhook-secret"].secret_id
            version = "latest"
          }
        }
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle = true
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].containers[0].image, client, client_version]
  }

  depends_on = [google_secret_manager_secret_iam_member.manuell, google_secret_manager_secret_version.plassholder]
}

# Autentisering skjer i API-et (Identity Platform-tokens og API-nøkler).
resource "google_cloud_run_v2_service_iam_member" "api_public" {
  name     = google_cloud_run_v2_service.api.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service" "worker" {
  name     = "faktura-worker"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL" # Scheduler, Tasks og Pub/Sub kommer utenfra VPC; IAM krever OIDC-token.
  labels   = local.labels

  template {
    service_account = google_service_account.worker.email
    timeout         = "300s"

    scaling {
      min_instance_count = 0
      max_instance_count = 5
    }

    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.vpc.id
        subnetwork = google_compute_subnetwork.run.id
      }
    }

    containers {
      image = var.placeholder_image

      dynamic "env" {
        for_each = merge(local.db_env, { ROLLE = "worker", DB_USER = google_sql_user.worker.name })
        content {
          name  = env.key
          value = env.value
        }
      }

      env {
        name = "RESEND_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.manuell["resend-api-key"].secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "GOOGLE_OAUTH_CLIENT_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.manuell["google-oauth-client-secret"].secret_id
            version = "latest"
          }
        }
      }

      # PDF-generering med headless Chromium trenger minne.
      resources {
        limits = {
          cpu    = "2"
          memory = "2Gi"
        }
        cpu_idle = true
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].containers[0].image, client, client_version]
  }

  depends_on = [google_secret_manager_secret_iam_member.manuell, google_secret_manager_secret_version.plassholder]
}

resource "google_cloud_run_v2_service_iam_member" "worker_invoker" {
  for_each = {
    invoker = google_service_account.invoker.email
    api     = google_service_account.api.email
  }
  name     = google_cloud_run_v2_service.worker.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${each.value}"
}

resource "google_cloud_run_v2_job" "migrate" {
  name     = "faktura-migrate"
  location = var.region
  labels   = local.labels

  template {
    template {
      service_account = google_service_account.migrate.email
      max_retries     = 0
      timeout         = "600s"

      vpc_access {
        egress = "PRIVATE_RANGES_ONLY"
        network_interfaces {
          network    = google_compute_network.vpc.id
          subnetwork = google_compute_subnetwork.run.id
        }
      }

      containers {
        image = var.placeholder_image

        env {
          name  = "DB_HOST"
          value = google_sql_database_instance.db.private_ip_address
        }
        env {
          name  = "DB_NAME"
          value = google_sql_database.faktura.name
        }
        env {
          name  = "DB_USER"
          value = google_sql_user.migrator.name
        }
        env {
          name  = "API_DB_USER"
          value = google_sql_user.api.name
        }
        env {
          name  = "WORKER_DB_USER"
          value = google_sql_user.worker.name
        }
        env {
          name = "DB_PASSWORD"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.migrator_password.secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].template[0].containers[0].image, client, client_version]
  }

  depends_on = [google_secret_manager_secret_iam_member.migrator_password]
}

# ---------------------------------------------------------------------------
# Køer, hendelser og planlagte jobber
# ---------------------------------------------------------------------------

# Utsending av fakturaer (PDF + e-post) med gjentatte forsøk.
resource "google_cloud_tasks_queue" "utsending" {
  name     = "utsending"
  location = var.jobs_region

  rate_limits {
    max_dispatches_per_second = 10
    max_concurrent_dispatches = 10
  }

  retry_config {
    max_attempts       = 8
    min_backoff        = "10s"
    max_backoff        = "3600s"
    max_doublings      = 5
    max_retry_duration = "86400s"
  }

  depends_on = [google_project_service.apis]
}

# Hendelser fra utboksen (faktura.utstedt, betaling.registrert, ...). Hver
# integrasjon (regnskap, webhooks, Google Disk) får sitt eget abonnement.
resource "google_pubsub_topic" "hendelser" {
  name                       = "hendelser"
  labels                     = local.labels
  message_retention_duration = "604800s"
  depends_on                 = [google_project_service.apis]
}

resource "google_pubsub_topic" "hendelser_dlq" {
  name       = "hendelser-dlq"
  labels     = local.labels
  depends_on = [google_project_service.apis]
}

resource "google_pubsub_subscription" "hendelser_dlq" {
  name                       = "hendelser-dlq"
  topic                      = google_pubsub_topic.hendelser_dlq.id
  message_retention_duration = "1209600s"
}

locals {
  integrasjoner = ["google-disk", "regnskap", "webhooks"]
}

resource "google_pubsub_subscription" "integrasjon" {
  for_each             = toset(local.integrasjoner)
  name                 = "hendelser-${each.key}"
  topic                = google_pubsub_topic.hendelser.id
  ack_deadline_seconds = 120

  push_config {
    push_endpoint = "${google_cloud_run_v2_service.worker.uri}/hendelser/${each.key}"
    oidc_token {
      service_account_email = google_service_account.invoker.email
    }
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.hendelser_dlq.id
    max_delivery_attempts = 10
  }
}

resource "google_pubsub_subscription_iam_member" "dlq_ack" {
  for_each     = google_pubsub_subscription.integrasjon
  subscription = each.value.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_project_service_identity.pubsub.email}"
}

locals {
  jobber = {
    # Daglig: planlagte utkast, gjentakende fakturaer. 07:05 norsk tid.
    gjenta = { schedule = "5 7 * * *", path = "/jobber/gjenta" }
    # Hvert minutt: publiser utboksen til Pub/Sub.
    utboks = { schedule = "* * * * *", path = "/jobber/utboks" }
    # Daglig: hent banktransaksjoner og match på KID (når bankintegrasjonen er på).
    bank = { schedule = "15 6 * * *", path = "/jobber/bank" }
  }
}

resource "google_cloud_scheduler_job" "jobb" {
  for_each         = local.jobber
  name             = "faktura-${each.key}"
  region           = var.jobs_region
  schedule         = each.value.schedule
  time_zone        = "Europe/Oslo"
  attempt_deadline = "300s"

  http_target {
    http_method = "POST"
    uri         = "${google_cloud_run_v2_service.worker.uri}${each.value.path}"
    oidc_token {
      service_account_email = google_service_account.invoker.email
      audience              = google_cloud_run_v2_service.worker.uri
    }
  }

  retry_config {
    retry_count = 1
  }

  depends_on = [google_project_service.apis]
}
