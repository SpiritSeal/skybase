// Live integration probe — connects to a running skybase server, opens a
// local-bash session, exercises notification + resize + detach paths.
// This file is git-ignored under apps/server (not in src) and only run by
// hand against a live `pnpm dev` server.

// Node 22+ has a global WebSocket — no `ws` import needed.
const URL = process.env.SKYBASE_URL ?? "ws://localhost:8080/ws?local=1";
const ws = new WebSocket(URL);

const log = (...a) => console.log(`[${(performance.now() / 1000).toFixed(2)}s]`, ...a);

const seen = {
  sessions: false,
  attached: false,
  echo: false,
  notify: null,
  closed: false,
};
let dataBuf = "";

ws.addEventListener("open", () => {
  log("ws open");
  ws.send(
    JSON.stringify({
      t: "attach",
      sessionId: "live-test",
      hostId: "__local__",
      tmuxName: "ignored",
      cols: 100,
      rows: 30,
    }),
  );
});

ws.addEventListener("message", (ev) => {
  const m = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8"));
  switch (m.t) {
    case "sessions":
      seen.sessions = true;
      log("got sessions inventory:", m.hosts.map((h) => h.id).join(", ") || "(none)");
      break;
    case "attached":
      seen.attached = true;
      log(`attached cols=${m.cols} rows=${m.rows}`);
      // Step 1: send focus signal
      ws.send(JSON.stringify({ t: "focus", sessionId: "live-test" }));
      // Step 2: type a marker echo + an OSC 777 + an OSC 9 + exit
      const cmd =
        `echo BEGIN_TEST_MARKER_42 && ` +
        `printf '\\033]777;notify;Title-A;Body-A\\a' && ` +
        `sleep 0.1 && ` +
        `printf '\\033]9;Body-only-9\\a' && ` +
        `echo END_TEST_MARKER_42 && ` +
        `exit\n`;
      ws.send(
        JSON.stringify({
          t: "input",
          sessionId: "live-test",
          b64: Buffer.from(cmd).toString("base64"),
        }),
      );
      // Step 3: also send a resize partway through to exercise that path
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            t: "resize",
            sessionId: "live-test",
            cols: 120,
            rows: 40,
          }),
        );
      }, 50);
      break;
    case "data": {
      const decoded = Buffer.from(m.b64, "base64").toString("binary");
      dataBuf += decoded;
      if (dataBuf.includes("BEGIN_TEST_MARKER_42") && dataBuf.includes("END_TEST_MARKER_42")) {
        seen.echo = true;
      }
      break;
    }
    case "notify":
      log(`NOTIFY title="${m.title}" body="${m.body}" dedup=${m.dedupeId ?? "-"}`);
      seen.notify = (seen.notify ?? 0) + 1;
      break;
    case "closed":
      seen.closed = true;
      log(`closed: ${m.reason}`);
      break;
    case "error":
      log("ERROR:", m.message);
      break;
  }
});

ws.addEventListener("close", () => {
  log("ws close");
  // Assertions
  const assertions = [
    ["initial sessions inventory", seen.sessions],
    ["attached message", seen.attached],
    ["data echo round-trip", seen.echo],
    ["at least one notify event", (seen.notify ?? 0) >= 1],
    ["closed message", seen.closed],
    [
      "OSC bytes stripped from data",
      !dataBuf.includes("\x1b]777;notify") && !dataBuf.includes("\x1b]9;Body"),
    ],
  ];
  let pass = 0;
  for (const [name, ok] of assertions) {
    console.log(`  ${ok ? "✓" : "✗"} ${name}`);
    if (ok) pass++;
  }
  console.log(`\n${pass}/${assertions.length} assertions passed`);
  console.log(`notify count: ${seen.notify ?? 0}`);
  console.log(`data length: ${dataBuf.length} bytes`);
  process.exit(pass === assertions.length ? 0 : 1);
});

setTimeout(() => {
  console.error("\n[live-test] timeout — server didn't close session");
  ws.close();
  setTimeout(() => process.exit(2), 100);
}, 6000);
