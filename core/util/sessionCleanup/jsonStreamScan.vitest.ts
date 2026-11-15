import { describe, expect, it } from "vitest";

import {
  JsonScanError,
  JsonStreamScanner,
  type JsonPathPart,
  type ScalarKind,
} from "./jsonStreamScan";

interface Seen {
  path: string;
  kind: ScalarKind | "object" | "array";
  text?: string;
  start: number;
  end: number;
}

function scan(input: string, chunk = 1 << 20): Seen[] {
  const seen: Seen[] = [];
  const key = (p: readonly JsonPathPart[]) => p.join("/");
  const s = new JsonStreamScanner({
    scalar: (p, kind, start, end, text) =>
      seen.push({ path: key(p), kind, text, start, end }),
    close: (p, kind, start, end) =>
      seen.push({ path: key(p), kind, start, end }),
  });
  const bytes = Buffer.from(input, "utf8");
  for (let i = 0; i < bytes.length; i += chunk) {
    s.write(bytes.subarray(i, i + chunk));
  }
  s.end();
  return seen;
}

const SAMPLE = JSON.stringify(
  {
    sessionId: "s-1",
    title: 'quotes " and \\ backslashes \\" and é 😀',
    history: [
      { message: { id: "m1", role: "user", content: "hi\nthere" } },
      {
        message: { id: "m2", role: "assistant", content: [] },
        promptLogs: [{ prompt: 'p\\"1', completion: "c" }],
        n: [-1.5e3, 0, 12, true, false, null],
      },
    ],
    empty: {},
  },
  undefined,
  2,
);

describe("JsonStreamScanner", () => {
  it("reports every value with its path and byte span, at any chunk size", () => {
    const whole = scan(SAMPLE);
    const bytes = Buffer.from(SAMPLE, "utf8");
    for (const chunk of [1, 2, 3, 7, 64]) {
      expect(scan(SAMPLE, chunk)).toEqual(whole);
    }
    const prompt = whole.find(
      (s) => s.path === "history/1/promptLogs/0/prompt",
    )!;
    expect(prompt.text).toBe('p\\"1');
    // The span is the JSON text of the value, quotes included
    expect(
      JSON.parse(bytes.subarray(prompt.start, prompt.end).toString()),
    ).toBe('p\\"1');
    expect(whole.find((s) => s.path === "title")!.text).toBe(
      JSON.parse(SAMPLE).title,
    );
    expect(whole.find((s) => s.path === "history/1/n/0")).toMatchObject({
      kind: "number",
      text: "-1500",
    });
    expect(scan("[-1.5e3, 2E+2, 0.25]").map((s) => s.text)).toEqual([
      "-1.5e3",
      "2E+2",
      "0.25",
      undefined,
    ]);
    const history = whole.find(
      (s) => s.path === "history" && s.kind === "array",
    )!;
    expect(bytes.subarray(history.start, history.end).toString().at(-1)).toBe(
      "]",
    );
    expect(whole.at(-1)).toMatchObject({
      path: "",
      kind: "object",
      end: bytes.length,
    });
  });

  it("does not decode long strings, only measures them", () => {
    const long = "x".repeat(10_000);
    const seen = scan(JSON.stringify({ a: long, b: "short" }), 333);
    expect(seen.find((s) => s.path === "a")).toMatchObject({
      text: undefined,
      end: expect.any(Number),
    });
    const a = seen.find((s) => s.path === "a")!;
    expect(a.end - a.start).toBe(10_002);
    expect(seen.find((s) => s.path === "b")!.text).toBe("short");
  });

  it.each([
    ["{", "Unexpected end"],
    ['{"a":1,}', "Expected a key"],
    ["[1,]", "Expected a value"],
    ['{"a" 1}', "Expected ':'"],
    ["[1 2]", "Expected ','"],
    ["{} {}", "after the end"],
    ["[tru]", "Bad number or literal"],
    ["[01]", "Bad number or literal"],
    ['["abc', "Unexpected end"],
    ['"\\x"', "Bad string escape"],
  ])("rejects %s", (input, message) => {
    expect(() => scan(input)).toThrow(JsonScanError);
    expect(() => scan(input)).toThrow(message);
  });

  it("scans a prompt larger than V8's longest string without ever building it", () => {
    // 2^29 - 24 characters is the most a string can hold on 64-bit V8. The
    // prompt here is 600 MiB, fed in 1 MiB chunks of one reused buffer: no
    // string or buffer of that size exists at any point.
    const MiB = 1 << 20;
    const chunks = 600;
    const filler = Buffer.alloc(MiB, "a");
    const head = Buffer.from(
      '{"sessionId":"big","history":[{"message":{"id":"m1"},"promptLogs":[{"prompt":"',
    );
    const tail = Buffer.from('","completion":"ok"}]}]}');
    let prompt: { start: number; end: number; text?: string } | undefined;
    const s = new JsonStreamScanner({
      scalar(path, _kind, start, end, text) {
        if (path.join("/") === "history/0/promptLogs/0/prompt") {
          prompt = { start, end, text };
        }
      },
    });
    s.write(head);
    for (let i = 0; i < chunks; i++) s.write(filler);
    s.write(tail);
    s.end();
    expect(chunks * MiB).toBeGreaterThan(2 ** 29 - 24);
    expect(prompt!.text).toBeUndefined();
    expect(prompt!.end - prompt!.start).toBe(chunks * MiB + 2);
    expect(s.position).toBe(head.length + chunks * MiB + tail.length);
  });
});
