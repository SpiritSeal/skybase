// Centralized environment variable parsing. Fail fast at boot.

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Anchor for resolving repo-relative defaults. In dev the server runs from
// apps/server/ via tsx; in the prod container it runs from /app/apps/server.
// In both cases, walking up to find pnpm-workspace.yaml gives us the repo
// root reliably.
function findRepoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}
const REPO_ROOT = findRepoRoot();

function getEnv(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable: ${name}`);
}

function getEnvOpt(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

/**
 * Read a secret from a file path env var (e.g. SKYBASE_VAPID_FILE), falling
 * back to a literal env var (e.g. SKYBASE_VAPID_JSON). Container deployments
 * point at tmpfs-mounted secret files; local dev uses literals.
 */
function readSecret(fileEnv: string, literalEnv: string): string | undefined {
  const path = getEnvOpt(fileEnv);
  if (path) {
    if (!existsSync(path)) {
      throw new Error(`${fileEnv}=${path} but file does not exist`);
    }
    return readFileSync(path, "utf8").trim();
  }
  return getEnvOpt(literalEnv);
}

export const env = {
  port: parseInt(getEnv("PORT", "8080"), 10),
  host: getEnv("HOST", "0.0.0.0"),

  /** Path to YAML host registry. */
  hostsConfigPath: getEnv(
    "SKYBASE_HOSTS_CONFIG",
    resolve(REPO_ROOT, "config/hosts.yaml"),
  ),

  /**
   * Candidate SSH private keys for outgoing connections to remote hosts.
   * If SKYBASE_SSH_KEY is set, exactly that one key is used (single-file
   * production deploy from Secret Manager). Otherwise we auto-detect the
   * standard candidates in ~/.ssh in the same order the OS ssh client tries
   * them, filtering to ones that actually exist. ssh accepts multiple `-i`
   * flags and will try each in turn.
   */
  sshKeyPaths: (() => {
    const explicit = getEnvOpt("SKYBASE_SSH_KEY");
    if (explicit) return [explicit];
    const home = process.env.HOME ?? "";
    const candidates = [
      `${home}/.ssh/id_ed25519`,
      `${home}/.ssh/id_ecdsa`,
      `${home}/.ssh/id_rsa`,
      `${home}/.ssh/id_dsa`,
    ];
    return candidates.filter((p) => existsSync(p));
  })(),

  /** Path to known_hosts; pre-seeded in production via Secret Manager. */
  sshKnownHostsPath: getEnvOpt("SKYBASE_KNOWN_HOSTS"),

  /** VAPID keypair for Web Push (JSON: {publicKey, privateKey, subject}). */
  vapidJson: readSecret("SKYBASE_VAPID_FILE", "SKYBASE_VAPID_JSON"),

  /** Where to persist push subscriptions. */
  subscriptionsPath: getEnv(
    "SKYBASE_SUBSCRIPTIONS",
    resolve(REPO_ROOT, "data/subscriptions.json"),
  ),

  /** Outbound webhook URL + optional bearer token. */
  webhookUrl: getEnvOpt("SKYBASE_WEBHOOK_URL"),
  webhookToken: readSecret("SKYBASE_WEBHOOK_TOKEN_FILE", "SKYBASE_WEBHOOK_TOKEN"),

  /**
   * If true, the server trusts the `X-Goog-Authenticated-User-Email` header
   * set by IAP. Only enable when you're actually behind IAP, never on a
   * directly-exposed endpoint.
   */
  trustIap: getEnvOpt("SKYBASE_TRUST_IAP") === "1",
} as const;

export type Env = typeof env;
