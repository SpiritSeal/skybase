// PTY spawning. Two modes:
//   - local: bash for Phase 2 development / smoke testing
//   - ssh:   ssh -tt user@host tmux new -A -s NAME (the production path)
//
// Both return a node-pty IPty so callers don't care which is which.

import { spawn, type IPty } from "node-pty";

export interface LocalSpawnOpts {
  kind: "local";
  cols: number;
  rows: number;
  /** Override the shell; defaults to $SHELL or /bin/bash. */
  shell?: string;
}

export interface SshSpawnOpts {
  kind: "ssh";
  cols: number;
  rows: number;
  user: string;
  host: string;
  port?: number;
  /**
   * One or more candidate private keys (`ssh -i ...`). ssh tries each in
   * order — the same way it does with multiple `IdentityFile` directives in
   * a config file. Pass a single-element array for the typical case.
   */
  identityFiles: string[];
  /** Optional pinned known_hosts. */
  knownHostsFile?: string;
  /** tmux session name. `tmux new -A -s <name>` attaches if exists. */
  tmuxName: string;
  /** Optional ProxyJump host. */
  proxyJump?: string;
}

export type SpawnOpts = LocalSpawnOpts | SshSpawnOpts;

export function spawnPty(opts: SpawnOpts): IPty {
  if (opts.kind === "local") {
    const shell = opts.shell ?? process.env.SHELL ?? "/bin/bash";
    return spawn(shell, [], {
      name: "xterm-256color",
      cols: opts.cols,
      rows: opts.rows,
      cwd: process.env.HOME ?? "/",
      env: { ...process.env, TERM: "xterm-256color" },
    });
  }

  // SSH path. We use the OS ssh client wrapped in a local PTY so the remote
  // sees a real TTY (`-tt` forces allocation even though we're not interactive
  // from ssh's perspective). All quoting is via argv — no shell interpolation.
  if (opts.identityFiles.length === 0) {
    throw new Error(
      "spawnPty: ssh mode requires at least one identityFile (none configured)",
    );
  }
  const args: string[] = [
    "-tt",
    "-o",
    "BatchMode=yes",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "ConnectTimeout=10",
    // IdentitiesOnly=yes prevents ssh from trying every key in the agent
    // (which can lock you out of hosts with MaxAuthTries=N if you have lots
    // of agent keys). Combined with explicit -i flags, ssh will only attempt
    // the keys we listed.
    "-o",
    "IdentitiesOnly=yes",
  ];
  for (const id of opts.identityFiles) {
    args.push("-i", id);
  }
  if (opts.knownHostsFile) {
    args.push("-o", `UserKnownHostsFile=${opts.knownHostsFile}`);
    args.push("-o", "StrictHostKeyChecking=yes");
  } else {
    // No pinned known_hosts → accept-new (TOFU). Production should pin.
    args.push("-o", "StrictHostKeyChecking=accept-new");
  }
  if (opts.port !== undefined) args.push("-p", String(opts.port));
  if (opts.proxyJump) args.push("-J", opts.proxyJump);

  args.push(`${opts.user}@${opts.host}`);

  // Remote command. Three things to know:
  //
  //   1. `new-session -A -s NAME` attaches if the session exists, creates
  //      it otherwise. The `exec` replaces the login shell so detach
  //      collapses the ssh session cleanly.
  //
  //   2. `set-option -g allow-passthrough on` is REQUIRED for OSC
  //      notification escape sequences to escape the tmux pane and reach
  //      our PTY on the skybase server. Tmux 3.5+ enables it by default
  //      but 3.4 and earlier default to off, which silently drops every
  //      `cmux notify` / `skybase notify` event. We set it on every spawn
  //      so users don't need to touch their remote `.tmux.conf` at all.
  //
  //   3. CRITICAL: the set-option and new-session must be chained inside a
  //      SINGLE `tmux` invocation with `\;` (tmux's command separator),
  //      not `;` (the shell's). If you run `tmux set-option -g X on` as a
  //      separate process, that tmux starts a server, sets the option,
  //      and exits — and because there are no sessions, the server dies
  //      with it. The next `tmux new-session` starts a brand-new server
  //      with all options at defaults. Chaining keeps both commands on
  //      the same server invocation.
  const tmuxName = shellQuote(opts.tmuxName);
  // Chain all tmux options in a single invocation so they share the same
  // server instance. Order matters: new-session first (creates the server
  // if needed), then global options + key bindings.
  //
  //   allow-passthrough on  — required for OSC notification forwarding
  //   mouse on              — enables touch-scroll (enters copy-mode +
  //                           scrolls scrollback), touch-tap to switch
  //                           panes, and touch-drag to resize panes.
  //                           Essential for mobile use.
  //
  // Key bindings (rebound to inherit the active pane's working directory
  // for new panes/windows — tmux's defaults start everything in $HOME):
  //   prefix + c    — new-window in current pane's path
  //   prefix + "    — split-window vertical in current pane's path
  //   prefix + %    — split-window horizontal in current pane's path
  //
  // `bind` / `set-option` are server-global tmux commands that update the
  // configuration in place without touching any running pane or process,
  // so re-running this on every attach (including reconnects to existing
  // sessions) is a no-op for users who are already in the middle of work.
  const remoteCmd =
    `exec tmux new-session -A -s ${tmuxName}` +
    ` \\; set-option -g allow-passthrough on` +
    ` \\; set-option -g mouse on` +
    ` \\; bind c new-window -c "#{pane_current_path}"` +
    ` \\; bind '"' split-window -c "#{pane_current_path}"` +
    ` \\; bind % split-window -h -c "#{pane_current_path}"`;
  args.push(remoteCmd);

  return spawn("ssh", args, {
    name: "xterm-256color",
    cols: opts.cols,
    rows: opts.rows,
    cwd: process.env.HOME ?? "/",
    env: { ...process.env, TERM: "xterm-256color" },
  });
}

/**
 * Single-arg POSIX shell quoting. Use only on values that will be embedded in
 * a remote command string (since ssh joins remote args with spaces and the
 * remote login shell parses them).
 */
function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
