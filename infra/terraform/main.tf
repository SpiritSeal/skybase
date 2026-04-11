# skybase GCP infra. One root module, no submodules.
#
# What gets created:
#   - VPC + subnet
#   - GCE e2-small (COS) running the skybase container with secrets mounted
#     via tmpfs from Secret Manager
#   - Static external IP + Google-managed SSL cert
#   - Global HTTPS load balancer (URL map → backend service → instance group)
#     with timeoutSec=86400 so WebSockets don't get killed at 30s
#   - IAP brand + binding restricting access to the configured Google identity
#   - Artifact Registry repo for the container image
#   - Secret Manager secrets (ssh key, known_hosts, vapid, webhook token)
#
# CRITICAL operational notes encoded here:
#   1. backend service timeoutSec is set to 86400 (24h). The default of 30s
#      kills idle WebSockets every 30s, which would make the terminal
#      essentially unusable.
#   2. backend service uses INSTANCE_GROUP, not serverless NEG, because
#      Cloud Run has a 60-min request cap that would still kill long sessions.
#   3. VAPID secret has prevent_destroy = true. Rotating it invalidates every
#      Web Push subscription on every device. Treat as immutable post-launch.

# ── Required APIs ────────────────────────────────────────────────────────
locals {
  apis = toset([
    "compute.googleapis.com",
    "iap.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
    "billingbudgets.googleapis.com",
  ])
  iap_all_members = toset(concat([var.iap_member], var.iap_members))
}

resource "google_project_service" "apis" {
  for_each = local.apis
  service  = each.value

  disable_on_destroy = false
}

# ── Service account for the GCE VM ───────────────────────────────────────
resource "google_service_account" "skybase" {
  account_id   = "skybase"
  display_name = "skybase server"
}

# Read-only access to the Secret Manager secrets the VM mounts at boot.
resource "google_secret_manager_secret_iam_member" "ssh_key" {
  secret_id = google_secret_manager_secret.ssh_key.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.skybase.email}"
}

resource "google_secret_manager_secret_iam_member" "known_hosts" {
  secret_id = google_secret_manager_secret.known_hosts.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.skybase.email}"
}

resource "google_secret_manager_secret_iam_member" "vapid" {
  secret_id = google_secret_manager_secret.vapid.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.skybase.email}"
}

resource "google_secret_manager_secret_iam_member" "webhook_token" {
  count     = var.webhook_url == "" ? 0 : 1
  secret_id = google_secret_manager_secret.webhook_token[0].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.skybase.email}"
}

# ── Secrets (versions are uploaded by hand or via a helper script) ───────
resource "google_secret_manager_secret" "ssh_key" {
  secret_id = var.ssh_key_secret_id
  replication { auto {} }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "known_hosts" {
  secret_id = var.known_hosts_secret_id
  replication { auto {} }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "vapid" {
  secret_id = var.vapid_secret_id
  replication { auto {} }
  depends_on = [google_project_service.apis]

  # Rotating VAPID invalidates every push subscription on every device.
  # Once you've launched, never destroy this secret.
  lifecycle {
    prevent_destroy = true
  }
}

resource "google_secret_manager_secret" "webhook_token" {
  count     = var.webhook_url == "" ? 0 : 1
  secret_id = var.webhook_token_secret_id
  replication { auto {} }
  depends_on = [google_project_service.apis]
}

# ── Artifact Registry for the container image ────────────────────────────
resource "google_artifact_registry_repository" "skybase" {
  location      = var.region
  repository_id = "skybase"
  format        = "DOCKER"
  description   = "skybase server container image"

  depends_on = [google_project_service.apis]
}

# ── Network ──────────────────────────────────────────────────────────────
resource "google_compute_network" "vpc" {
  name                    = "skybase"
  auto_create_subnetworks = false

  depends_on = [google_project_service.apis]
}

resource "google_compute_subnetwork" "subnet" {
  name          = "skybase"
  ip_cidr_range = "10.40.0.0/24"
  region        = var.region
  network       = google_compute_network.vpc.id
}

# IAP forwarding range — Google's load balancer health checks and IAP TCP
# tunneling come from these CIDRs. Required for the LB to reach the VM.
resource "google_compute_firewall" "lb_to_vm" {
  name    = "skybase-lb-health"
  network = google_compute_network.vpc.name

  source_ranges = ["130.211.0.0/22", "35.191.0.0/16"]
  allow {
    protocol = "tcp"
    ports    = ["8080"]
  }
  target_tags = ["skybase"]
}

# ── GCE instance running the container ──────────────────────────────────
locals {
  webhook_env = var.webhook_url == "" ? "" : "Environment=SKYBASE_WEBHOOK_URL=${var.webhook_url}\nEnvironment=SKYBASE_WEBHOOK_TOKEN_FILE=/run/skybase/webhook_token\n"
  webhook_secret_mount = var.webhook_url == "" ? "" : "ExecStartPre=/usr/bin/env sh -c 'gcloud secrets versions access latest --secret=${var.webhook_token_secret_id} > /run/skybase/webhook_token && chmod 600 /run/skybase/webhook_token'\n"

  cloud_init = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    image                  = var.image
    ssh_key_secret_id      = var.ssh_key_secret_id
    known_hosts_secret_id  = var.known_hosts_secret_id
    vapid_secret_id        = var.vapid_secret_id
    webhook_secret_id      = var.webhook_token_secret_id
    webhook_url            = var.webhook_url
    artifact_registry_host = "${var.region}-docker.pkg.dev"
  })
}

