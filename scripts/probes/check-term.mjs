// Probe what environment the remote tmux pane gets when attached via skybase.
// Useful for debugging "special characters render weirdly" type problems.

const URL = process.env.SKYBASE_URL ?? "ws://localhost:8080/ws";
const ws = new WebSocket(URL);
let dataBuf = "";

ws.addEventListener("open", () => {
  ws.send(
    JSON.stringify({
      t: "attach",
      sessionId: "term-probe",
      hostId: "ratbat",
      tmuxName: "term-probe",
      cols: 120,
      rows: 40,
    }),
  );
});

ws.addEventListener("message", (ev) => {
  const data = typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8");
  const m = JSON.parse(data);
  if (m.t === "attached") {
    setTimeout(() => {
      const cmd =
        `echo "TERM=$TERM"; echo "LANG=$LANG"; echo "LC_CTYPE=$LC_CTYPE"; ` +
        `echo "stty: $(stty size)"; ` +
        `echo "tput colors: $(tput colors 2>/dev/null)"; ` +
        `echo "tput cols: $(tput cols)"; ` +
        `infocmp $TERM 2>&1 | head -2; ` +
        `echo END_PROBE; ` +
        `tmux kill-session\n`;
      ws.send(
        JSON.stringify({
          t: "input",
          sessionId: "term-probe",
          b64: Buffer.from(cmd).toString("base64"),
        }),
      );
    }, 800);
  } else if (m.t === "data") {
    dataBuf += Buffer.from(m.b64, "base64").toString("binary");
  } else if (m.t === "closed") {
    ws.close();
  }
});

ws.addEventListener("close", () => {
  // Strip ANSI escapes for readability.
  const clean = dataBuf
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\][0-9]*;[^\x07\x1b]*[\x07\x1b]\\?/g, "")
    .replace(/\x1b[()][AB012]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
  console.log(clean);
  process.exit(0);
});

setTimeout(() => process.exit(2), 10000);
