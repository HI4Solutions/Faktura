output "api_url" {
  value = google_cloud_run_v2_service.api.uri
}

output "worker_url" {
  value = google_cloud_run_v2_service.worker.uri
}

output "app_url" {
  value = "https://${var.app_domain}"
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
