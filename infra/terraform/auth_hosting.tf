# ---------------------------------------------------------------------------
# Identity Platform: e-post og passord, e-postbekreftelse og TOTP-MFA.
# Passkeys legges til senere (WebAuthn i API-et), se docs/arkitektur.md.
# ---------------------------------------------------------------------------

locals {
  # Domenene appen svarer på: hoveddomenet, de andre og dem den er flyttet fra (docs/domene.md).
  app_domener = distinct(concat([var.app_domain], var.app_domains, var.gamle_domener))

  # Siden i Firebase Hosting hvert eget domene ligger på: nettstedets domene på standardsiden, og
  # appens domener på appens egen side. Så lenge appens hoveddomene er nettstedets domene (før
  # flyttingen til app.<domene>), ligger det på standardsiden, som da har appen (docs/domene.md).
  egne_domener = {
    for d in distinct(compact(concat([var.nettsted_domene], local.app_domener))) :
    d => d == var.nettsted_domene ? google_firebase_hosting_site.standard.site_id : google_firebase_hosting_site.appen.site_id
  }
}

resource "google_identity_platform_config" "auth" {
  provider = google-beta
  project  = var.project_id

  autodelete_anonymous_users = true
  # Også nettstedets domene: der ligger appen under /app (scripts/publiser-hosting.sh), og e-postene
  # fra Identity Platform (glemt passord, bekreftelsen) sender brukeren tilbake dit.
  authorized_domains = distinct(compact(concat([
    "localhost",
    "${var.project_id}.firebaseapp.com",
    "${var.project_id}.web.app",
    "${google_firebase_hosting_site.appen.site_id}.firebaseapp.com",
    "${google_firebase_hosting_site.appen.site_id}.web.app",
    var.nettsted_domene,
  ], local.app_domener)))

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
# Firebase Hosting: nettstedet (landingsside/) på standardsiden og nettappen (React) på sin egen
# side. /api/** rutes til Cloud Run i begge (firebase.json). scripts/publiser-hosting.sh
# publiserer dem (docs/domene.md).
# ---------------------------------------------------------------------------

resource "google_firebase_project" "this" {
  provider   = google-beta
  project    = var.project_id
  depends_on = [google_project_service.apis]
}

# Standardsiden (heter som prosjektet). Den har nettstedet, og appen til den har flyttet til sitt
# eget domene.
resource "google_firebase_hosting_site" "standard" {
  provider = google-beta
  project  = var.project_id
  site_id  = var.project_id

  depends_on = [google_firebase_project.this]
}

moved {
  from = google_firebase_hosting_site.app
  to   = google_firebase_hosting_site.standard
}

# Appens egen side (<prosjekt>-app). Web-appen er knyttet til den, så /__/firebase/init.json
# virker også her.
resource "google_firebase_hosting_site" "appen" {
  provider = google-beta
  project  = var.project_id
  site_id  = "${var.project_id}-app"
  app_id   = google_firebase_web_app.app.app_id

  depends_on = [google_firebase_project.this]
}

# Web-appen gjør at Firebase Hosting serverer konfigurasjonen på /__/firebase/init.json,
# som nettappen leser ved oppstart. Ingen nøkler bygges inn i koden.
resource "google_firebase_web_app" "app" {
  provider        = google-beta
  project         = var.project_id
  display_name    = "Admin Konsoll"
  deletion_policy = "DELETE"
  depends_on      = [google_firebase_project.this]
}

# Egne domener. Terraform skriver ut DNS-oppføringene som må legges inn hos domeneleverandøren
# (output «dns_for_domener»), og Firebase utsteder sertifikat selv når de er på plass. Nøkkelen er
# domenenavnet, så hoveddomenet kan byttes uten at noe lages på nytt, og et domene blir liggende
# på samme side når appen flytter (docs/domene.md).
resource "google_firebase_hosting_custom_domain" "domene" {
  for_each              = local.egne_domener
  provider              = google-beta
  project               = var.project_id
  site_id               = each.value
  custom_domain         = each.key
  wait_dns_verification = false
}

# Domener som bare sender videre (301, samme sti) til nettstedets domene, f.eks. www.
resource "google_firebase_hosting_custom_domain" "omdirigering" {
  for_each              = var.domene_omdirigeringer
  provider              = google-beta
  project               = var.project_id
  site_id               = google_firebase_hosting_site.standard.site_id
  custom_domain         = each.key
  redirect_target       = each.value
  wait_dns_verification = false
  depends_on            = [google_firebase_hosting_custom_domain.domene]
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

# Uten ALERT_EMAIL går driftsvarslene til plattformadministratorene (ADMIN_EPOSTER).
locals {
  admin_varsel_eposter = var.alert_email != "" ? [] : distinct([for e in split(",", var.admin_eposter) : lower(trimspace(e)) if trimspace(e) != ""])
  driftsvarsler        = var.alert_email != "" || length(local.admin_varsel_eposter) > 0
  varselkanaler        = concat(google_monitoring_notification_channel.epost[*].id, [for k in google_monitoring_notification_channel.admin : k.id])
}

resource "google_monitoring_notification_channel" "admin" {
  for_each     = toset(local.admin_varsel_eposter)
  display_name = "Driftsvarsler til ${each.value}"
  type         = "email"
  labels = {
    email_address = each.value
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
  count        = local.driftsvarsler ? 1 : 0
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

  notification_channels = local.varselkanaler
}

resource "google_monitoring_alert_policy" "dlq" {
  count        = local.driftsvarsler ? 1 : 0
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

  notification_channels = local.varselkanaler
}

# Feil i loggen: API-et eller workeren logger noe med alvorlighetsgrad ERROR eller høyere (også
# forespørsler som svarer 5xx, og Cloud Run selv, f.eks. når minnet er brukt opp). Køfeilen i
# oktober 2026 (oppgaver som ikke ble lagt i kø) ville gitt varsel samme dag. Høyst ett varsel i
# timen; meldingen og tjenesten står i varselet.
resource "google_monitoring_alert_policy" "feil_i_loggen" {
  count        = local.driftsvarsler ? 1 : 0
  display_name = "Feil i loggen fra API-et eller workeren"
  combiner     = "OR"

  conditions {
    display_name = "Logglinje med ERROR eller høyere"
    condition_matched_log {
      filter = join(" AND ", [
        "resource.type=\"cloud_run_revision\"",
        "resource.labels.service_name=(\"${google_cloud_run_v2_service.api.name}\" OR \"${google_cloud_run_v2_service.worker.name}\")",
        "severity>=ERROR",
      ])
      label_extractors = {
        tjeneste = "EXTRACT(resource.labels.service_name)"
        melding  = "EXTRACT(jsonPayload.message)"
      }
    }
  }

  alert_strategy {
    notification_rate_limit {
      period = "3600s"
    }
    auto_close = "1800s"
  }

  documentation {
    mime_type = "text/markdown"
    content   = "API-et eller workeren i Admin Konsoll logget en feil. Se loggen: Cloud Logging, `resource.type=\"cloud_run_revision\" severity>=ERROR`. Meldingen og tjenesten står i etikettene på hendelsen."
  }

  notification_channels = local.varselkanaler
}

# ---------------------------------------------------------------------------
# Nettlesernøkkel for Google Picker, så brukeren kan velge mappe i sin Google Disk.
# ---------------------------------------------------------------------------

resource "google_apikeys_key" "picker" {
  name         = "faktura-picker"
  display_name = "Admin Konsoll – Google Picker"

  restrictions {
    api_targets {
      service = "picker.googleapis.com"
    }
    # Appens domener og nettstedets, der appen ligger under /app.
    browser_key_restrictions {
      allowed_referrers = concat(
        [for d in distinct(compact(concat(local.app_domener, [var.nettsted_domene]))) : "https://${d}/*"],
        [
          "https://${google_firebase_hosting_site.standard.site_id}.web.app/*",
          "https://${google_firebase_hosting_site.appen.site_id}.web.app/*",
        ],
      )
    }
  }

  depends_on = [google_project_service.apis]
}
