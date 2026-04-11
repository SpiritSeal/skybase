// PtySession ties together: a node-pty IPty, an OSC byte filter that strips
// notification escape sequences from the data stream, and a callback fanout
// to the WS client + notification dispatcher. One PtySession per attached
// terminal.

import type { IPty } from "node-pty";
import type { ServerMessage } from "@skybase/shared";
import { OscFilter, type OscEvent } from "./oscFilter.js";
import { spawnPty, type SpawnOpts } from "./spawn.js";

export interface PtySessionCallbacks {
  /** Send a server-bound message to the WS client. base64 encoded for `data`. */
  send: (msg: ServerMessage) => void;
  /** Notification extracted from the byte stream. */
  onNotification: (ev: OscEvent) => void;
  /** PTY exited (clean or otherwise). */
  onExit: (reason: string) => void;
}

export interface PtySessionInit {
  sessionId: string;
  hostId: string;
  spawn: SpawnOpts;
  callbacks: PtySessionCallbacks;
}

export class PtySession {
  readonly sessionId: string;
  readonly hostId: string;
  private pty: IPty | null = null;
  private filter: OscFilter;
  private cb: PtySessionCallbacks;
  private spawnOpts: SpawnOpts;
  private exited = false;

  constructor(init: PtySessionInit) {
    this.sessionId = init.sessionId;
    this.hostId = init.hostId;
    this.spawnOpts = init.spawn;
    this.cb = init.callbacks;
    this.filter = new OscFilter();
  }

  start(): void {
    const pty = spawnPty(this.spawnOpts);
    this.pty = pty;

    pty.onData((chunk: string) => {
      // node-pty decodes the PTY's UTF-8 byte stream into a JS string for
      // us. The OSC filter operates on JS chars; OSC sequences are ASCII
      // so they survive UTF-8 decoding intact and the filter finds them
      // correctly even when the surrounding stream has multibyte chars.
      //
      // For sending to the client we encode `cleaned` as UTF-8 (NOT as
      // Latin-1 via the "binary" encoding) so that emoji, CJK, accented
      // letters etc. round-trip without being mangled into garbage on the
      // browser side.
      const { cleaned, events } = this.filter.feed(chunk);
      if (cleaned.length > 0) {
        this.cb.send({
          t: "data",
          sessionId: this.sessionId,
          b64: Buffer.from(cleaned, "utf8").toString("base64"),
        });
      }
      for (const ev of events) this.cb.onNotification(ev);
    });

    pty.onExit(({ exitCode, signal }) => {
      if (this.exited) return;
      this.exited = true;
      const reason =
        signal !== undefined && signal !== 0
          ? `signal ${signal}`
          : `exit ${exitCode}`;
      this.cb.send({ t: "closed", sessionId: this.sessionId, reason });
      this.cb.onExit(reason);
    });

    this.cb.send({
      t: "attached",
      sessionId: this.sessionId,
      cols: this.spawnOpts.cols,
      rows: this.spawnOpts.rows,
    });
  }

  /** Forward base64-encoded keystrokes from the client to the PTY. */
  write(b64: string): void {
    if (!this.pty || this.exited) return;
    // Decode the base64 payload back into the original UTF-8 byte sequence,
    // then re-decode as a JS string before handing it to node-pty.
    // node-pty's `write(string)` re-encodes the string as UTF-8 on the way
    // out to the PTY, so this round-trip preserves multibyte characters
    // exactly. Decoding via "binary" (Latin-1) was the bug — node-pty would
    // double-encode every non-ASCII byte and ship garbage to the remote.
    const text = Buffer.from(b64, "base64").toString("utf8");
    this.pty.write(text);
  }

  resize(cols: number, rows: number): void {
    if (!this.pty || this.exited) return;
    if (cols <= 0 || rows <= 0) return;
    try {
      this.pty.resize(cols, rows);
    } catch {
      // pty may have just exited; safe to ignore.
    }
  }

  /**
   * Tear down the underlying PTY. SIGHUP so ssh notices and the remote tmux
   * server keeps running (tmux is parented to a daemon, not the ssh shell).
   */
  kill(): void {
    if (!this.pty || this.exited) return;
    this.exited = true;
    try {
      this.pty.kill("SIGHUP");
    } catch {
      // Already gone.
    }
  }
}
