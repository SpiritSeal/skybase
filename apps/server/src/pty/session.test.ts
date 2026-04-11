// End-to-end smoke test: spawn a local PTY, write a command, assert output.
// Verifies node-pty + session wiring + OSC filter passthrough.

import { describe, it, expect } from "vitest";
import type { ServerMessage } from "@skybase/shared";
import { PtySession } from "./session.js";
import type { OscEvent } from "./oscFilter.js";

describe("PtySession (local mode)", () => {
  it("spawns bash and echoes a command", async () => {
    const messages: ServerMessage[] = [];
    const events: OscEvent[] = [];
    let exitReason: string | null = null;

    const session = new PtySession({
      sessionId: "test",
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

    // Wait for "attached" message.
    await waitFor(() => messages.some((m) => m.t === "attached"), 2000);

    // Type `echo hi` then exit cleanly.
    session.write(Buffer.from("echo hi\nexit\n").toString("base64"));

    // Wait for clean shutdown.
    await waitFor(() => exitReason !== null, 4000);

    const allData = messages
      .filter((m): m is Extract<ServerMessage, { t: "data" }> => m.t === "data")
      .map((m) => Buffer.from(m.b64, "base64").toString("binary"))
      .join("");
    expect(allData).toContain("hi");
    expect(events).toEqual([]);
  });

  it("extracts OSC 777 from PTY output via printf", async () => {
    const messages: ServerMessage[] = [];
    const events: OscEvent[] = [];
    let exitReason: string | null = null;

    const session = new PtySession({
      sessionId: "test2",
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

    // Use printf to emit a literal OSC 777 notify into the PTY stream.
    // The shell's printf is reliably present and supports \033 / \a.
    session.write(
      Buffer.from(
        `printf '\\033]777;notify;Hello;World\\a' && echo done\nexit\n`,
      ).toString("base64"),
    );

    await waitFor(() => exitReason !== null, 4000);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "osc777",
      title: "Hello",
      body: "World",
    });

    // The actual ESC byte sequence (post-printf execution) must be stripped.
    // The literal source text (`printf '\\033]...'`) WILL appear because the
    // PTY echoes typed commands.
    const allData = messages
      .filter((m): m is Extract<ServerMessage, { t: "data" }> => m.t === "data")
      .map((m) => Buffer.from(m.b64, "base64").toString("binary"))
      .join("");
    expect(allData).not.toContain("\x1b]777;notify");
    expect(allData).toContain("done");
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
