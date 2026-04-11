// Resilient WebSocket client to /ws. Handles auto-reconnect with backoff,
// queues outbound messages while disconnected, and dispatches incoming
// ServerMessages to typed listeners.

import type { ClientMessage, ServerMessage } from "@skybase/shared";

type Listener = (msg: ServerMessage) => void;

export class WsClient {
  private ws: WebSocket | null = null;
  private url: string;
  private listeners = new Set<Listener>();
  private outbox: ClientMessage[] = [];
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private closed = false;
  private statusListeners = new Set<(s: WsStatus) => void>();
  private status: WsStatus = "connecting";

  constructor(url?: string) {
    this.url = url ?? defaultWsUrl();
  }

  connect(): void {
    this.closed = false;
    this.openSocket();
  }

  private openSocket(): void {
    this.setStatus("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.setStatus("open");
      // Drain outbox.
      const queued = this.outbox.splice(0);
      for (const m of queued) ws.send(JSON.stringify(m));
    };

    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data) as ServerMessage;
      } catch {
        return;
      }
      for (const fn of this.listeners) fn(msg);
    };

    ws.onclose = () => {
      this.ws = null;
      if (this.closed) return;
      this.setStatus("reconnecting");
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will fire next.
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 15_000);
    this.reconnectAttempts++;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) this.openSocket();
    }, delay);
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.outbox.push(msg);
    }
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onStatus(fn: (s: WsStatus) => void): () => void {
    this.statusListeners.add(fn);
    fn(this.status);
    return () => this.statusListeners.delete(fn);
  }

  private setStatus(s: WsStatus): void {
    this.status = s;
    for (const fn of this.statusListeners) fn(s);
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}

export type WsStatus = "connecting" | "open" | "reconnecting";

function defaultWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}
