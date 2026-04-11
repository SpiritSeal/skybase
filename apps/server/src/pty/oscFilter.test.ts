import { describe, expect, it } from "vitest";
import { OscFilter, type OscEvent } from "./oscFilter.js";

const ESC = "\x1b";
const BEL = "\x07";
const ST = ESC + "\\";

function feedAll(input: string): { cleaned: string; events: OscEvent[] } {
  const f = new OscFilter();
  return f.feed(input);
}

/** Feed input one byte at a time and concatenate the per-call results. */
function feedSplit(input: string): { cleaned: string; events: OscEvent[] } {
  const f = new OscFilter();
  let cleaned = "";
  const events: OscEvent[] = [];
  for (const c of input) {
    const r = f.feed(c);
    cleaned += r.cleaned;
    events.push(...r.events);
  }
  return { cleaned, events };
}

describe("OscFilter — passthrough", () => {
  it("forwards plain text untouched", () => {
    const r = feedAll("hello world\n");
    expect(r.cleaned).toBe("hello world\n");
    expect(r.events).toEqual([]);
  });

  it("forwards CSI sequences untouched", () => {
    const r = feedAll(`${ESC}[31mred${ESC}[0m`);
    expect(r.cleaned).toBe(`${ESC}[31mred${ESC}[0m`);
    expect(r.events).toEqual([]);
  });

  it("forwards unrelated OSC (window title OSC 0) untouched", () => {
    const input = `before${ESC}]0;my title${BEL}after`;
    const r = feedAll(input);
    expect(r.cleaned).toBe(input);
    expect(r.events).toEqual([]);
  });

  it("forwards OSC 2 (window title) with ST terminator untouched", () => {
    const input = `${ESC}]2;hello${ST}`;
    const r = feedAll(input);
    expect(r.cleaned).toBe(input);
    expect(r.events).toEqual([]);
  });
});

describe("OscFilter — OSC 9 (iTerm)", () => {
  it("strips OSC 9 with BEL and emits body-only event", () => {
    const r = feedAll(`pre${ESC}]9;Hello world${BEL}post`);
    expect(r.cleaned).toBe("prepost");
    expect(r.events).toEqual([
      { source: "osc9", title: "", body: "Hello world" },
    ]);
  });

  it("strips OSC 9 with ST terminator", () => {
    const r = feedAll(`${ESC}]9;done${ST}`);
    expect(r.cleaned).toBe("");
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ source: "osc9", body: "done" });
  });
});

describe("OscFilter — OSC 777 (rxvt notify)", () => {
  it("strips notify with title and body", () => {
    const r = feedAll(`${ESC}]777;notify;Claude;needs input${BEL}`);
    expect(r.cleaned).toBe("");
    expect(r.events).toEqual([
      { source: "osc777", title: "Claude", body: "needs input" },
    ]);
  });

  it("body may contain semicolons (split on first only)", () => {
    const r = feedAll(`${ESC}]777;notify;Title;a;b;c${BEL}`);
    expect(r.events[0]).toMatchObject({
      source: "osc777",
      title: "Title",
      body: "a;b;c",
    });
  });

  it("ignores OSC 777 that is not a notify", () => {
    const input = `${ESC}]777;preexec${BEL}`;
    const r = feedAll(input);
    expect(r.cleaned).toBe(input);
    expect(r.events).toEqual([]);
  });
});

describe("OscFilter — OSC 99 (kitty)", () => {
  it("strips OSC 99 default-body single-chunk", () => {
    const r = feedAll(`${ESC}]99;;hello${ST}`);
    expect(r.cleaned).toBe("");
    expect(r.events[0]).toMatchObject({
      source: "osc99",
      title: "",
      body: "hello",
    });
  });

  it("captures dedupe id from i=", () => {
    const r = feedAll(`${ESC}]99;i=42;payload${ST}`);
    expect(r.events[0]).toMatchObject({
      source: "osc99",
      body: "payload",
      dedupeId: "42",
    });
  });

  it("uses payload as title when p=title", () => {
    const r = feedAll(`${ESC}]99;i=7:p=title;Big news${ST}`);
    expect(r.events[0]).toMatchObject({
      source: "osc99",
      title: "Big news",
      body: "",
      dedupeId: "7",
    });
  });
});

describe("OscFilter — chunk boundaries", () => {
  it("byte-by-byte feeding produces same result as one-shot", () => {
    const input =
      `start${ESC}[33myellow${ESC}[0m` +
      `${ESC}]777;notify;Hi;there${BEL}` +
      `middle` +
      `${ESC}]9;simple${ST}` +
      `end`;
    const oneShot = feedAll(input);
    const split = feedSplit(input);
    expect(split.cleaned).toBe(oneShot.cleaned);
    expect(split.events).toEqual(oneShot.events);
    expect(oneShot.cleaned).toBe(
      `start${ESC}[33myellow${ESC}[0mmiddleend`,
    );
    expect(oneShot.events).toHaveLength(2);
  });

  it("OSC split across many chunks", () => {
    const f = new OscFilter();
    const parts = [`${ESC}`, `]`, `9;`, `Hel`, `lo`, BEL];
    let cleaned = "";
    const events: OscEvent[] = [];
    for (const p of parts) {
      const r = f.feed(p);
      cleaned += r.cleaned;
      events.push(...r.events);
    }
    expect(cleaned).toBe("");
    expect(events).toEqual([{ source: "osc9", title: "", body: "Hello" }]);
  });

  it("ESC alone at end of chunk is held until next chunk", () => {
    const f = new OscFilter();
    const r1 = f.feed(`hi${ESC}`);
    expect(r1.cleaned).toBe("hi");
    const r2 = f.feed(`[31mred`);
    expect(r2.cleaned).toBe(`${ESC}[31mred`);
  });

  it("ESC followed by non-OSC in next chunk emits ESC verbatim", () => {
    const f = new OscFilter();
    f.feed(ESC);
    const r = f.feed("M"); // ESC M = reverse index
    expect(r.cleaned).toBe(`${ESC}M`);
  });
});

describe("OscFilter — abort and edge cases", () => {
  it("CAN inside OSC aborts the sequence", () => {
    const r = feedAll(`pre${ESC}]9;hello${"\x18"}post`);
    expect(r.cleaned).toBe("prepost");
    expect(r.events).toEqual([]);
  });

  it("multiple OSC notifications in one chunk", () => {
    const r = feedAll(
      `${ESC}]9;a${BEL}${ESC}]9;b${BEL}${ESC}]777;notify;t;c${BEL}`,
    );
    expect(r.cleaned).toBe("");
    expect(r.events.map((e) => e.body)).toEqual(["a", "b", "c"]);
  });

  it("interleaved data and notifications", () => {
    const r = feedAll(`hello ${ESC}]9;ping${BEL}world`);
    expect(r.cleaned).toBe("hello world");
    expect(r.events).toHaveLength(1);
  });

  it("unknown OSC with ST terminator passes through", () => {
    const input = `${ESC}]52;c;BASE64DATA${ST}`;
    const r = feedAll(input);
    expect(r.cleaned).toBe(input);
    expect(r.events).toEqual([]);
  });
});
