// YAML host registry loader. Hot-reloads on file change so the user can edit
// hosts.yaml without restarting the server.
//
// Schema:
//   hosts:
//     - id: prod-box           # required, unique, used in URLs
//       label: "Prod box"      # required, human-friendly
//       host: 1.2.3.4          # required, hostname or IP
//       user: spyre            # required, ssh user
//       port: 22               # optional, defaults to 22
//       identityFile: ...      # optional, defaults to env.sshKeyPath
//       proxyJump: ...         # optional, ssh -J value
//       defaultTmuxName: main  # optional, defaults to "main"

import { readFile, watch as watchFs } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { HostInfo } from "@skybase/shared";

export interface HostEntry {
  id: string;
  label: string;
  host: string;
  user: string;
  port?: number;
  identityFile?: string;
  proxyJump?: string;
  defaultTmuxName?: string;
}

interface HostsFile {
  hosts: HostEntry[];
}

export class HostRegistry {
  private entries: HostEntry[] = [];
  private byId = new Map<string, HostEntry>();
  private listeners = new Set<() => void>();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    const text = await new Promise<string>((resolve, reject) => {
      readFile(this.path, "utf8", (err, data) =>
        err ? reject(err) : resolve(data),
      );
    });
    const parsed = parseYaml(text) as HostsFile | null;
    const list = parsed?.hosts ?? [];
    if (!Array.isArray(list)) {
      throw new Error(`${this.path}: 'hosts' must be a list`);
    }
    const seen = new Set<string>();
    for (const h of list) {
      if (!h.id || !h.label || !h.host || !h.user) {
        throw new Error(
          `${this.path}: each host needs id, label, host, user`,
        );
      }
      if (seen.has(h.id)) {
        throw new Error(`${this.path}: duplicate host id "${h.id}"`);
      }
      seen.add(h.id);
    }
    this.entries = list;
    this.byId = new Map(list.map((h) => [h.id, h]));
    for (const fn of this.listeners) fn();
  }

  /**
   * Watch the YAML file for changes and reload. fs.watch can fire spuriously
   * (especially on macOS APFS), so we debounce.
   */
  watch(): void {
    let timer: NodeJS.Timeout | null = null;
    watchFs(this.path, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        this.load().catch((err) => {
          console.error(`[hosts] reload failed:`, err);
        });
      }, 100);
    });
  }

  list(): HostEntry[] {
    return this.entries;
  }

  publicList(): HostInfo[] {
    return this.entries.map((h) => ({ id: h.id, label: h.label }));
  }

  get(id: string): HostEntry | undefined {
    return this.byId.get(id);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
