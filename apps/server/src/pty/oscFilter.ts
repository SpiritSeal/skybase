// Stateful byte-stream filter that strips notification OSC sequences out of
// PTY output and emits them as structured events. The rest of the byte
// stream (including unrelated OSC sequences like window-title set OSC 0/2)
// passes through untouched so xterm.js renders normally.
//
// Recognized:
//   OSC 9   — iTerm2:    ESC ] 9 ; <body> ST                    → body only
//   OSC 777 — rxvt:      ESC ] 777 ; notify ; <title> ; <body> ST → title + body
//   OSC 99  — kitty:     ESC ] 99 ; <key=val:...> ; <payload> ST  → title and/or
//             body, with optional `i=<id>` for dedup. We support the
//             single-chunk form; multi-chunk (d=0/d=1) is rare in practice.
//
// ST is either BEL (0x07) or ESC \\ (0x1b 0x5c). Both are accepted everywhere.
//
// State machine:
//   GROUND   — normal terminal output, passes straight through
//   ESC      — saw ESC, deciding what kind of sequence
//   OSC      — collecting OSC body until ST
//   OSC_ESC  — saw ESC inside OSC; if next is `\\`, that's the ST terminator
//
// Critically: state persists across chunks. The PTY may hand us a chunk that
// ends mid-sequence; we hold the buffer and resume on the next chunk. Do NOT
// rewrite this as a per-chunk regex — it will lose split sequences.
//
// Tmux passthrough: when running inside tmux, the notify script wraps the
// OSC in `ESC P tmux ; ESC <seq> ESC \`. tmux strips that wrapper before
// forwarding, so by the time the bytes reach our PTY here on the server they
// are already bare OSC sequences. We do NOT handle the DCS Ptmux envelope —
// if it reaches us, it means the user has `allow-passthrough off` and tmux
// would have dropped the whole thing anyway.

const ESC = "\x1b";
const BEL = "\x07";
const BACKSLASH = "\x5c";

const enum State {
  GROUND,
  ESC_SEEN,
  OSC,
  OSC_ESC,
}

export interface OscEvent {
  /** Notification body (always set; may be empty string). */
  body: string;
  /** Notification title (may be empty). */
  title: string;
  /** Optional dedup id from OSC 99 `i=<id>`. */
  dedupeId?: string;
  /** Which OSC variant fired (for diagnostics). */
  source: "osc9" | "osc99" | "osc777";
}

export interface OscFilterResult {
  /** Bytes to forward to xterm.js. May be empty if the chunk was all OSC. */
  cleaned: string;
  /** Notifications extracted from this chunk. */
  events: OscEvent[];
}

export class OscFilter {
  private state: State = State.GROUND;
  /** OSC body accumulator (between `]` and ST). */
  private oscBuf = "";
  /**
   * Pending output bytes that we may or may not emit, depending on whether
   * the next byte completes a recognized stripped sequence. Used for the ESC
   * we saw before knowing what comes next.
   */
  private pending = "";

