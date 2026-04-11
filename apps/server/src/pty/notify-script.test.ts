// End-to-end: invoke the actual scripts/skybase-notify.sh inside a local PTY
// and verify the OSC sequence is parsed into a notification event.

import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import type { ServerMessage } from "@skybase/shared";
import { PtySession } from "./session.js";
import type { OscEvent } from "./oscFilter.js";

const SCRIPT = resolve(
  __dirname,
  "../../../../scripts/skybase-notify.sh",
);

describe("skybase-notify.sh integration", () => {
  it("emits OSC 777 notification that round-trips through OscFilter", async () => {
    const messages: ServerMessage[] = [];
    const events: OscEvent[] = [];
    let exitReason: string | null = null;

    const session = new PtySession({
      sessionId: "notify-test",
      hostId: "__local__",
      spawn: { kind: "local", cols: 80, rows: 24, shell: "/bin/sh" },
      callbacks: {
        send: (m) => messages.push(m),
        onNotification: (e) => events.push(e),
        onExit: (r) => {
          exitReason = r;
        },
      },
    });

    session.start();
    await waitFor(() => messages.some((m) => m.t === "attached"), 2000);

    // Invoke the actual script from inside the PTY. We unset TMUX so the
    // script doesn't try to wrap in passthrough — we want bare OSC for this
    // test. Then exit cleanly so onExit fires.
    const cmd = `unset TMUX; ${SCRIPT} --title "Claude" --body "needs input" && echo done\nexit\n`;
    session.write(Buffer.from(cmd).toString("base64"));

    await waitFor(() => exitReason !== null, 4000);

    // Should have received exactly one notification with the right title/body.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "osc777",
      title: "Claude",
      body: "needs input",
    });

    // The forwarded data stream contains "done" but no actual ESC]777 bytes.
    const allData = messages
      .filter(
        (m): m is Extract<ServerMessage, { t: "data" }> => m.t === "data",
      )
      .map((m) => Buffer.from(m.b64, "base64").toString("binary"))
      .join("");
    expect(allData).toContain("done");
    expect(allData).not.toContain("\x1b]777;notify");
  });

  it("dedupe-id flag emits a second OSC 99 with id", async () => {
    const messages: ServerMessage[] = [];
    const events: OscEvent[] = [];
    let exitReason: string | null = null;

    const session = new PtySession({
      sessionId: "notify-dedup",
      hostId: "__local__",
      spawn: { kind: "local", cols: 80, rows: 24, shell: "/bin/sh" },
      callbacks: {
        send: (m) => messages.push(m),
        onNotification: (e) => events.push(e),
        onExit: (r) => {
          exitReason = r;
        },
      },
    });

    session.start();
    await waitFor(() => messages.some((m) => m.t === "attached"), 2000);

    const cmd = `unset TMUX; ${SCRIPT} --title T --body B --dedupe-id job-7\nexit\n`;
    session.write(Buffer.from(cmd).toString("base64"));
    await waitFor(() => exitReason !== null, 4000);

    // We expect two events: OSC 777 (no id) and OSC 99 (with id=job-7).
    expect(events.length).toBeGreaterThanOrEqual(2);
    const osc99 = events.find((e) => e.source === "osc99");
    expect(osc99).toBeDefined();
    expect(osc99?.dedupeId).toBe("job-7");
  });
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
