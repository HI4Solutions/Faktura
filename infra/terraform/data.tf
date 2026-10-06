# ---------------------------------------------------------------------------
# Cloud SQL for PostgreSQL
# ---------------------------------------------------------------------------

resource "google_sql_database_instance" "db" {
  name                = "faktura-db"
  database_version    = "POSTGRES_16"
  region              = var.region
  deletion_protection = true

  settings {
    tier              = var.db_tier
    edition           = "ENTERPRISE"
    availability_type = var.db_ha ? "REGIONAL" : "ZONAL"
    disk_autoresize   = true
    disk_type         = "PD_SSD"
    user_labels       = local.labels

    ip_configuration {
      ipv4_enabled                                  = false
      private_network                               = google_compute_network.vpc.id
      enable_private_path_for_google_cloud_services = true
      ssl_mode                                      = "ENCRYPTED_ONLY"
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "02:00"
      transaction_log_retention_days = 7
      backup_retention_settings {
        retained_backups = 30
      }
    }

    maintenance_window {
      day  = 7
      hour = 3
    }

    insights_config {
      query_insights_enabled = true
    }

    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }
    database_flags {
      name  = "log_min_duration_statement"
      value = "500"
    }
  }

  depends_on = [google_service_networking_connection.private_services]
}

resource "google_sql_database" "faktura" {
  name     = "faktura"
  instance = google_sql_database_instance.db.name
}

# Migreringsbrukeren eier tabellene. Passordet ligger bare i Secret Manager.
resource "random_password" "migrator" {
  length  = 32
  special = false
}

resource "google_sql_user" "migrator" {
  name     = "migrator"
  instance = google_sql_database_instance.db.name
  password = random_password.migrator.result
}

# API og worker logger inn med IAM (ingen passord). Rollene faktura_app og
# faktura_system gis av migreringsjobben.
resource "google_sql_user" "api" {
  name     = trimsuffix(google_service_account.api.email, ".gserviceaccount.com")
  instance = google_sql_database_instance.db.name
  type     = "CLOUD_IAM_SERVICE_ACCOUNT"
}

resource "google_sql_user" "worker" {
  name     = trimsuffix(google_service_account.worker.email, ".gserviceaccount.com")
  instance = google_sql_database_instance.db.name
  type     = "CLOUD_IAM_SERVICE_ACCOUNT"
}

# ---------------------------------------------------------------------------
# Cloud Storage
# ---------------------------------------------------------------------------

# PDF-er av utstedte fakturaer og kreditnotaer. Kilden til sannhet for oppbevaring.
resource "google_storage_bucket" "fakturaer" {
  name                        = "${var.project_id}-fakturaer"
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  labels                      = local.labels

  versioning {
    enabled = true
  }

  retention_policy {
    retention_period = var.faktura_retention_days * 86400
    is_locked        = var.faktura_retention_locked
  }

  lifecycle_rule {
    condition {
      age = 30
    }
    action {
      type          = "SetStorageClass"
      storage_class = "NEARLINE"
    }
  }

  lifecycle_rule {
    condition {
      age = 365
    }
    action {
      type          = "SetStorageClass"
      storage_class = "COLDLINE"
    }
  }
}

# Logoer, vedlegg og utkast-PDF-er. Ingen oppbevaringslås.
resource "google_storage_bucket" "filer" {
  name                        = "${var.project_id}-filer"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  labels                      = local.labels

  lifecycle_rule {
    condition {
      age            = 1
      matches_prefix = ["tmp/"]
    }
    action {
      type = "Delete"
    }
  }
}

resource "google_storage_bucket_iam_member" "fakturaer_worker" {
  bucket = google_storage_bucket.fakturaer.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.worker.email}"
}

resource "google_storage_bucket_iam_member" "fakturaer_api_read" {
  bucket = google_storage_bucket.fakturaer.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.api.email}"
}

resource "google_storage_bucket_iam_member" "filer" {
  for_each = { api = google_service_account.api.email, worker = google_service_account.worker.email }
  bucket   = google_storage_bucket.filer.name
  role     = "roles/storage.objectAdmin"
  member   = "serviceAccount:${each.value}"
}

# ---------------------------------------------------------------------------
# Secret Manager og KMS
# ---------------------------------------------------------------------------

locals {
  # Hemmeligheter som fylles inn manuelt (gcloud secrets versions add ...).
  manuelle_hemmeligheter = {
    "resend-api-key"             = [google_service_account.worker.email]
    "google-oauth-client-secret" = [google_service_account.api.email, google_service_account.worker.email]
  }
}

resource "google_secret_manager_secret" "manuell" {
  for_each  = local.manuelle_hemmeligheter
  secret_id = each.key
  labels    = local.labels
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
  depends_on = [google_project_service.apis]
}

# Cloud Run starter ikke hvis en hemmelighet mangler versjon. Plassholderen gjør at
# tjenestene kommer opp; den ekte verdien legges til som en ny versjon («latest»).
resource "google_secret_manager_secret_version" "plassholder" {
  for_each    = local.manuelle_hemmeligheter
  secret      = google_secret_manager_secret.manuell[each.key].id
  secret_data = "ikke-satt"

  lifecycle {
    ignore_changes = [secret_data, enabled]
  }
}

resource "google_secret_manager_secret_iam_member" "manuell" {
  for_each = merge([
    for s, sas in local.manuelle_hemmeligheter : { for sa in sas : "${s}/${sa}" => { secret = s, sa = sa } }
  ]...)
  secret_id = google_secret_manager_secret.manuell[each.value.secret].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${each.value.sa}"
}

resource "google_secret_manager_secret" "migrator_password" {
  secret_id = "db-migrator-password"
  labels    = local.labels
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "migrator_password" {
  secret      = google_secret_manager_secret.migrator_password.id
  secret_data = random_password.migrator.result
}

resource "google_secret_manager_secret_iam_member" "migrator_password" {
  secret_id = google_secret_manager_secret.migrator_password.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.migrate.email}"
}

# Krypterer OAuth refresh tokens (Google Disk) og nøkler til regnskapssystemer
# før de lagres i databasen.
resource "google_kms_key_ring" "faktura" {
  name       = "faktura"
  location   = var.region
  depends_on = [google_project_service.apis]
}

resource "google_kms_crypto_key" "tokens" {
  name            = "integrasjonstokens"
  key_ring        = google_kms_key_ring.faktura.id
  rotation_period = "7776000s" # 90 dager

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_kms_crypto_key_iam_member" "api_encrypt" {
  crypto_key_id = google_kms_crypto_key.tokens.id
  role          = "roles/cloudkms.cryptoKeyEncrypter"
  member        = "serviceAccount:${google_service_account.api.email}"
}

resource "google_kms_crypto_key_iam_member" "worker_decrypt" {
  crypto_key_id = google_kms_crypto_key.tokens.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_service_account.worker.email}"
}
