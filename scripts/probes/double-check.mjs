// Sends ONE input message and checks how many bytes the remote PTY echoes
// back. If the remote sees the byte twice (once printed, once interrupted),
// the doubling is in the server / SSH / tmux path. If it sees the byte
// exactly once, the doubling is in the browser xterm.js path.

const URL = process.env.SKYBASE_URL ?? "ws://localhost:8080/ws?local=1";
const ws = new WebSocket(URL);
let dataBuf = "";
let inputCount = 0;

ws.addEventListener("open", () => {
  ws.send(
    JSON.stringify({
      t: "attach",
      sessionId: "double-check",
      hostId: "__local__",
      tmuxName: "x",
      cols: 80,
      rows: 24,
    }),
  );
});

ws.addEventListener("message", (ev) => {
  const data = typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8");
  const m = JSON.parse(data);
  if (m.t === "attached") {
    setTimeout(() => {
      // Disable signal generation so Ctrl+C is just a byte, then echo each
      // input byte as hex via od. Then send a single Ctrl+C byte and look
      // at what comes back.
      const setup = `stty -isig 2>/dev/null; cat | od -An -c -w16 &\nsleep 0.3\n`;
      ws.send(
        JSON.stringify({
          t: "input",
          sessionId: "double-check",
          b64: Buffer.from(setup).toString("base64"),
        }),
      );
      // Now send exactly one \x03 byte. ONE input message.
      setTimeout(() => {
        inputCount++;
        ws.send(
          JSON.stringify({
            t: "input",
            sessionId: "double-check",
            b64: Buffer.from("\x03\n").toString("base64"),
          }),
        );
      }, 600);
      // Wait for echo, then exit.
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            t: "input",
            sessionId: "double-check",
            b64: Buffer.from("\x04exit\n").toString("base64"),
          }),
        );
      }, 1500);
    }, 500);
  } else if (m.t === "data") {
    dataBuf += Buffer.from(m.b64, "base64").toString("binary");
  } else if (m.t === "closed") {
    ws.close();
  }
});

ws.addEventListener("close", () => {
  // Strip the prompt noise; print the bytes that od emitted.
  const lines = dataBuf
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\r/g, "")
    .split("\n")
    .filter((l) => l.includes("003") || l.includes("od ") || l.includes("ctrl-c"));
  console.log(`Sent ${inputCount} \\x03 input message(s).`);
  console.log("od output lines containing 003:");
  for (const l of lines) console.log("  " + l);
  console.log("---");
  console.log("Tail of clean dataBuf:");
  console.log(
    dataBuf
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
      .split("\n")
      .slice(-20)
      .join("\n"),
  );
});

setTimeout(() => process.exit(2), 8000);
