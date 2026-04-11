// Live integration probe for the SSH path. Attaches to ratbat, runs `tmux
// list-sessions`, then types `exit` to detach the ssh shell cleanly. Tests
// that the running server's SKYBASE_SSH_KEY actually authenticates.

const URL = process.env.SKYBASE_URL ?? "ws://localhost:8080/ws";
const ws = new WebSocket(URL);

const log = (...a) => console.log(`[${(performance.now() / 1000).toFixed(2)}s]`, ...a);
const seen = { attached: false, prompt: false, notify: 0, closed: false };
let dataBuf = "";

ws.addEventListener("open", () => {
  log("ws open");
  ws.send(
    JSON.stringify({
      t: "attach",
      sessionId: "ratbat-probe",
      hostId: "ratbat",
      tmuxName: "skybase-probe",
      cols: 100,
      rows: 30,
    }),
  );
});

ws.addEventListener("message", (ev) => {
  const data = typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8");
  const m = JSON.parse(data);
  switch (m.t) {
    case "attached":
      seen.attached = true;
      log("attached");
      // Wait a beat then call the actual skybase-notify.sh script we
      // pre-installed at /tmp/skybase-notify.sh on ratbat. The script
      // detects $TMUX, wraps the OSC in DCS Ptmux passthrough, and writes
      // to /dev/tty. This is the real-world path: same script, same
      // wrapping, same write target as a Claude Code Stop hook would use.
      setTimeout(() => {
        const cmd =
          `/tmp/skybase-notify.sh --title ratbat --body hello-from-skybase && ` +
          `echo RATBAT_OK && ` +
          `tmux kill-session\n`;
        ws.send(
          JSON.stringify({
            t: "input",
            sessionId: "ratbat-probe",
            b64: Buffer.from(cmd).toString("base64"),
          }),
        );
      }, 800);
      break;
    case "data": {
      const decoded = Buffer.from(m.b64, "base64").toString("binary");
      dataBuf += decoded;
      if (dataBuf.includes("RATBAT_OK")) seen.prompt = true;
      break;
    }
    case "notify":
      log(`NOTIFY title="${m.title}" body="${m.body}"`);
      seen.notify++;
      break;
    case "closed":
      seen.closed = true;
      log(`closed: ${m.reason}`);
      ws.close();
      break;
    case "error":
      log(`ERROR: ${m.message}`);
      break;
  }
});

ws.addEventListener("close", () => {
  log("ws close");
  console.log("\nResults:");
  console.log(`  attached:        ${seen.attached}`);
  console.log(`  saw RATBAT_OK:   ${seen.prompt}`);
  console.log(`  notify count:    ${seen.notify}`);
  console.log(`  closed cleanly:  ${seen.closed}`);
  console.log(`  data length:     ${dataBuf.length} bytes`);
  if (dataBuf.length > 0 && !seen.prompt) {
    // Print last 400 chars so we can see what bash/ssh actually said
    console.log("\nLast bytes of stream:");
    console.log("  " + JSON.stringify(dataBuf.slice(-400)));
  }
  process.exit(seen.attached && seen.prompt && seen.notify >= 1 ? 0 : 1);
});

setTimeout(() => {
  log("safety timeout");
  ws.close();
  setTimeout(() => process.exit(2), 100);
}, 12000);
