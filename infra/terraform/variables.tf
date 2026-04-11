variable "project_id" {
  description = "GCP project ID."
  type        = string
}

variable "region" {
  description = "GCP region (e.g. us-central1)."
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "GCP zone for the GCE instance (e.g. us-central1-a)."
  type        = string
  default     = "us-central1-a"
}

variable "domain" {
  description = "Domain for the public HTTPS endpoint (e.g. skybase.example.com). You must own this and point an A record at the LB IP after `terraform apply`."
  type        = string
}

variable "iap_member" {
  description = "IAP-restricted identity that's allowed to reach the app, e.g. 'user:you@example.com'. Add more via `iap_members` for multi-user."
  type        = string
}

variable "iap_members" {
  description = "Additional IAP members. Useful for granting access to a small group."
  type        = list(string)
  default     = []
}

variable "iap_support_email" {
  description = "Support email shown on the IAP consent screen. Must be a Google Workspace user/group OR the project owner."
  type        = string
}

variable "image" {
  description = "Fully-qualified container image to deploy (e.g. us-central1-docker.pkg.dev/PROJECT/skybase/skybase:0.1.0)."
  type        = string
}

variable "machine_type" {
  description = "GCE machine type."
  type        = string
  default     = "e2-small"
}

variable "ssh_key_secret_id" {
  description = "Secret Manager secret ID containing the SSH private key skybase uses to reach remote tmux hosts."
  type        = string
  default     = "skybase-ssh-key"
}

variable "known_hosts_secret_id" {
  description = "Secret Manager secret ID containing pre-seeded ~/.ssh/known_hosts for the remote hosts."
  type        = string
  default     = "skybase-known-hosts"
}

variable "vapid_secret_id" {
  description = "Secret Manager secret ID containing the VAPID JSON {publicKey,privateKey,subject}."
  type        = string
  default     = "skybase-vapid"
}

variable "webhook_token_secret_id" {
  description = "Secret Manager secret ID containing the outbound webhook bearer token (optional). Set webhook_url empty to disable."
  type        = string
  default     = "skybase-webhook-token"
}

variable "webhook_url" {
  description = "Outbound webhook URL for fanout (optional). Empty disables."
  type        = string
  default     = ""
}

variable "billing_account" {
  description = "GCP billing account ID for the budget. Find via `gcloud billing accounts list`. Format is XXXXXX-XXXXXX-XXXXXX."
  type        = string
}

variable "monthly_budget_usd" {
  description = "Monthly spending cap in USD. The budget only ALERTS — it doesn't hard-cap spending — but the alert thresholds are aggressive (50/90/100%) and a Pub/Sub-based killswitch can be wired in if needed."
  type        = number
  default     = 10
}