  feed(input: string): OscFilterResult {
    let out = "";
    const events: OscEvent[] = [];

    for (let i = 0; i < input.length; i++) {
      const c = input[i]!;

      switch (this.state) {
        case State.GROUND:
          if (c === ESC) {
            this.state = State.ESC_SEEN;
            this.pending = ESC;
          } else {
            out += c;
          }
          break;

        case State.ESC_SEEN:
          if (c === "]") {
            // Entering OSC. Discard the pending ESC — we may strip the whole
            // thing. If it turns out to be an unrecognized OSC, we re-emit
            // ESC + ] + buf + terminator at the end.
            this.state = State.OSC;
            this.oscBuf = "";
            this.pending = "";
          } else {
            // Not an OSC; flush pending ESC and this char back into output.
            out += this.pending + c;
            this.pending = "";
            this.state = State.GROUND;
          }
          break;

        case State.OSC:
          if (c === BEL) {
            // BEL terminator.
            const ev = parseOsc(this.oscBuf);
            if (ev) {
              events.push(ev);
            } else {
              // Unrecognized OSC — pass it through verbatim (with BEL
              // terminator preserved).
              out += ESC + "]" + this.oscBuf + BEL;
            }
            this.oscBuf = "";
            this.state = State.GROUND;
          } else if (c === ESC) {
            this.state = State.OSC_ESC;
          } else if (c === "\x18" || c === "\x1a") {
            // CAN / SUB — abort the sequence per ECMA-48. Drop silently.
            this.oscBuf = "";
            this.state = State.GROUND;
          } else {
            this.oscBuf += c;
          }
          break;

        case State.OSC_ESC:
          if (c === BACKSLASH) {
            // ESC \ — ST terminator.
            const ev = parseOsc(this.oscBuf);
            if (ev) {
              events.push(ev);
            } else {
              out += ESC + "]" + this.oscBuf + ESC + BACKSLASH;
            }
            this.oscBuf = "";
            this.state = State.GROUND;
          } else if (c === ESC) {
            // Two ESCs in a row inside OSC — uncommon. Keep one in the buffer
            // and stay in OSC_ESC waiting for the next char.
            this.oscBuf += ESC;
          } else {
            // The ESC was just data inside the OSC body. Push it back and
            // re-process this char in OSC state.
            this.oscBuf += ESC;
            this.state = State.OSC;
            i--; // re-feed current char
          }
          break;
      }
    }

    return { cleaned: out, events };
  }

  /** Reset state. Useful for tests. */
  reset(): void {
    this.state = State.GROUND;
    this.oscBuf = "";
    this.pending = "";
  }
}

/**
 * Parse an OSC body (the bytes between `ESC ]` and the terminator) into a
 * notification event. Returns null if the OSC is not one we want to strip
 * (e.g. OSC 0 / 2 for window title).
 */
function parseOsc(buf: string): OscEvent | null {
  // Find the command number — digits up to the first `;`.
  const semi = buf.indexOf(";");
  if (semi <= 0) return null;
  const cmd = buf.slice(0, semi);
  const rest = buf.slice(semi + 1);

  switch (cmd) {
    case "9":
      // iTerm2: `9;<body>`. No title.
      return { source: "osc9", title: "", body: rest };

    case "777": {
      // rxvt: `777;notify;<title>;<body>`. Must start with `notify;` —
      // OSC 777 is also used for other things (e.g. `777;preexec`).
      if (!rest.startsWith("notify;")) return null;
      const after = rest.slice("notify;".length);
      // Title and body are semicolon-separated. The body itself MAY contain
      // semicolons; per rxvt's de-facto convention there are exactly two
      // fields, so we split on the FIRST semicolon only.
      const sep = after.indexOf(";");
      if (sep < 0) {
        return { source: "osc777", title: after, body: "" };
      }
      return {
        source: "osc777",
        title: after.slice(0, sep),
        body: after.slice(sep + 1),
      };
    }

    case "99": {
      // kitty: `99;<metadata>;<payload>`.
      // metadata is colon-separated key=value pairs. Common keys:
      //   i=<id>     notification id (for dedup / multi-chunk aggregation)
      //   p=title    payload is the title
      //   p=body     payload is the body (default)
      //   d=0|1      multi-chunk done marker (we don't fully support multi)
      const metaSep = rest.indexOf(";");
      const metaStr = metaSep < 0 ? rest : rest.slice(0, metaSep);
      const payload = metaSep < 0 ? "" : rest.slice(metaSep + 1);

      let dedupeId: string | undefined;
      let part: "title" | "body" = "body";
      if (metaStr.length > 0) {
        for (const kv of metaStr.split(":")) {
          const eq = kv.indexOf("=");
          if (eq < 0) continue;
          const k = kv.slice(0, eq);
          const v = kv.slice(eq + 1);
          if (k === "i") dedupeId = v;
          else if (k === "p") {
            if (v === "title") part = "title";
            else if (v === "body") part = "body";
          }
        }
      }
      const ev: OscEvent = {
        source: "osc99",
        title: part === "title" ? payload : "",
        body: part === "body" ? payload : "",
      };
      if (dedupeId !== undefined) ev.dedupeId = dedupeId;
      return ev;
    }

    default:
      return null;
  }
}
