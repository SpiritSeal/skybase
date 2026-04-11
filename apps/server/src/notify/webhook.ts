// Outbound webhook sink. Fire-and-forget POST with a 2-second timeout.

import type { WebhookPayload } from "@skybase/shared";
import type { WebhookSink } from "./dispatcher.js";

export class HttpWebhookSink implements WebhookSink {
  constructor(
    private readonly url: string,
    private readonly bearerToken?: string,
    private readonly timeoutMs = 2000,
  ) {}

  async send(payload: WebhookPayload): Promise<void> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "user-agent": "skybase/0.1",
      };
      if (this.bearerToken) {
        headers.authorization = `Bearer ${this.bearerToken}`;
      }
      const res = await fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        console.error(
          `[webhook] ${this.url} returned HTTP ${res.status}`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
