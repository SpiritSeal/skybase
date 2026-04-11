# skybase

Web-based remote tmux with cmux-style "action required" notifications.

Attach to and interact with your tmux sessions on multiple remote SSH hosts
from any device — laptop, phone, tablet — and get a Web Push notification on
your phone when an agent (Claude Code, etc.) running inside one of those
sessions signals it needs your attention. Even when the browser tab is closed.

## How notifications work

skybase adopts cmux's notification protocol — it parses **OSC 9 / 777 / 99**
escape sequences out of the PTY byte stream and forwards them as Web Push +
webhook events. The bundled `scripts/skybase-notify.sh` is a drop-in
replacement for `cmux notify`, so the same Claude Code hook scripts that work
with cmux work unchanged here.

```
[ Claude Code on remote host ]
       │
       │  Stop hook → ~/bin/skybase-notify --title "Claude" --body "Done"
       ▼
[ /dev/tty inside tmux pane ]
       │  printf '\ePtmux;\e\e]777;notify;Claude;Done\a\e\\'
       ▼
[ tmux passthrough → ssh stream → node-pty on the skybase server ]
       │
       ▼
[ OscFilter strips the OSC, emits an event ]
       │
       ├── Web Push (VAPID) → SW → OS notification on your phone
       └── Webhook POST {title, body, sessionId, hostId, timestamp}
```

For tmux passthrough to work, the user must enable
`set -g allow-passthrough on` in `.tmux.conf` on each remote host. Without
that, tmux drops the wrapped DCS and notifications never escape the pane.

## Repo layout

```
apps/
  server/    Fastify + ws + node-pty backend, OSC parser, dispatcher
  web/       React + Vite + xterm.js PWA (with service worker for Web Push)
packages/
  shared/    WebSocket protocol types shared by server and web
scripts/
  skybase-notify.sh   Drop-in cmux-notify replacement (POSIX shell)
config/
  hosts.example.yaml  Sample host registry — copy to hosts.yaml and edit
infra/
  terraform/ GCP IaC (GCE + IAP + HTTPS LB + Secret Manager + Artifact Registry)
Dockerfile, docker-compose.yml
```

## Local development

```
pnpm install
pnpm --filter @skybase/server dev          # Fastify on :8080
pnpm --filter @skybase/web dev             # Vite on :5173, proxies /api and /ws
```

Open <http://localhost:5173/?local=1> for "local bash" mode (no SSH, no
hosts.yaml needed) — gives you a real PTY into bash so you can play with the
OSC pipeline.

To smoke-test notifications without any agent setup:

```
printf '\e]777;notify;Hello;World\a'
```

You should see a toast in the web UI within a second.

## Tests

```
pnpm --filter @skybase/server test
```

Covers the OSC filter (state machine, byte-split chunk boundaries, dedupe),
end-to-end PTY → filter → event flow, and an integration test that invokes
`scripts/skybase-notify.sh` for real and asserts the round-trip.

## Production deploy (GCP)

1. **Generate VAPID keys** — once, ever. Rotating them invalidates every
   subscribed device.
   ```
   node apps/server/scripts/gen-vapid.mjs --subject mailto:you@example.com > vapid.json
   ```

2. **Create the secrets** in your GCP project:
   ```
   gcloud secrets create skybase-ssh-key       --data-file=$HOME/.ssh/id_ed25519
   gcloud secrets create skybase-known-hosts   --data-file=$HOME/.ssh/known_hosts
   gcloud secrets create skybase-vapid         --data-file=vapid.json
   # optional:
   gcloud secrets create skybase-webhook-token --data-file=- <<< "your-bearer-token"
   ```

3. **Build and push the container image** to Artifact Registry (the registry
   is created by Terraform on first apply, so do this AFTER the first
   `terraform apply` succeeds — or push to a temporary location first):
   ```
   docker buildx build --platform linux/amd64 \
     -t us-central1-docker.pkg.dev/$PROJECT/skybase/skybase:0.1.0 .
   docker push  us-central1-docker.pkg.dev/$PROJECT/skybase/skybase:0.1.0
   ```

4. **Apply Terraform**:
   ```
   cd infra/terraform
   cp terraform.tfvars.example terraform.tfvars
   # edit terraform.tfvars
   terraform init
   terraform apply
   ```
   Outputs include `lb_ip` (point your DNS A record at it) and `url`.

5. **Wait for the managed cert** (5–30 min). Then visit the URL — IAP will
   prompt you to sign in with the Google account you configured as
   `iap_member`.

## End-to-end verification on your phone

1. Open the URL in mobile Safari, sign in to IAP, install the PWA via
   Share → Add to Home Screen.
2. **Open the installed PWA** (not Safari!) and sign in **again** there —
   iOS standalone webview has its own cookie jar separate from Safari, so
   IAP needs a fresh login. This is a one-time gotcha.
3. Tap "Enable notifications", then "Test notification". Phone should buzz.
4. SSH from skybase into a remote host, inside a tmux session, install the
   notify script:
   ```
   scp scripts/skybase-notify.sh remote:~/bin/skybase-notify
   chmod +x ~/bin/skybase-notify
   ln -sf ~/bin/skybase-notify ~/bin/cmux   # cmux compat
   ```
5. Wire it into Claude Code's `Stop` hook:
   ```jsonc
   // ~/.claude/settings.json
   {
     "hooks": {
       "Stop": [
         { "command": "~/bin/skybase-notify --title Claude --body 'task complete'" }
       ]
     }
   }
   ```
6. Run any Claude Code task to completion **with the browser tab closed**.
   Phone receives push within ~2s.
7. Tap the push → PWA opens directly to that session, scrollback intact.
