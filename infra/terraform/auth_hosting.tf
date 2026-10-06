# ---------------------------------------------------------------------------
# Identity Platform: e-post og passord, e-postbekreftelse og TOTP-MFA.
# Passkeys legges til senere (WebAuthn i API-et), se docs/arkitektur.md.
# ---------------------------------------------------------------------------

resource "google_identity_platform_config" "auth" {
  provider = google-beta
  project  = var.project_id

  autodelete_anonymous_users = true
  authorized_domains = concat([
    "localhost",
    "${var.project_id}.firebaseapp.com",
    "${var.project_id}.web.app",
    var.app_domain,
  ], var.app_domains)

  sign_in {
    allow_duplicate_emails = false

    email {
      enabled           = true
      password_required = true
    }
  }

  mfa {
    state = "ENABLED"
    provider_configs {
      state = "ENABLED"
      totp_provider_config {
        adjacent_intervals = 1
      }
    }
  }

  depends_on = [google_project_service.apis]
}

# ---------------------------------------------------------------------------
# Firebase Hosting for nettappen (React). /api/** rutes til Cloud Run i firebase.json.
# ---------------------------------------------------------------------------

resource "google_firebase_project" "this" {
  provider   = google-beta
  project    = var.project_id
  depends_on = [google_project_service.apis]
}

resource "google_firebase_hosting_site" "app" {
  provider = google-beta
  project  = var.project_id
  site_id  = var.project_id

  depends_on = [google_firebase_project.this]
}

# Web-appen gjør at Firebase Hosting serverer konfigurasjonen på /__/firebase/init.json,
# som nettappen leser ved oppstart. Ingen nøkler bygges inn i koden.
resource "google_firebase_web_app" "app" {
  provider        = google-beta
  project         = var.project_id
  display_name    = "HI4 Faktura"
  deletion_policy = "DELETE"
  depends_on      = [google_firebase_project.this]
}

# Eget domene. Terraform skriver ut DNS-oppføringene som må legges inn hos
# domeneleverandøren (output «dns_for_app_domain»). Firebase utsteder sertifikat selv.
resource "google_firebase_hosting_custom_domain" "app" {
  provider              = google-beta
  project               = var.project_id
  site_id               = google_firebase_hosting_site.app.site_id
  custom_domain         = var.app_domain
  wait_dns_verification = false
}

# ---------------------------------------------------------------------------
# Overvåking
# ---------------------------------------------------------------------------

resource "google_monitoring_notification_channel" "epost" {
  count        = var.alert_email == "" ? 0 : 1
  display_name = "Driftsvarsler faktura"
  type         = "email"
  labels = {
    email_address = var.alert_email
  }
}

resource "google_monitoring_uptime_check_config" "api" {
  display_name = "faktura-api /helse"
  timeout      = "10s"
  period       = "300s"

  http_check {
    path         = "/helse"
    port         = 443
    use_ssl      = true
    validate_ssl = true
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = trimprefix(google_cloud_run_v2_service.api.uri, "https://")
    }
  }
}

resource "google_monitoring_alert_policy" "api_nede" {
  count        = var.alert_email == "" ? 0 : 1
  display_name = "faktura-api svarer ikke"
  combiner     = "OR"

  conditions {
    display_name = "Oppetidssjekken feiler"
    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.label.check_id=\"${google_monitoring_uptime_check_config.api.uptime_check_id}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "600s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.host"]
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.epost[0].id]
}

resource "google_monitoring_alert_policy" "dlq" {
  count        = var.alert_email == "" ? 0 : 1
  display_name = "Hendelser havner i dead-letter-køen"
  combiner     = "OR"

  conditions {
    display_name = "Meldinger i hendelser-dlq"
    condition_threshold {
      filter          = "metric.type=\"pubsub.googleapis.com/subscription/num_undelivered_messages\" AND resource.type=\"pubsub_subscription\" AND resource.label.subscription_id=\"hendelser-dlq\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "300s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.epost[0].id]
}
