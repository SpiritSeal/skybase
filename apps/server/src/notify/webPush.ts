// Web Push (VAPID) sender + on-disk subscription store. Designed for a
// single-user deployment — no per-user partitioning, just a flat JSON file
// of subscriptions.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import webpush from "web-push";
import type { SrvNotification, PushSubscribeRequest } from "@skybase/shared";
import type { NotificationSink } from "./dispatcher.js";

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  /** mailto: or https:// URL identifying the sender. */
  subject: string;
}

interface StoredSubscription extends PushSubscribeRequest {
  /** Server-assigned id (epoch ms). */
  id: string;
  createdAt: number;
}

export class WebPushSink implements NotificationSink {
  private subs: StoredSubscription[] = [];
  private loaded = false;

  constructor(
    private readonly vapid: VapidConfig,
    private readonly storePath: string,
  ) {
    webpush.setVapidDetails(
      vapid.subject,
      vapid.publicKey,
      vapid.privateKey,
    );
  }

  async load(): Promise<void> {
    try {
      const text = await readFile(this.storePath, "utf8");
      const parsed = JSON.parse(text) as StoredSubscription[];
      if (Array.isArray(parsed)) this.subs = parsed;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      this.subs = [];
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.storePath), { recursive: true });
    await writeFile(this.storePath, JSON.stringify(this.subs, null, 2), "utf8");
  }

  publicKey(): string {
    return this.vapid.publicKey;
  }

  async subscribe(req: PushSubscribeRequest): Promise<{ id: string }> {
    if (!this.loaded) await this.load();
    // De-dupe by endpoint — same device re-subscribing should not pile up.
    this.subs = this.subs.filter(
      (s) => s.subscription.endpoint !== req.subscription.endpoint,
    );
    const id = String(Date.now());
    this.subs.push({ ...req, id, createdAt: Date.now() });
    await this.save();
    return { id };
  }

  async unsubscribe(endpoint: string): Promise<void> {
    if (!this.loaded) await this.load();
    const before = this.subs.length;
    this.subs = this.subs.filter(
      (s) => s.subscription.endpoint !== endpoint,
    );
    if (this.subs.length !== before) await this.save();
  }

  async push(msg: SrvNotification): Promise<void> {
    if (!this.loaded) await this.load();
    if (this.subs.length === 0) return;

    const payload = JSON.stringify({
      title: msg.title || "skybase",
      body: msg.body,
      sessionId: msg.sessionId,
      hostId: msg.hostId,
      timestamp: msg.timestamp,
    });

    const dead: string[] = [];
    await Promise.all(
      this.subs.map(async (s) => {
        try {
          await webpush.sendNotification(s.subscription, payload, {
            TTL: 60 * 60, // 1 hour
          });
        } catch (err: unknown) {
          const status = (err as { statusCode?: number }).statusCode;
          // 404 = subscription gone, 410 = expired/unsubscribed by user.
          if (status === 404 || status === 410) {
            dead.push(s.subscription.endpoint);
          } else {
            console.error("[push] send failed:", err);
          }
        }
      }),
    );

    if (dead.length > 0) {
      this.subs = this.subs.filter(
        (s) => !dead.includes(s.subscription.endpoint),
      );
      await this.save();
    }
  }
}

/**
 * Parse VAPID config from a JSON blob (`{publicKey, privateKey, subject}`).
 * Throws if the JSON is malformed or missing required fields.
 */
export function parseVapidJson(text: string): VapidConfig {
  const obj = JSON.parse(text) as Partial<VapidConfig>;
  if (!obj.publicKey || !obj.privateKey || !obj.subject) {
    throw new Error(
      "VAPID JSON must include publicKey, privateKey, and subject",
    );
  }
  return {
    publicKey: obj.publicKey,
    privateKey: obj.privateKey,
    subject: obj.subject,
  };
}
