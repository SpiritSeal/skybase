// Mobile action bar — a thin strip of buttons for keys that are hard (or
// impossible) to type on a phone's soft keyboard. Sits at the bottom of the
// terminal host, above the on-screen keyboard when it's open. Only renders
// when the viewport is narrow enough to be a phone.
//
// Buttons send raw byte sequences through the WebSocket, exactly like the
// macOS key remapper in Terminal.tsx does for Cmd/Option combos.

import type { WsClient } from "./wsClient.js";

const utf8Encoder = new TextEncoder();
function utf8ToBase64(s: string): string {
  const bytes = utf8Encoder.encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]!);
  }
  return btoa(bin);
}

interface ActionBarProps {
  ws: WsClient;
  sessionId: string;
}

interface ActionButton {
  label: string;
  /** Tooltip shown on long-press / hover. */
  title: string;
  /** Raw bytes to send. */
  bytes: string;
}

// tmux prefix is Ctrl+B (\x02). After pressing prefix, the next key is
// interpreted as a tmux command (e.g., arrow to switch panes, [ to enter
// copy-mode, d to detach, c to create a new window, etc.).
const ACTIONS: ActionButton[] = [
  { label: "Esc", title: "Escape — cancel / exit copy-mode", bytes: "\x1b" },
  { label: "^B", title: "Ctrl+B — tmux prefix", bytes: "\x02" },
  { label: "^C", title: "Ctrl+C — interrupt", bytes: "\x03" },
  { label: "^D", title: "Ctrl+D — EOF / exit", bytes: "\x04" },
  { label: "Tab", title: "Tab — autocomplete", bytes: "\t" },
  { label: "↑", title: "Arrow up (or scroll in copy-mode)", bytes: "\x1b[A" },
  { label: "↓", title: "Arrow down", bytes: "\x1b[B" },
  { label: "←", title: "Arrow left", bytes: "\x1b[D" },
  { label: "→", title: "Arrow right", bytes: "\x1b[C" },
];

export function ActionBar({ ws, sessionId }: ActionBarProps): JSX.Element {
  const send = (bytes: string): void => {
    ws.send({
      t: "input",
      sessionId,
      b64: utf8ToBase64(bytes),
    });
  };

  return (
    <div className="action-bar">
      {ACTIONS.map((a) => (
        <button
          key={a.label}
          className="action-btn"
          title={a.title}
          onPointerDown={(e) => {
            e.preventDefault(); // don't steal focus from the terminal
            send(a.bytes);
          }}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}
