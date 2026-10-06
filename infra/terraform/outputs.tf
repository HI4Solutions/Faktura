output "api_url" {
  value = google_cloud_run_v2_service.api.uri
}

output "worker_url" {
  value = google_cloud_run_v2_service.worker.uri
}

output "app_url" {
  value = "https://${google_firebase_hosting_site.app.site_id}.web.app"
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
