variable "project_id" {
  description = "GCP-prosjektet plattformen kjører i."
  type        = string
}

variable "region" {
  description = "Region for alle regionale ressurser. europe-north1 er Finland, europe-north2 er Stockholm."
  type        = string
  default     = "europe-north1"
}

variable "github_repo" {
  description = "GitHub-repoet som får rulle ut (eier/navn)."
  type        = string
  default     = "HI4Solutions/Faktura"
}

variable "db_tier" {
  description = "Maskintype for Cloud SQL. Start lite og skaler opp."
  type        = string
  default     = "db-custom-1-3840"
}

variable "db_ha" {
  description = "Høy tilgjengelighet (regional) for Cloud SQL. Anbefalt i produksjon med betalende kunder."
  type        = bool
  default     = false
}

variable "faktura_retention_days" {
  description = "Hvor lenge PDF-er av utstedte fakturaer ikke kan slettes. Bokføringsloven: 5 år etter regnskapsårets slutt, altså opptil 6 år."
  type        = number
  default     = 2192
}

variable "faktura_retention_locked" {
  description = "Lås oppbevaringsregelen permanent. KAN IKKE ANGRES – slå på først når alt er testet."
  type        = bool
  default     = false
}

variable "app_domains" {
  description = "Domener som får logge inn via Identity Platform (i tillegg til Firebase-domenene)."
  type        = list(string)
  default     = []
}

variable "alert_email" {
  description = "E-postadresse for driftsvarsler. Tom = ingen varsler."
  type        = string
  default     = ""
}

variable "placeholder_image" {
  description = "Startbilde for Cloud Run før første utrulling fra CI. CI bytter bildet; Terraform rører det ikke etterpå."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "jobs_region" {
  description = "Region for Cloud Tasks og Cloud Scheduler, som ikke finnes i europe-north1. Holdes i EU."
  type        = string
  default     = "europe-west1"
}
