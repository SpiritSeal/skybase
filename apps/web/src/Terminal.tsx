// xterm.js terminal panel. Owns one PTY session over the WebSocket; mounts on
// the active session and reattaches on disconnect.

import { useEffect, useRef } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import type { ServerMessage } from "@skybase/shared";
import type { WsClient } from "./wsClient.js";

// UTF-8-safe base64 helpers. The browser's btoa()/atob() only handle
// Latin-1 strings (chars 0-255) and throw `InvalidCharacterError` on
// anything else — that means pasting an emoji, a curly quote, an é, a CJK
// character, or any UTF-8 byte sequence breaks the input pipeline. We
// route everything through TextEncoder/Decoder so the byte stream over the
// WebSocket is the actual UTF-8 bytes the remote PTY expects.
const utf8Encoder = new TextEncoder();
function utf8ToBase64(s: string): string {
  const bytes = utf8Encoder.encode(s);
  // Build a Latin-1 string from the bytes so btoa accepts it. Manual loop
  // instead of String.fromCharCode(...bytes) because the spread operator
  // can blow the call stack on large pastes.
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]!);
  }
  return btoa(bin);
}
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface TerminalProps {
  ws: WsClient;
  sessionId: string;
  hostId: string;
  tmuxName: string;
}

export function TerminalPanel({
  ws,
  sessionId,
  hostId,
  tmuxName,
}: TerminalProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Xterm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // HARD GUARD: dispose any orphaned term from a previous mount/HMR cycle.
    // In normal React this is impossible — cleanup runs before the next
    // effect — but vite-plugin-react's Fast Refresh sometimes skips the
    // cleanup phase on hot updates, leaving the previous Terminal instance
    // alive with its onData listeners still attached. The result is every
    // keystroke fires through *both* the orphan and the live term, sending
    // each input message twice over the WebSocket.
    if (xtermRef.current) {
      try {
        xtermRef.current.dispose();
      } catch {
        // Already disposed; fine.
      }
      xtermRef.current = null;
      fitRef.current = null;
    }
    // Also nuke any leftover xterm DOM that might have been left in the
    // container by an orphaned term (multiple .xterm subtrees stacked).
    while (container.firstChild) container.removeChild(container.firstChild);

    // Async setup so we can `await document.fonts.load(...)` BEFORE creating
    // the xterm.Terminal — otherwise xterm.js measures glyph widths against
    // whatever fallback font is current at construction time, and the cell
    // grid is wrong forever even after JetBrains Mono finishes loading. This
    // is the root cause of the `│` rendering as `I`, etc.
    //
    // Cleanup contract: a `state` object is the single source of truth that
    // both the async setup and the cleanup callback can see. The cleanup
    // disposes whatever the async has produced *so far* — even if the async
    // races with HMR re-mounts. If the async hasn't created the term yet, it
    // sees `state.cancelled` and bails out without ever creating one.
    const state: {
      cancelled: boolean;
      term: Xterm | null;
      disposers: Array<() => void>;
    } = { cancelled: false, term: null, disposers: [] };

    void (async () => {
      // Force-load JetBrains Mono regular and bold. document.fonts.load
      // returns a Promise that resolves once the font is in the document
      // font set and ready to render — even if the @font-face was declared
      // but never used (browsers lazy-load).
      if ("fonts" in document) {
        try {
          await Promise.all([
            document.fonts.load("13px 'JetBrains Mono'"),
            document.fonts.load("bold 13px 'JetBrains Mono'"),
          ]);
        } catch {
          // Non-fatal — we'll still create the term, just with fallback metrics.
        }
      }
      if (state.cancelled) return;

      // Verify the bundled font actually loaded. If not, log loudly so we
      // notice in dev — the user will probably see misaligned glyphs.
      const jetbrainsLoaded = Array.from(document.fonts).some(
        (f) => f.family === "JetBrains Mono" && f.status === "loaded",
      );
      console.info(
        `[skybase terminal] JetBrains Mono ${
          jetbrainsLoaded ? "loaded ✓" : "NOT LOADED ✗ — falling back to system mono"
        }`,
      );

      const term = new Xterm({
        cursorBlink: true,
        // JetBrains Mono is bundled as a web font in main.tsx and we just
        // awaited its load above, so glyph measurement happens against the
        // real font. System fonts come after as fallbacks.
        fontFamily:
          '"JetBrains Mono", "SF Mono", "Menlo", "Cascadia Code", "DejaVu Sans Mono", monospace',
        fontSize: 13,
        theme: {
          background: "#0a0a0a",
          foreground: "#e6e6e6",
          cursor: "#e6e6e6",
        },
        scrollback: 5000,
        // allowProposedApi is required for the Unicode 11 addon.
        allowProposedApi: true,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());

      // Unicode 11 width tables. Without this, xterm.js uses Unicode 6 widths
      // from 2010, which mis-measure many emoji, CJK characters, and the
      // newer symbols modern TUIs (Claude Code, gum, charm.sh stuff) use.
      // The wrong width by even one cell makes lines wrap at the wrong column
      // and screen-position math drift, which manifests as overlapping status
      // bars and garbled redraws.
      term.loadAddon(new Unicode11Addon());

      term.open(container);

      // Activate Unicode 11 widths AFTER open(), per xterm.js docs — the
      // unicode service is fully wired up at that point.
      term.unicode.activeVersion = "11";

      fit.fit();

      xtermRef.current = term;
      fitRef.current = fit;
      state.term = term;

      // Hand control off to the rest of the setup, which expects `term`,
      // `fit`, and the (now-non-null) container to exist. The returned
      // disposer chain is recorded on `state` so the parent cleanup can
      // tear everything down even if it fires after this point.
      const disposer = setupAfterTermReady(term, fit, container);
      state.disposers.push(disposer);

      // Edge case: parent cleanup may have run while we were awaiting fonts
      // (HMR or fast unmount). If so, the term we just created is orphaned —
      // dispose it immediately ourselves.
      if (state.cancelled) {
        for (const d of state.disposers.splice(0)) d();
        state.term = null;
      }
    })();

    return () => {
      state.cancelled = true;
      for (const d of state.disposers.splice(0)) d();
      if (state.term) {
        try {
          state.term.dispose();
        } catch {
          // Already disposed by setup disposer above; ignore.
        }
        state.term = null;
      }
      // Wipe the refs so the parent component never holds onto a dead term.
      if (xtermRef.current === state.term) xtermRef.current = null;
      if (fitRef.current && state.term === null) fitRef.current = null;
    };

    /**
     * Everything that needs the xterm.Terminal to exist: input forwarding,
     * WS message handling, resize observer, attach lifecycle, key remap.
     * Returns its own cleanup function.
     */
    function setupAfterTermReady(
      term: Xterm,
      fit: FitAddon,
      container: HTMLDivElement,
    ): () => void {

    // ─── macOS-style key remapping ──────────────────────────────────────
    // The browser swallows Cmd+anything by default and xterm.js doesn't
    // know how to translate macOS line-editing chords into readline /
    // bash escape sequences. We intercept the relevant keys and emit the
    // bytes that bash, zsh, and Claude Code's input box already understand
    // (these are the same sequences iTerm2 / Terminal.app emit).
    //
    //   Cmd+Backspace      → Ctrl+U   (kill to start of line)
    //   Cmd+Delete         → Ctrl+K   (kill to end of line)
    //   Cmd+Left           → Ctrl+A   (start of line)
    //   Cmd+Right          → Ctrl+E   (end of line)
    //   Option+Backspace   → Ctrl+W   (delete word backward)
    //   Option+Left        → ESC b    (move word backward)
    //   Option+Right       → ESC f    (move word forward)
    //   Option+Delete      → ESC d    (delete word forward)
    //
    // attachCustomKeyEventHandler runs BEFORE xterm.js's default handler.
    // Returning false tells xterm.js "don't process this further" — we've
    // already sent the bytes via term.input() ourselves.
    const sendBytes = (bytes: string): void => {
      ws.send({
        t: "input",
        sessionId,
        b64: utf8ToBase64(bytes),
      });
      // We don't call term.write here — the remote shell will echo the
      // result back through the PTY data stream like normal typing.
    };
    term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
      if (ev.type !== "keydown") return true;
      const cmd = ev.metaKey;
      const opt = ev.altKey;
      const key = ev.key;
      // Only handle pure Cmd or pure Option chords. Ctrl combos pass
      // through to xterm.js's normal handler.
      if (!cmd && !opt) return true;

      if (cmd && !opt) {
        if (key === "Backspace") return sendBytes("\x15"), false; // ^U
        if (key === "Delete") return sendBytes("\x0b"), false;    // ^K
        if (key === "ArrowLeft") return sendBytes("\x01"), false;  // ^A
        if (key === "ArrowRight") return sendBytes("\x05"), false; // ^E
        // Cmd+K — clear scrollback (common terminal convention).
        if (key === "k" || key === "K") {
          term.clear();
          return false;
        }
        // Cmd+V — let it fall through to the browser. We listen for the
        // native `paste` event on the terminal container below, which gets
        // the clipboard text directly from the OS via `clipboardData` with
        // ZERO permission gating. The Clipboard API (readText) requires the
        // origin to have already written to the clipboard in the same
        // gesture chain, which silently blocks cross-app copy-paste.
        if (key === "v" || key === "V") return true;
        // Cmd+C — copy the current selection (if any) to the clipboard.
        // If there's no selection, we let it fall through so the browser
        // can do whatever its default behavior is (typically nothing in a
        // focused terminal). NOT mapped to ^C (interrupt) — that's the
        // standard expectation in iTerm2/Terminal.app.
        if (key === "c" || key === "C") {
          const sel = term.getSelection();
          if (sel) {
            void navigator.clipboard.writeText(sel).catch((err) => {
              console.warn("[skybase] clipboard write failed:", err);
            });
            ev.preventDefault();
            return false;
          }
          return true;
        }
        // Cmd+A — select all visible terminal contents.
        if (key === "a" || key === "A") {
          term.selectAll();
          return false;
        }
        // Let Cmd+R (reload), Cmd+T (new tab), Cmd+W (close), etc. fall
        // through to the browser.
        return true;
      }

      if (opt && !cmd) {
        if (key === "Backspace") return sendBytes("\x17"), false;  // ^W
        if (key === "ArrowLeft") return sendBytes("\x1bb"), false;  // ESC b
        if (key === "ArrowRight") return sendBytes("\x1bf"), false; // ESC f
        if (key === "Delete") return sendBytes("\x1bd"), false;     // ESC d
        // For other Option chords (Option+letter to type special chars),
        // let xterm.js handle the resulting character normally — its
        // default `onData` will fire with the composed character.
        return true;
      }

      return true;
    });

    // Send local input → WS. Uses utf8ToBase64 (NOT raw btoa) so that
    // multibyte UTF-8 characters in pasted text — emoji, curly quotes,
    // accented letters, CJK — survive the WebSocket round-trip instead of
    // throwing `InvalidCharacterError` and silently dropping the input.
    const inputDispose = term.onData((data) => {
      ws.send({
        t: "input",
        sessionId,
        b64: utf8ToBase64(data),
      });
    });

    // Native paste event handler. Fires whenever the user pastes (Cmd+V,
    // right-click → Paste, Edit menu → Paste, etc.) AND when the focused
    // element is anywhere inside the terminal container. The browser
    // populates `event.clipboardData` from the system clipboard at the
    // moment of the paste gesture, no permissions API required — this is
    // the same path Google Docs and friends use. We capture it on the
    // container so we catch the event regardless of which inner element
    // (canvas, helper textarea) actually has focus.
    const onPaste = (ev: ClipboardEvent): void => {
      const text = ev.clipboardData?.getData("text/plain") ?? "";
      if (text) {
        term.paste(text);
        ev.preventDefault();
      }
    };
    container.addEventListener("paste", onPaste);

    // Receive WS messages targeting this session. We pass the raw bytes
    // to xterm.js as a Uint8Array — xterm.js then handles the UTF-8 → cell
    // grid conversion internally and renders multibyte characters at the
    // correct widths. Passing a Latin-1 string (atob's return value) would
    // double-decode and corrupt anything outside ASCII.
    const off = ws.on((msg: ServerMessage) => {
      if (msg.t === "data" && msg.sessionId === sessionId) {
        term.write(base64ToBytes(msg.b64));
      } else if (msg.t === "closed" && msg.sessionId === sessionId) {
        term.write(`\r\n\x1b[33m[session closed: ${msg.reason}]\x1b[0m\r\n`);
      } else if (msg.t === "error" && msg.sessionId === sessionId) {
        term.write(`\r\n\x1b[31m[error: ${msg.message}]\x1b[0m\r\n`);
      } else if (msg.t === "attached" && msg.sessionId === sessionId) {
        // Server confirmed attach; resync size in case the local fit was
        // different from what we sent in the attach message.
        const { cols, rows } = term;
        ws.send({ t: "resize", sessionId, cols, rows });
      }
    });

    // Resize observer → debounced resize message.
    let resizeTimer: number | null = null;
    const ro = new ResizeObserver(() => {
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        try {
          fit.fit();
        } catch {
          // container detached; ignore
        }
        const { cols, rows } = term;
        if (cols > 0 && rows > 0) {
          ws.send({ t: "resize", sessionId, cols, rows });
        }
      }, 100);
    });
    ro.observe(container);

    // Send attach. Also re-send on every WS reconnect, because the server
    // forgets all PTY sessions on socket close. The server's `attach`
    // handler is idempotent (`if (sessions.has(id)) return`), so this is
    // safe to re-send when the session already exists locally.
    const sendAttach = (): void => {
      const { cols, rows } = term;
      ws.send({
        t: "attach",
        sessionId,
        hostId,
        tmuxName,
        cols,
        rows,
      });
    };
    sendAttach();
    let firstStatus = true;
    const offStatus = ws.onStatus((s) => {
      // onStatus fires immediately with the current status; skip the
      // initial firing so we don't double-attach on mount.
      if (firstStatus) {
        firstStatus = false;
        return;
      }
      if (s === "open") sendAttach();
    });

    term.focus();

      return () => {
        inputDispose.dispose();
        off();
        offStatus();
        ro.disconnect();
        container.removeEventListener("paste", onPaste);
        if (resizeTimer !== null) clearTimeout(resizeTimer);
        ws.send({ t: "detach", sessionId });
        term.dispose();
        xtermRef.current = null;
        fitRef.current = null;
      };
    } // end setupAfterTermReady
    // We intentionally don't depend on tmuxName/hostId here — changing the
    // session id by selecting a different sidebar entry remounts via React's
    // `key` prop in the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, sessionId]);

  return <div ref={containerRef} className="terminal-wrap" />;
}
