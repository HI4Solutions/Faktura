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

variable "app_domain" {
  description = "Domenet nettappen og API-et (/api/**) svarer på."
  type        = string
  default     = "faktura.hi4.no"
}

variable "epost_avsender" {
  description = "Avsenderadressen for fakturaer. Domenet må være verifisert i Resend. Selgerens navn settes foran, og svar går til selgeren."
  type        = string
  default     = "faktura@hi4.no"
}

variable "admin_eposter" {
  description = "Plattformadministratorer, kommaseparerte e-postadresser. Settes med GitHub-variabelen ADMIN_EPOSTER. Tom = ingen."
  type        = string
  default     = ""
}

variable "google_oauth_client_id" {
  description = "Klient-ID for Google OAuth (Google Disk). Settes med GitHub-variabelen GOOGLE_OAUTH_CLIENT_ID. Hemmeligheten ligger i Secret Manager."
  type        = string
  default     = ""
}

variable "ai_aktiv" {
  description = "AI-funksjonene (Gemini på Vertex AI): fakturautkast fra tekst og tale, og forslag på innbetalinger. Settes med GitHub-variabelen AI_AKTIV."
  type        = bool
  default     = true
}

variable "ai_region" {
  description = "Region for Gemini på Vertex AI. europe-west3 er Frankfurt; «eu» er EU-multiregionen. Settes med GitHub-variabelen AI_REGION."
  type        = string
  default     = "europe-west3"
}

variable "ai_modell" {
  description = "Gemini-modellen. Settes med GitHub-variabelen AI_MODELL."
  type        = string
  default     = "gemini-3.5-flash"
}

variable "ai_grense" {
  description = "Høyst så mange AI-forespørsler per organisasjon per måned (tak på kostnaden). Settes med GitHub-variabelen AI_GRENSE."
  type        = number
  default     = 1000
}

# Skattekort fra Skatteetaten (docs/skattekort.md). Leverandøren (Medinnova AS) har én
# Maskinporten-klient og ett system i Altinns systemregister.
variable "skatteetaten_miljo" {
  description = "test (Maskinporten-test, Altinn TT02 og Skatteetatens testmiljø) eller prod. Settes med GitHub-variabelen SKATTEETATEN_MILJO."
  type        = string
  default     = "test"
  validation {
    condition     = contains(["test", "prod"], var.skatteetaten_miljo)
    error_message = "skatteetaten_miljo må være test eller prod."
  }
}

variable "maskinporten_klient_id" {
  description = "Klient-ID-en (integrasjons-ID) til Maskinporten-klienten. Tom = skattekortfunksjonen er skjult. Settes med GitHub-variabelen MASKINPORTEN_KLIENT_ID."
  type        = string
  default     = ""
}

variable "maskinporten_nokkel_id" {
  description = "Nøkkel-ID-en (kid) til nøkkelen på Maskinporten-klienten. Settes med GitHub-variabelen MASKINPORTEN_NOKKEL_ID."
  type        = string
  default     = ""
}

variable "leverandor_orgnr" {
  description = "Organisasjonsnummeret til leverandøren av løsningen (eier Maskinporten-klienten og systemet i Altinn). Settes med GitHub-variabelen LEVERANDOR_ORGNR."
  type        = string
  default     = "936564046"
}

variable "altinn_systemnavn" {
  description = "Navnet kundene ser i Altinn når de godkjenner tilgangen. Settes med GitHub-variabelen ALTINN_SYSTEMNAVN."
  type        = string
  default     = "HI4 Faktura"
}

variable "altinn_system_id" {
  description = "System-ID-en i Altinns systemregister (tom = <leverandor_orgnr>_lonn). Settes med GitHub-variabelen ALTINN_SYSTEM_ID."
  type        = string
  default     = ""
}
