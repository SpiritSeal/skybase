// WebSocket message protocol shared between server and web client.
// All messages carry a discriminating `t` field for cheap dispatch.

export interface HostInfo {
  /** Stable id used in URLs and protocol messages. */
  id: string;
  /** Human-friendly label. */
  label: string;
}

export interface SessionInfo {
  /** `${hostId}:${tmuxName}` — globally unique within a skybase deployment. */
  id: string;
  hostId: string;
  /** tmux session name (passed to `tmux new -A -s`). */
  tmuxName: string;
}

// ─── Server → client ────────────────────────────────────────────────────────

/** Raw bytes from the PTY, after OSC stripping, base64 encoded. */
export interface SrvPtyData {
  t: "data";
  sessionId: string;
  /** base64 of the cleaned PTY byte chunk. */
  b64: string;
}

/** Server has finished initial attach and the PTY is ready for input. */
export interface SrvAttached {
  t: "attached";
  sessionId: string;
  cols: number;
  rows: number;
}

/** Underlying PTY closed (ssh dropped, tmux exited, etc.). */
export interface SrvClosed {
  t: "closed";
  sessionId: string;
  reason: string;
}

/** A notification was extracted from the byte stream. */
export interface SrvNotification {
  t: "notify";
  sessionId: string;
  hostId: string;
  title: string;
  body: string;
  /** Optional dedup id from OSC 99 `i=` parameter. */
  dedupeId?: string;
  /** ms since epoch. */
  timestamp: number;
}

/** Inventory of hosts and active sessions, sent on connect and on change. */
export interface SrvSessionList {
  t: "sessions";
  hosts: HostInfo[];
  sessions: SessionInfo[];
}

/** Generic error reply (auth, ssh failure, unknown session, etc.). */
export interface SrvError {
  t: "error";
  sessionId?: string;
  message: string;
}

export type ServerMessage =
  | SrvPtyData
  | SrvAttached
  | SrvClosed
  | SrvNotification
  | SrvSessionList
  | SrvError;

// ─── Client → server ────────────────────────────────────────────────────────

/** Open (or attach to) a tmux session on a host. */
export interface CliAttach {
  t: "attach";
  sessionId: string;
  hostId: string;
  tmuxName: string;
  cols: number;
  rows: number;
}

/** Detach from a session WS-side; tmux on the remote keeps running. */
export interface CliDetach {
  t: "detach";
  sessionId: string;
}

/** Keystrokes / paste data from the terminal, base64 encoded. */
export interface CliInput {
  t: "input";
  sessionId: string;
  b64: string;
}

/** xterm.js resized — must propagate down to the remote PTY. */
export interface CliResize {
  t: "resize";
  sessionId: string;
  cols: number;
  rows: number;
}

/**
 * The client tells the server which session is currently visible/focused.
 * Used by the notification dispatcher to suppress push for the focused session.
 * `sessionId === null` means no session is currently focused (e.g. tab hidden).
 */
export interface CliFocus {
  t: "focus";
  sessionId: string | null;
}

export type ClientMessage = CliAttach | CliDetach | CliInput | CliResize | CliFocus;

// ─── HTTP API types (Web Push, hosts) ───────────────────────────────────────

export interface PushSubscribeRequest {
  /** Standard browser PushSubscriptionJSON. */
  subscription: {
    endpoint: string;
    expirationTime: number | null;
    keys: { p256dh: string; auth: string };
  };
  /** Free-form device label so the user can manage subscriptions later. */
  deviceLabel?: string;
}

export interface PushTestRequest {
  title?: string;
  body?: string;
}

export interface WebhookPayload {
  title: string;
  body: string;
  sessionId: string;
  hostId: string;
  timestamp: number;
  dedupeId?: string;
}
