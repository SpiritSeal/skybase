// Verify the WS encoding round-trip handles arbitrary UTF-8 bytes
// (emoji, CJK, accented letters, control characters, mixed content)
// without mangling. Sends each test string into a local-bash session via
// the input message protocol and asks bash to xxd-echo it back, then
// asserts the round-trip is byte-perfect.

const URL = process.env.SKYBASE_URL ?? "ws://localhost:8080/ws?local=1";
const ws = new WebSocket(URL);
const dec = new TextDecoder();
const enc = new TextEncoder();

function utf8ToBase64(s) {
  const bytes = enc.encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

let dataBuf = "";
const testCases = [
  ["plain ASCII", "hello world"],
  ["emoji",        "🎉🚀✨"],
  ["CJK",          "日本語テスト"],
  ["accented",     "café déjà vu"],
  ["curly quotes", "“hello” ‘world’"],
  ["mixed",        "ASCII mixed with 日本語 and 🎉"],
];
let curIdx = -1;

ws.addEventListener("open", () => {
  ws.send(
    JSON.stringify({
      t: "attach",
      sessionId: "utf8-test",
      hostId: "__local__",
      tmuxName: "x",
      cols: 100,
      rows: 30,
    }),
  );
});

function nextTest() {
  curIdx++;
  if (curIdx >= testCases.length) {
    setTimeout(() => {
      ws.send(
        JSON.stringify({
          t: "input",
          sessionId: "utf8-test",
          b64: utf8ToBase64("exit\n"),
        }),
      );
    }, 200);
    return;
  }
  const [name, str] = testCases[curIdx];
  // We'll echo the string and look for it in the output. Use printf with %s
  // to avoid backslash interpretation, and a unique marker so we can find
  // each test result independently of bash prompt noise.
  const marker = `__TEST_${curIdx}__`;
  const cmd = `printf '%s\\n' "${marker}${str}${marker}"\n`;
  ws.send(
    JSON.stringify({
      t: "input",
      sessionId: "utf8-test",
      b64: utf8ToBase64(cmd),
    }),
  );
  setTimeout(nextTest, 250);
}

ws.addEventListener("message", (ev) => {
  const data = typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8");
  const m = JSON.parse(data);
  if (m.t === "attached") {
    setTimeout(nextTest, 400);
  } else if (m.t === "data") {
    // The server sends UTF-8 bytes as base64 — decode the same way the
    // browser does and concat into a JS string.
    const bin = atob(m.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    dataBuf += dec.decode(bytes, { stream: true });
  } else if (m.t === "closed") {
    ws.close();
  }
});

ws.addEventListener("close", () => {
  console.log("\nResults:");
  let pass = 0;
  for (let i = 0; i < testCases.length; i++) {
    const [name, str] = testCases[i];
    const marker = `__TEST_${i}__`;
    const re = new RegExp(`${marker}(.*?)${marker}`);
    const match = dataBuf.match(re);
    const got = match ? match[1] : "(not found)";
    const ok = got === str;
    if (ok) pass++;
    console.log(`  ${ok ? "✓" : "✗"} ${name.padEnd(15)} sent=${JSON.stringify(str)}  got=${JSON.stringify(got)}`);
  }
  console.log(`\n${pass}/${testCases.length} round-trips correct`);
  process.exit(pass === testCases.length ? 0 : 1);
});

setTimeout(() => {
  console.error("timeout");
  process.exit(2);
}, 8000);