resource "google_compute_instance" "skybase" {
  name         = "skybase"
  machine_type = var.machine_type
  zone         = var.zone
  tags         = ["skybase"]

  boot_disk {
    initialize_params {
      image = "projects/cos-cloud/global/images/family/cos-stable"
      size  = 20
    }
  }

  network_interface {
    network    = google_compute_network.vpc.id
    subnetwork = google_compute_subnetwork.subnet.id
    access_config {} # ephemeral public IP for outbound (egress to remote SSH hosts)
  }

  metadata = {
    user-data            = local.cloud_init
    google-logging-enabled = "true"
  }

  service_account {
    email  = google_service_account.skybase.email
    scopes = ["cloud-platform"]
  }

  shielded_instance_config {
    enable_secure_boot = true
  }

  depends_on = [
    google_secret_manager_secret_iam_member.ssh_key,
    google_secret_manager_secret_iam_member.known_hosts,
    google_secret_manager_secret_iam_member.vapid,
    google_artifact_registry_repository.skybase,
  ]
}

# ── Unmanaged instance group wrapping the VM ─────────────────────────────
resource "google_compute_instance_group" "skybase" {
  name      = "skybase"
  zone      = var.zone
  instances = [google_compute_instance.skybase.self_link]

  named_port {
    name = "http"
    port = 8080
  }
}

# ── Health check for the LB backend ──────────────────────────────────────
resource "google_compute_health_check" "skybase" {
  name = "skybase"

  http_health_check {
    port         = 8080
    request_path = "/healthz"
  }

  check_interval_sec  = 10
  timeout_sec         = 5
  healthy_threshold   = 1
  unhealthy_threshold = 3
}

# ── Backend service ──────────────────────────────────────────────────────
# CRITICAL: timeout_sec = 86400 keeps idle WebSockets alive (default 30s
# kills the terminal every half-minute). connection_draining_timeout high so
# rolling updates don't yank live sessions.
resource "google_compute_backend_service" "skybase" {
  name                  = "skybase"
  protocol              = "HTTP"
  port_name             = "http"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  timeout_sec           = 86400
  session_affinity      = "CLIENT_IP"
  health_checks         = [google_compute_health_check.skybase.id]

  connection_draining_timeout_sec = 300

  backend {
    group = google_compute_instance_group.skybase.id
  }

  iap {
    enabled              = true
    oauth2_client_id     = google_iap_client.skybase.client_id
    oauth2_client_secret = google_iap_client.skybase.secret
  }

  log_config {
    enable      = true
    sample_rate = 1.0
  }
}

# ── URL map / proxy / forwarding rule ────────────────────────────────────
resource "google_compute_url_map" "skybase" {
  name            = "skybase"
  default_service = google_compute_backend_service.skybase.id
}

resource "google_compute_managed_ssl_certificate" "skybase" {
  name = "skybase"

  managed {
    domains = [var.domain]
  }
}

resource "google_compute_target_https_proxy" "skybase" {
  name             = "skybase"
  url_map          = google_compute_url_map.skybase.id
  ssl_certificates = [google_compute_managed_ssl_certificate.skybase.id]
}

resource "google_compute_global_address" "skybase" {
  name = "skybase"
}

resource "google_compute_global_forwarding_rule" "skybase" {
  name                  = "skybase"
  ip_address            = google_compute_global_address.skybase.address
  port_range            = "443"
  target                = google_compute_target_https_proxy.skybase.id
  load_balancing_scheme = "EXTERNAL_MANAGED"
}

# ── Identity-Aware Proxy ─────────────────────────────────────────────────
resource "google_iap_brand" "skybase" {
  support_email     = var.iap_support_email
  application_title = "skybase"

  depends_on = [google_project_service.apis]
}

resource "google_iap_client" "skybase" {
  display_name = "skybase"
  brand        = google_iap_brand.skybase.name
}

resource "google_iap_web_backend_service_iam_member" "skybase" {
  for_each            = local.iap_all_members
  web_backend_service = google_compute_backend_service.skybase.name
  role                = "roles/iap.httpsResourceAccessor"
  member              = each.value
}

# ── Billing budget (alerts only — does NOT hard-cap spend) ───────────────
# GCP budgets fire Pub/Sub events at threshold percentages; you can wire
# them to a Cloud Function that disables billing if you want a true
# killswitch. For a personal $10/mo cap with IAP-restricted access, the
# alert at 100% is enough — there's no public surface to be abused.
resource "google_billing_budget" "skybase" {
  billing_account = var.billing_account
  display_name    = "skybase monthly cap"

  budget_filter {
    projects = ["projects/${var.project_id}"]
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.monthly_budget_usd)
    }
  }

  threshold_rules {
    threshold_percent = 0.5
  }
  threshold_rules {
    threshold_percent = 0.9
  }
  threshold_rules {
    threshold_percent = 1.0
  }
  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "FORECASTED_SPEND"
  }

  depends_on = [google_project_service.apis]
}

# ── Outputs ──────────────────────────────────────────────────────────────
output "lb_ip" {
  description = "Point your DNS A record at this address."
  value       = google_compute_global_address.skybase.address
}

output "image_repository" {
  description = "Push your container image here."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.skybase.repository_id}"
}

output "url" {
  description = "Public URL once DNS resolves and the cert is provisioned."
  value       = "https://${var.domain}"
}
