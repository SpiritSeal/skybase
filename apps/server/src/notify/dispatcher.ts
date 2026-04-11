// Notification dispatcher: takes events extracted by the OSC filter and fans
// them out to Web Push and webhook sinks. Implements:
//   - Dedupe / cooldown (don't spam if the same notification fires twice)
//   - Suppress-if-focused (don't push for the session the user is already
//     looking at)

import type { OscEvent } from "../pty/oscFilter.js";
import type { SrvNotification, WebhookPayload } from "@skybase/shared";
import { createHash } from "node:crypto";

export interface NotificationSink {
  /** Push to all subscribed devices. */
  push(payload: SrvNotification): Promise<void>;
}

export interface WebhookSink {
  send(payload: WebhookPayload): Promise<void>;
}

export interface DispatcherOpts {
  /** Cooldown window per (sessionId, dedupeKey) in ms. */
  cooldownMs?: number;
  webPush?: NotificationSink;
  webhook?: WebhookSink;
}

export class NotificationDispatcher {
  private cooldownMs: number;
  private webPush?: NotificationSink;
  private webhook?: WebhookSink;
  /** Last-fire timestamp keyed by `${sessionId}:${dedupeKey}`. */
  private lastFire = new Map<string, number>();
  /**
   * Currently focused session id from the client (or null if no client tab is
   * focused). Notifications matching this id are NOT pushed.
   */
  private focusedSessionId: string | null = null;
  /** Per-session unread count for badging. */
  private unread = new Map<string, number>();

  constructor(opts: DispatcherOpts = {}) {
    this.cooldownMs = opts.cooldownMs ?? 3000;
    this.webPush = opts.webPush;
    this.webhook = opts.webhook;
  }

  setFocus(sessionId: string | null): void {
    this.focusedSessionId = sessionId;
    if (sessionId !== null) this.unread.delete(sessionId);
  }

  getUnread(sessionId: string): number {
    return this.unread.get(sessionId) ?? 0;
  }

  /**
   * Dispatch a notification extracted from the byte stream. Returns the
   * SrvNotification to forward to the WS client (so the client can render an
   * in-app banner / update unread badges), or null if it was suppressed.
   */
  dispatch(args: {
    sessionId: string;
    hostId: string;
    event: OscEvent;
  }): SrvNotification | null {
    const { sessionId, hostId, event } = args;
    const now = Date.now();

    // Dedupe key: prefer explicit OSC 99 id; otherwise hash of title+body.
    const dedupeKey =
      event.dedupeId ??
      createHash("sha1")
        .update(event.title)
        .update("\u0000")
        .update(event.body)
        .digest("hex")
        .slice(0, 16);
    const key = `${sessionId}:${dedupeKey}`;

    const last = this.lastFire.get(key);
    if (last !== undefined && now - last < this.cooldownMs) {
      return null;
    }
    this.lastFire.set(key, now);

    const msg: SrvNotification = {
      t: "notify",
      sessionId,
      hostId,
      title: event.title,
      body: event.body,
      timestamp: now,
    };
    if (event.dedupeId !== undefined) msg.dedupeId = event.dedupeId;

    // Suppress out-of-band delivery if the user is already looking at this
    // session. We still return the message so it appears in the in-app log.
    const suppressed = this.focusedSessionId === sessionId;
    if (!suppressed) {
      this.unread.set(sessionId, (this.unread.get(sessionId) ?? 0) + 1);
      // Fire-and-forget — we don't want a slow webhook blocking the WS path.
      void this.fanout(msg);
    }

    return msg;
  }

  private async fanout(msg: SrvNotification): Promise<void> {
    const tasks: Promise<unknown>[] = [];
    if (this.webPush) {
      tasks.push(
        this.webPush.push(msg).catch((err) => {
          console.error("[notify] web push failed:", err);
        }),
      );
    }
    if (this.webhook) {
      const payload: WebhookPayload = {
        title: msg.title,
        body: msg.body,
        sessionId: msg.sessionId,
        hostId: msg.hostId,
        timestamp: msg.timestamp,
      };
      if (msg.dedupeId !== undefined) payload.dedupeId = msg.dedupeId;
      tasks.push(
        this.webhook.send(payload).catch((err) => {
          console.error("[notify] webhook failed:", err);
        }),
      );
    }
    await Promise.all(tasks);
  }

  /** Periodic cleanup of stale dedupe entries. Call from a setInterval. */
  prune(maxAgeMs = 60_000): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const [key, ts] of this.lastFire) {
      if (ts < cutoff) this.lastFire.delete(key);
    }
  }
}
