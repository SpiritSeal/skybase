# skybase deploy guide

End-to-end guide for standing up skybase on GCP. Most steps are automatable
via `gcloud` and `terraform`; a couple require the GCP Console UI because
Google deprecated the corresponding APIs in 2025 for personal accounts.

If you're following along after the initial deploy is already done, jump to
the [Updating the running deployment](#updating-the-running-deployment)
section.

## Prerequisites

- A GCP project with billing linked
- A domain you own where you can add an A record
- macOS or Linux with: `gcloud`, `terraform >= 1.5`, `docker` with `buildx`,
  `pnpm`, `node >= 22`
- An SSH key that authenticates to all the hosts in `config/hosts.yaml`

## One-time setup

### 1. Create the GCP project

```bash
PROJECT=skybase-yssaketh
BILLING=XXXXXX-XXXXXX-XXXXXX   # gcloud billing accounts list

gcloud projects create $PROJECT --name="skybase" --set-as-default
gcloud billing projects link $PROJECT --billing-account=$BILLING
gcloud auth application-default set-quota-project $PROJECT
```

### 2. Enable required APIs

```bash
gcloud services enable \
  compute.googleapis.com \
  iap.googleapis.com \
  secretmanager.googleapis.com \
  artifactregistry.googleapis.com \
  billingbudgets.googleapis.com \
  --project=$PROJECT
```

### 3. Create the $10/month budget alert (REST API)

The Terraform `google_billing_budget` resource has rough edges on personal
accounts (ADC quota project complaints), so we create the budget directly
via the REST API. It's idempotent — re-running just creates a duplicate, so
do it exactly once.

```bash
TOKEN=$(gcloud auth print-access-token)
cat > /tmp/budget.json <<EOF
{
  "displayName": "skybase monthly cap",
  "budgetFilter": { "projects": ["projects/$PROJECT"] },
  "amount": { "specifiedAmount": { "currencyCode": "USD", "units": "10" } },
  "thresholdRules": [
    {"thresholdPercent": 0.5},
    {"thresholdPercent": 0.9},
    {"thresholdPercent": 1.0},
    {"thresholdPercent": 1.0, "spendBasis": "FORECASTED_SPEND"}
  ]
}
EOF
curl -sX POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "x-goog-user-project: $PROJECT" \
  -d @/tmp/budget.json \
  "https://billingbudgets.googleapis.com/v1/billingAccounts/$BILLING/budgets"
rm /tmp/budget.json
```

You should get back a JSON blob with a `name` field containing the budget
ID. Verify in the GCP Console under **Billing → Budgets & alerts**.

### 4. Create OAuth consent screen + IAP OAuth client (CONSOLE-ONLY)

This is the only mandatory manual step. Google deprecated `google_iap_brand`
and `google_iap_client` in July 2025 for projects without an organization
(which all personal Google accounts are), so you have to use the Console UI.

#### 4a. OAuth consent screen

1. Open <https://console.cloud.google.com/apis/credentials/consent?project=skybase-yssaketh>
2. **User Type**: External → Create
3. **App name**: skybase
4. **User support email**: yssaketh@gmail.com
5. **Developer contact information**: yssaketh@gmail.com
6. Save and continue through the Scopes screen (no scopes needed)
7. **Test users**: add yssaketh@gmail.com (and any other Google accounts you
   want to be able to sign in). External + Testing means only listed test
   users can sign in, which is exactly what we want.
8. Save.

#### 4b. OAuth 2.0 Client ID for IAP

1. Open <https://console.cloud.google.com/apis/credentials?project=skybase-yssaketh>
2. **Create credentials → OAuth client ID**
3. **Application type**: Web application
4. **Name**: skybase-iap
5. **Authorized redirect URIs**: paste exactly:
   ```
   https://iap.googleapis.com/v1/oauth/clientIds/REPLACE_AFTER_CREATE:handleRedirect
   ```
   Click Create. The redirect URI is wrong on purpose for now — you'll edit
   it in a moment with the real client ID.
6. After creation, **copy the client ID and client secret** that the dialog
   shows (the client secret is ONLY shown at creation time; if you miss it
   you'll have to delete the client and start over).
7. Now click the new credential, edit the redirect URI, and replace
   `REPLACE_AFTER_CREATE` with the actual client ID. Save.

#### 4c. Stash the credentials

Add them to `infra/terraform/secrets.auto.tfvars` (gitignored, auto-loaded
by Terraform):

```bash
cat >> infra/terraform/secrets.auto.tfvars <<EOF
iap_oauth2_client_id     = "PASTE_CLIENT_ID_HERE"
iap_oauth2_client_secret = "PASTE_CLIENT_SECRET_HERE"
EOF
```

### 5. Generate VAPID keys + upload secrets

VAPID keys are immutable post-launch — rotating invalidates every Web Push
subscription on every device. Generate once.

```bash
cd apps/server
node scripts/gen-vapid.mjs --subject mailto:yssaketh@gmail.com > /tmp/vapid.json

gcloud secrets create skybase-vapid --data-file=/tmp/vapid.json --project=$PROJECT --replication-policy=automatic
gcloud secrets create skybase-ssh-key --data-file="$HOME/.ssh/id_rsa" --project=$PROJECT --replication-policy=automatic

# Pre-seed known_hosts so the GCE VM doesn't TOFU on first connect.
# Add ssh-keyscan lines for every host in config/hosts.yaml.
ssh-keyscan -p 22   ratbat.gtisc.gatech.edu  > /tmp/known_hosts
ssh-keyscan -p 2222 server.broyojo.com      >> /tmp/known_hosts
gcloud secrets create skybase-known-hosts --data-file=/tmp/known_hosts --project=$PROJECT --replication-policy=automatic

rm /tmp/vapid.json /tmp/known_hosts
cd ../..
```

### 6. Configure terraform.tfvars + secrets.auto.tfvars

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # if you don't have one yet
$EDITOR terraform.tfvars   # set project_id, domain, iap_member, iap_support_email, image
```

`secrets.auto.tfvars` (gitignored, auto-loaded by Terraform) should contain
the OAuth client credentials from step 4b above:

```hcl
iap_oauth2_client_id     = "<from step 4b>"
iap_oauth2_client_secret = "<from step 4b>"
```

(`billing_account` is intentionally not a Terraform variable — the budget
is created out-of-band via the REST API in step 3 to avoid the ADC quota
project complaints that personal Google accounts hit.)

### 7. Terraform apply

```bash
cd infra/terraform
terraform init
terraform plan -out=skybase.tfplan
terraform apply skybase.tfplan
```

This creates ~26 resources: VPC + subnet, GCE VM (COS, e2-small), HTTPS LB
(reserved IP, managed cert, target proxy, URL map, backend service with
`timeout_sec=86400` for WebSockets, IAP enabled), Secret Manager IAM
bindings for the VM service account, Artifact Registry repo, and a service
account.

**Outputs**:
- `lb_ip` — point your DNS A record at this
- `image_repository` — `us-central1-docker.pkg.dev/$PROJECT/skybase`
- `url` — `https://skybase.<your-domain>`

### 8. Build and push the container image

The GCE VM is now running and trying to pull the image — but it doesn't
exist yet, so the systemd unit is in a restart loop. Push the image:

```bash
gcloud auth configure-docker us-central1-docker.pkg.dev   # one-time

cd ../..   # back to repo root
docker buildx build \
  --platform linux/amd64 \
  -t us-central1-docker.pkg.dev/$PROJECT/skybase/skybase:0.1.0 \
  --push .
```

### 9. Restart the GCE service to pull the new image

```bash
gcloud compute ssh skybase --zone=us-central1-a --project=$PROJECT \
  --command='sudo systemctl restart skybase'
```

### 10. Add the DNS A record

In your DNS provider (Cloudflare, Namecheap, Route53, etc.), create:

| Type | Name              | Value                              | TTL  |
|------|-------------------|------------------------------------|------|
| A    | skybase.saketh.red | (the `lb_ip` from terraform output) | 300 |

If you're on Cloudflare, **disable the orange cloud (proxy)** for this record.
WebSockets through Cloudflare proxy require a higher plan; direct DNS is
simpler.

Verify the record propagates: `dig +short skybase.saketh.red`

### 11. Wait for the managed cert

```bash
# Repeat until status is ACTIVE (typically 10–30 minutes)
gcloud compute ssl-certificates describe skybase --project=$PROJECT \
  --format='value(managed.status,managed.domainStatus)'
```

The cert can't reach `ACTIVE` until the DNS A record is in place AND the
domain validates. If after 60 minutes it's still `PROVISIONING`, double-
check the A record points at the right IP (`lb_ip`) and the load balancer
is healthy (`gcloud compute forwarding-rules list`).

### 12. First sign-in

1. Visit `https://skybase.saketh.red` in a browser
2. IAP redirects you to Google sign-in — sign in as `yssaketh@gmail.com`
3. You should land on the skybase UI with the sidebar showing your hosts

### 13. iOS PWA + Web Push (one-time per device)

1. On your iPhone, open `https://skybase.saketh.red` in **mobile Safari**
2. Sign in to IAP with your Google account
3. **Share → Add to Home Screen** to install as a PWA
4. **Open the installed PWA** (the icon on your home screen, NOT Safari) —
   iOS standalone has its own cookie jar, so you'll be prompted to sign in
   to IAP **again**. This is a one-time gotcha.
5. In the PWA, click **Enable notifications** in the sidebar footer, then
   click **Test notification**. Your phone should buzz.
6. To make Claude Code on a remote host send notifications: copy
   `scripts/skybase-notify.sh` to that host and wire it into Claude Code's
   `Stop` hook. See the notification section of the main `README.md`.

## Updating the running deployment

After the initial deploy, day-to-day updates look like this.

### Code change → new image → restart

```bash
# Bump version (or use a SHA tag)
TAG=0.1.1
docker buildx build --platform linux/amd64 \
  -t us-central1-docker.pkg.dev/skybase-yssaketh/skybase/skybase:$TAG \
  --push .

# Update terraform.tfvars `image = "...$TAG"` (or just override on apply)
cd infra/terraform
terraform apply -var "image=us-central1-docker.pkg.dev/skybase-yssaketh/skybase/skybase:$TAG"

# The cloud-init unit will pull the new image on next service restart:
gcloud compute ssh skybase --zone=us-central1-a --project=skybase-yssaketh \
  --command='sudo systemctl restart skybase'
```

### Add a new host

1. Edit `config/hosts.yaml` and add the new host entry
2. ssh-keyscan the new host and add to the `skybase-known-hosts` secret:
   ```bash
   gcloud secrets versions access latest --secret=skybase-known-hosts > /tmp/kh
   ssh-keyscan -p 22 newhost.example.com >> /tmp/kh
   gcloud secrets versions add skybase-known-hosts --data-file=/tmp/kh --project=skybase-yssaketh
   rm /tmp/kh
   ```
3. Bake the new `hosts.yaml` into a new image, push, restart (as above)

### Rotate the SSH key

```bash
gcloud secrets versions add skybase-ssh-key --data-file="$HOME/.ssh/id_rsa.new" --project=skybase-yssaketh
gcloud compute ssh skybase --zone=us-central1-a --project=skybase-yssaketh \
  --command='sudo systemctl restart skybase'
```

### Tear it all down

```bash
cd infra/terraform
terraform destroy
# Optionally also delete the project to stop ALL billing:
gcloud projects delete skybase-yssaketh
```

## Container-Optimized OS gotchas

The skybase VM runs Container-Optimized OS (COS) — a minimal Google-maintained
OS image for running containers on GCE. Several things are non-obvious if
you're used to Debian/Ubuntu:

| What | Where it bites you | Workaround |
|---|---|---|
| `/usr` is mounted **read-only** (verity-protected) | `cloud-init write_files` cannot create `/usr/local/bin/foo.sh`, fails the entire `write_files` module silently | Write helper scripts under `/etc/skybase/` instead |
| Standard tools live in `/bin`, not `/usr/bin` | `/usr/bin/mkdir`, `/usr/bin/mount`, `/usr/bin/sh` don't exist → systemd `Failed to locate executable` | Use `/bin/mkdir`, `/bin/mount`, `/bin/sh` in unit `ExecStartPre=` |
| No `gcloud` binary on the host | Can't `gcloud secrets versions access` directly | Curl the Secret Manager REST API with a metadata-server access token (see `cloud-init.yaml.tftpl`'s `fetch-secret.sh`) |
| `/root` is read-only | `docker login` writes `~/.docker/config.json` and fails | Set `DOCKER_CONFIG=/var/lib/skybase/docker` in the systemd unit's `Environment=` |
| Default tmpfs mode 0700 owned by root | Containers running as non-root (uid 1500) can't traverse `/run/skybase` to read mounted secrets | `mount -t tmpfs -o size=1m,mode=0700,uid=1500,gid=1500` and `chown 1500:1500` the secret files |
| systemd performs `$VARIABLE` substitution on the unit file | `bash -c 'T=$(curl ...)'` becomes `bash -c 'T=()'` because `$T` and `$(...)` get clobbered | Keep the bash logic in an external script and call it by path; never embed `$` in the unit file |
| Backslash continuation in `ExecStartPre=` is fragile inside YAML pipe blocks | Multi-line `ExecStartPre=foo \` lines get parsed wrong → bash sees fragments → `unexpected EOF` | Put each `ExecStartPre` on a single (long) line |
| systemd's `start-pre` timeout is 90s by default | First-time `docker pull` of large images blows past it → unit killed | Set `TimeoutStartSec=300` in `[Service]` |

## Other gotchas

### Secret Manager REST API returns pretty-printed JSON
By default the API returns JSON spread over multiple lines, so a line-based
`sed` extracts garbage and `base64 -d` chokes. Add `?alt=json&prettyPrint=false`
or pipe through `tr -d '\n'` first.

### Personal Google accounts can't use `google_iap_brand` / `google_iap_client`
Google deprecated programmatic IAP brand creation in July 2025 for any project
not part of an organization. All personal accounts hit "Project must belong to
an organization." The OAuth consent screen + OAuth client ID have to be
created manually in the GCP Console (see step 4 above) and the client ID/secret
passed to Terraform as variables.

### Terraform `google_billing_budget` complains about ADC quota project
The provider needs `gcloud auth application-default set-quota-project
skybase-yssaketh` first, AND the budget API has a deprecation warning on
personal accounts. We just create the budget out-of-band via the REST API
(see step 3) — much less friction.

### Instance group not updated after VM taint+recreate
By default the `google_compute_instance_group.skybase` resource doesn't
re-evaluate its `instances = [...]` list when the VM is replaced, so the
LB ends up with zero healthy backends. The `lifecycle.replace_triggered_by`
clause in `main.tf` fixes this — make sure it's there before tainting the VM.

### LB health check shows backend healthy but cert stuck on `FAILED_NOT_VISIBLE`
Google's managed cert validator caches "domain not visible" failures from
*before* you added the DNS A record. You can wait ~5-10 min for the next
retry cycle, or force a fresh validation by tainting `random_id.cert_suffix`
and re-applying:
```bash
cd infra/terraform
terraform taint random_id.cert_suffix
terraform apply
```
The `name = "skybase-${random_id.cert_suffix.hex}"` + `create_before_destroy`
combo lets Terraform retarget the HTTPS proxy to a fresh cert without hitting
"resource in use" on the old one.

### Cert status `PROVISIONING` for hours
- Verify the DNS A record: `dig +short skybase.saketh.red` should return the
  `lb_ip` from terraform output
- Verify the load balancer is healthy:
  `gcloud compute backend-services get-health skybase --global --project=skybase-yssaketh`
- Verify the GCE VM is in the instance group (not just running):
  `gcloud compute instance-groups unmanaged list-instances skybase --zone=us-central1-a --project=skybase-yssaketh`
- Verify the skybase systemd unit is `active (running)`:
  `gcloud compute ssh skybase --zone=us-central1-a --project=skybase-yssaketh --tunnel-through-iap --command='sudo systemctl status skybase'`

### IAP redirects loop on iOS PWA
Sign in inside the installed PWA, not in Safari first. iOS standalone has a
separate cookie jar from Safari proper.

### "no server running" when listing tmux sessions
Tmux on the remote host hasn't been started. Click `open` to create a
session by name, or SSH manually and run `tmux new -d -s main`.

### `gcloud compute ssh` fails with "Failed to connect to port 22"
The default skybase VPC has no inbound SSH rule. You need IAP TCP forwarding:
```bash
gcloud compute firewall-rules create skybase-iap-ssh \
  --network=skybase --direction=INGRESS --allow=tcp:22 \
  --source-ranges=35.235.240.0/20 --target-tags=skybase \
  --project=skybase-yssaketh
gcloud projects add-iam-policy-binding skybase-yssaketh \
  --member="user:you@example.com" \
  --role="roles/iap.tunnelResourceAccessor"
gcloud compute ssh skybase --zone=us-central1-a \
  --project=skybase-yssaketh --tunnel-through-iap
```
