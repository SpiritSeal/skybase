// skybase server entrypoint. Wires:
//   - HTTP API: /api/hosts, /api/push/{vapid,subscribe,unsubscribe,test}
//   - WebSocket: /ws — bidirectional PTY + notification stream
//   - Static files: serves the built web client (apps/web/dist) when present
//
// Authentication is handled by Google IAP at the load balancer; the server
// only optionally verifies the IAP-set header for logging.

import Fastify from "fastify";
import websocketPlugin from "@fastify/websocket";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ClientMessage,
  ServerMessage,
  PushSubscribeRequest,
  PushTestRequest,
} from "@skybase/shared";
import { env } from "./env.js";
import { HostRegistry } from "./config/hosts.js";
import { PtySession } from "./pty/session.js";
import type { SpawnOpts } from "./pty/spawn.js";
import { NotificationDispatcher } from "./notify/dispatcher.js";
import { WebPushSink, parseVapidJson } from "./notify/webPush.js";
import { HttpWebhookSink } from "./notify/webhook.js";
import {
  killRemoteTmuxSession,
  listRemoteTmuxSessions,
} from "./pty/listSessions.js";

async function main(): Promise<void> {
  // ─── Load config + secrets ────────────────────────────────────────────
  console.log(`[skybase] hosts config: ${env.hostsConfigPath}`);
  if (env.sshKeyPaths.length === 0) {
    console.warn(
      `[skybase] ssh key: NONE FOUND — ssh attaches will fail. ` +
        `Set SKYBASE_SSH_KEY or place a key at ~/.ssh/id_{ed25519,rsa,ecdsa}.`,
    );
  } else {
    console.log(`[skybase] ssh keys: ${env.sshKeyPaths.join(", ")}`);
  }

  const hosts = new HostRegistry(env.hostsConfigPath);
  if (existsSync(env.hostsConfigPath)) {
    await hosts.load();
    hosts.watch();
    console.log(
      `[skybase] loaded ${hosts.list().length} host(s): ${hosts
        .list()
        .map((h) => h.id)
        .join(", ")}`,
    );
  } else {
    console.warn(
      `[skybase] no hosts config at ${env.hostsConfigPath}; ` +
        `WS attaches will fail until you create one. ` +
        `Local-bash dev mode is available via ?local=1.`,
    );
  }

  // Web Push (optional — server runs without it for local dev).
  let webPush: WebPushSink | undefined;
  if (env.vapidJson) {
    const vapid = parseVapidJson(env.vapidJson);
    webPush = new WebPushSink(vapid, env.subscriptionsPath);
    await webPush.load();
  } else {
    console.warn("[skybase] no VAPID config; Web Push disabled");
  }

  // Webhook (optional).
  const webhook = env.webhookUrl
    ? new HttpWebhookSink(env.webhookUrl, env.webhookToken)
    : undefined;

  const dispatcher = new NotificationDispatcher({ webPush, webhook });
  setInterval(() => dispatcher.prune(), 30_000).unref();

  // ─── Fastify ──────────────────────────────────────────────────────────
  // Debug-level logging so the per-input `[ws input]` line shows up in the
  // dev log without having to recompile. Set SKYBASE_LOG_LEVEL=info in prod
  // to drop these.
  const app = Fastify({
    logger: { level: process.env.SKYBASE_LOG_LEVEL ?? "debug" },
  });
  await app.register(websocketPlugin);

  // Health check (used by GCP LB).
  app.get("/healthz", async () => ({ ok: true }));

  // ─── HTTP API ─────────────────────────────────────────────────────────
  app.get("/api/hosts", async () => ({ hosts: hosts.publicList() }));

  /**
   * List existing tmux sessions on a host. Returns `{ sessions: [] }` for
   * hosts where no tmux server is currently running. Errors out (502) for
   * unreachable hosts so the UI can show a stale-data indicator instead of
   * silently pretending there are no sessions.
   */
  app.get<{ Params: { id: string } }>(
    "/api/hosts/:id/sessions",
    async (req, reply) => {
      const host = hosts.get(req.params.id);
      if (!host) return reply.code(404).send({ error: "unknown host" });
      const identityFiles = host.identityFile
        ? [host.identityFile]
        : env.sshKeyPaths;
      try {
        const opts: Parameters<typeof listRemoteTmuxSessions>[0] = {
          host,
          identityFiles,
        };
        if (env.sshKnownHostsPath) opts.knownHostsFile = env.sshKnownHostsPath;
        const sessions = await listRemoteTmuxSessions(opts);
        return { sessions };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(502).send({ error: message });
      }
    },
  );

  /**
   * Kill a tmux session on a host. This destroys the session and SIGHUPs
   * every process inside it — there is no undo. The frontend confirms with
   * the user before calling this. Returns 204 on success, 404 for unknown
   * host, 502 for ssh-level failures.
   */
  app.delete<{ Params: { id: string; name: string } }>(
    "/api/hosts/:id/sessions/:name",
    async (req, reply) => {
      const host = hosts.get(req.params.id);
      if (!host) return reply.code(404).send({ error: "unknown host" });
      const identityFiles = host.identityFile
        ? [host.identityFile]
        : env.sshKeyPaths;
      try {
        const opts: Parameters<typeof killRemoteTmuxSession>[0] = {
          host,
          identityFiles,
          tmuxName: req.params.name,
        };
        if (env.sshKnownHostsPath) opts.knownHostsFile = env.sshKnownHostsPath;
        await killRemoteTmuxSession(opts);
        return reply.code(204).send();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(502).send({ error: message });
      }
    },
  );

  app.get("/api/push/vapid", async (_req, reply) => {
    if (!webPush) return reply.code(503).send({ error: "push disabled" });
    return { publicKey: webPush.publicKey() };
  });

  app.post("/api/push/subscribe", async (req, reply) => {
    if (!webPush) return reply.code(503).send({ error: "push disabled" });
    const body = req.body as PushSubscribeRequest;
    if (!body?.subscription?.endpoint) {
      return reply.code(400).send({ error: "missing subscription" });
    }
    return webPush.subscribe(body);
  });

  app.post("/api/push/unsubscribe", async (req, reply) => {
    if (!webPush) return reply.code(503).send({ error: "push disabled" });
    const body = req.body as { endpoint?: string };
    if (!body?.endpoint) {
      return reply.code(400).send({ error: "missing endpoint" });
    }
    await webPush.unsubscribe(body.endpoint);
    return { ok: true };
  });

  /**
   * Send a self-test notification — used by the "test notification" button
   * in the PWA so the user can verify VAPID + service worker + iOS standalone
   * permissions are wired up correctly.
   */
  app.post("/api/push/test", async (req, reply) => {
    if (!webPush) return reply.code(503).send({ error: "push disabled" });
    const body = (req.body ?? {}) as PushTestRequest;
    await webPush.push({
      t: "notify",
      sessionId: "__test__",
      hostId: "__test__",
      title: body.title ?? "skybase test",
      body: body.body ?? "If you see this, push works.",
      timestamp: Date.now(),
    });
    return { ok: true };
  });

  // ─── WebSocket: PTY + notification stream ─────────────────────────────
  app.register(async (instance) => {
    instance.get("/ws", { websocket: true }, (socket, req) => {
      const sessions = new Map<string, PtySession>();
      const localMode = (req.query as { local?: string }).local === "1";

      const send = (msg: ServerMessage): void => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(msg));
        }
      };

      // Initial inventory.
      send({
        t: "sessions",
        hosts: hosts.publicList(),
        sessions: [],
      });

      socket.on("message", (raw: Buffer) => {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(raw.toString("utf8")) as ClientMessage;
        } catch {
          return;
        }

        switch (msg.t) {
          case "attach": {
            if (sessions.has(msg.sessionId)) return;
            const spawn = buildSpawnOpts(msg, hosts, localMode);
            if (!spawn) {
              send({
                t: "error",
                sessionId: msg.sessionId,
                message: `unknown host "${msg.hostId}"`,
              });
              return;
            }
            const session = new PtySession({
              sessionId: msg.sessionId,
              hostId: msg.hostId,
              spawn,
              callbacks: {
                send,
                onNotification: (event) => {
                  const out = dispatcher.dispatch({
                    sessionId: msg.sessionId,
                    hostId: msg.hostId,
                    event,
                  });
                  if (out) send(out);
                },
                onExit: () => {
                  sessions.delete(msg.sessionId);
                },
              },
            });
            sessions.set(msg.sessionId, session);
            session.start();
            break;
          }

          case "input": {
            // Diagnostic: log the byte length so we can correlate against
            // the client-side `[skybase term#N] onData` log when chasing
            // duplicate-keystroke bugs. Decoding base64 is cheap enough.
            try {
              const len = Buffer.from(msg.b64, "base64").length;
              app.log.debug(
                `[ws input] session=${msg.sessionId} bytes=${len}`,
              );
            } catch {
              // ignore
            }
            sessions.get(msg.sessionId)?.write(msg.b64);
            break;
          }

          case "resize": {
            sessions.get(msg.sessionId)?.resize(msg.cols, msg.rows);
            break;
          }

          case "detach": {
            const s = sessions.get(msg.sessionId);
            if (s) {
              s.kill();
              sessions.delete(msg.sessionId);
            }
            break;
          }

          case "focus": {
            dispatcher.setFocus(msg.sessionId);
            break;
          }
        }
      });

      socket.on("close", () => {
        // Tear down all PTYs owned by this socket.
        for (const s of sessions.values()) s.kill();
        sessions.clear();
        dispatcher.setFocus(null);
      });
    });
  });

  // ─── Static web client (production build) ─────────────────────────────
  const webDist = resolve(process.cwd(), "../web/dist");
  if (existsSync(webDist)) {
    const fastifyStatic = await import("@fastify/static");
    await app.register(fastifyStatic.default, {
      root: webDist,
      prefix: "/",
    });
    app.setNotFoundHandler(async (req, reply) => {
      // SPA fallback — route everything that isn't an API call to index.html.
      if (req.url.startsWith("/api") || req.url.startsWith("/ws")) {
        return reply.code(404).send({ error: "not found" });
      }
      const indexPath = resolve(webDist, "index.html");
      const html = await readFile(indexPath, "utf8");
      return reply.type("text/html").send(html);
    });
  }

  // ─── Listen ───────────────────────────────────────────────────────────
  await app.listen({ host: env.host, port: env.port });
  console.log(`[skybase] listening on http://${env.host}:${env.port}`);
}

function buildSpawnOpts(
  msg: { hostId: string; tmuxName: string; cols: number; rows: number },
  hosts: HostRegistry,
  localMode: boolean,
): SpawnOpts | null {
  if (localMode || msg.hostId === "__local__") {
    return { kind: "local", cols: msg.cols, rows: msg.rows };
  }
  const host = hosts.get(msg.hostId);
  if (!host) return null;
  // Per-host identityFile (if set) wins over the global candidate list.
  const identityFiles = host.identityFile
    ? [host.identityFile]
    : env.sshKeyPaths;
  const opts: SpawnOpts = {
    kind: "ssh",
    cols: msg.cols,
    rows: msg.rows,
    user: host.user,
    host: host.host,
    identityFiles,
    tmuxName: msg.tmuxName || host.defaultTmuxName || "main",
  };
  if (host.port !== undefined) opts.port = host.port;
  if (env.sshKnownHostsPath) opts.knownHostsFile = env.sshKnownHostsPath;
  if (host.proxyJump) opts.proxyJump = host.proxyJump;
  return opts;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
