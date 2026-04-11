// One-shot SSH helpers for tmux session admin (list, kill). Used by the
// /api/hosts/:id/sessions endpoints — both GET (list) and DELETE (kill).
//
// We deliberately do NOT go through node-pty here — there's no need for a
// PTY, no need for tmux passthrough, no need for the long-lived ssh process
// the streaming attach uses. A plain `child_process.execFile` with the
// command is faster and avoids leaking ssh clients on errors.

import { execFile } from "node:child_process";
import type { HostEntry } from "../config/hosts.js";

export interface ListSessionsOpts {
  host: HostEntry;
  identityFiles: string[];
  knownHostsFile?: string;
  /** Per-call timeout in ms — keeps unreachable hosts from blocking the UI. */
  timeoutMs?: number;
}

export interface KillSessionOpts extends ListSessionsOpts {
  /** tmux session name to kill. */
  tmuxName: string;
}

/**
 * Build the shared `ssh` argv used by both list and kill calls so the two
 * helpers stay in lockstep on auth/options.
 */
function buildSshArgs(opts: ListSessionsOpts): string[] {
  if (opts.identityFiles.length === 0) {
    throw new Error("buildSshArgs: no SSH identity files configured");
  }
  const args: string[] = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=8",
    "-o", "ServerAliveInterval=0",
    "-o", "IdentitiesOnly=yes",
  ];
  if (opts.knownHostsFile) {
    args.push("-o", `UserKnownHostsFile=${opts.knownHostsFile}`);
    args.push("-o", "StrictHostKeyChecking=yes");
  } else {
    args.push("-o", "StrictHostKeyChecking=accept-new");
  }
  for (const id of opts.identityFiles) {
    args.push("-i", id);
  }
  if (opts.host.port !== undefined) args.push("-p", String(opts.host.port));
  if (opts.host.proxyJump) args.push("-J", opts.host.proxyJump);
  args.push(`${opts.host.user}@${opts.host.host}`);
  return args;
}

/** POSIX shell quoting for a tmux session name passed in a remote command. */
function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export async function listRemoteTmuxSessions(
  opts: ListSessionsOpts,
): Promise<string[]> {
  // Ask tmux for one session name per line. If the tmux server isn't
  // running, tmux exits non-zero and prints "no server running on ..." to
  // stderr — we treat that as "no sessions" rather than an error via
  // `|| true`. Only ssh-level failures (auth, network) bubble up.
  const args = buildSshArgs(opts);
  args.push(`tmux list-sessions -F '#S' 2>/dev/null || true`);

  const stdout = await runSsh(args, opts.timeoutMs ?? 8000);
  return stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Kill a single tmux session on the remote host. Returns true if tmux
 * reported success (or the session was already gone), false if tmux is
 * running but the kill failed for some other reason. Throws on ssh-level
 * errors (auth, network).
 *
 * NOTE: this destroys the session. Any process running inside it (Claude
 * Code, a long-running build, etc.) gets SIGHUP and dies. There is no
 * undo. The frontend should confirm with the user before calling this.
 */
export async function killRemoteTmuxSession(
  opts: KillSessionOpts,
): Promise<void> {
  const args = buildSshArgs(opts);
  // `kill-session -t NAME` exits non-zero if NAME doesn't exist, which
  // we want to swallow (already gone == success from the caller's POV).
  args.push(
    `tmux kill-session -t ${shellQuote(opts.tmuxName)} 2>/dev/null || true`,
  );
  await runSsh(args, opts.timeoutMs ?? 8000);
}

function runSsh(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "ssh",
      args,
      { timeout: timeoutMs, maxBuffer: 1024 * 64 },
      (err, out) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(out);
      },
    );
    child.on("error", reject);
  });
}
