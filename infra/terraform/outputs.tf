output "api_url" {
  value = google_cloud_run_v2_service.api.uri
}

output "worker_url" {
  value = google_cloud_run_v2_service.worker.uri
}

output "app_url" {
  value = "https://${var.app_domain}"
}

output "nettsted_url" {
  value = var.nettsted_domene == "" ? "https://${google_firebase_hosting_site.standard.site_id}.web.app" : "https://${var.nettsted_domene}"
}

output "hosting_sider" {
  description = "Sidene i Firebase Hosting: standardsiden (nettstedet, og appen til den har flyttet) og appens egen side, og domenene på hver (docs/domene.md)."
  value = {
    standard = google_firebase_hosting_site.standard.site_id
    app      = google_firebase_hosting_site.appen.site_id
    domener  = local.egne_domener
  }
}

output "dns_for_domener" {
  description = "DNS-oppføringene som må legges inn hos domeneleverandøren, per domene (docs/domene.md)."
  value       = { for d, r in merge(google_firebase_hosting_custom_domain.domene, google_firebase_hosting_custom_domain.omdirigering) : d => r.required_dns_updates }
}

output "domenestatus" {
  description = "Om domenene peker til Firebase (host_state), er bekreftet (ownership_state) og har sertifikat."
  value = { for d, r in merge(google_firebase_hosting_custom_domain.domene, google_firebase_hosting_custom_domain.omdirigering) : d => {
    vert        = r.host_state
    eierskap    = r.ownership_state
    sertifikat  = try(r.cert[0].state, null)
    omdirigerer = r.redirect_target
  } }
}

output "db_connection_name" {
  value = google_sql_database_instance.db.connection_name
}

output "artifact_registry" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
}

output "faktura_bucket" {
  value = google_storage_bucket.fakturaer.name
}
