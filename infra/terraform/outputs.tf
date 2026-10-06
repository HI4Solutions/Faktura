output "api_url" {
  value = google_cloud_run_v2_service.api.uri
}

output "worker_url" {
  value = google_cloud_run_v2_service.worker.uri
}

output "app_url" {
  value = "https://${var.app_domain}"
}

output "dns_for_app_domain" {
  description = "DNS-oppføringer som må legges inn hos domeneleverandøren for app_domain."
  value       = google_firebase_hosting_custom_domain.app.required_dns_updates
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
