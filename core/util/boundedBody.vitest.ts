import { describe, expect, it } from "vitest";
import {
  FetchDeadlineError,
  readBodyCapped,
  withDeadline,
} from "./boundedBody";

const stream = (chunks: Uint8Array[], hang = false) =>
  new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.shift();
      if (next) controller.enqueue(next);
      else if (hang) return new Promise(() => undefined);
      else controller.close();
    },
  });

// A response whose body is a stream, whatever Response this environment has
const fake = (body: unknown) => ({ body, text: async () => "" });

const bytes = (n: number, v = 97) => new Uint8Array(n).fill(v);

describe("readBodyCapped", () => {
  it("returns a body under the cap whole", async () => {
    const r = await readBodyCapped(new Response("hello"), { maxBytes: 100 });
    expect(r).toEqual({ text: "hello", truncated: false, bytes: 5 });
  });

  it("a body of exactly the cap is not truncated", async () => {
    const r = await readBodyCapped(new Response(bytes(10)), { maxBytes: 10 });
    expect(r.truncated).toBe(false);
    expect(r.bytes).toBe(10);
  });

  it("stops at the cap and says so (T16)", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(bytes(1024));
      },
    });
    const r = await readBodyCapped(fake(body), { maxBytes: 4096 });
    expect(r.truncated).toBe(true);
    expect(r.bytes).toBe(4096);
    // it did not drain an endless stream
    expect(pulled).toBeLessThan(20);
  });

  it("does not end the text in half a character", async () => {
    // "é" is two bytes; a cap of 4 cuts the second one in half
    const r = await readBodyCapped(new Response("aéé"), { maxBytes: 4 });
    expect(r.text).toBe("aé");
    expect(r.truncated).toBe(true);
  });

  it("reads a node stream", async () => {
    const { Readable } = await import("node:stream");
    const resp = {
      body: Readable.from([Buffer.from("abc"), Buffer.from("defgh")]),
      text: async () => "",
    };
    const r = await readBodyCapped(resp, { maxBytes: 6 });
    expect(r).toEqual({ text: "abcdef", truncated: true, bytes: 6 });
  });

  it("falls back to text() for a response with no stream", async () => {
    const r = await readBodyCapped(
      { text: async () => "x".repeat(50) },
      { maxBytes: 10 },
    );
    expect(r.text).toBe("x".repeat(10));
    expect(r.truncated).toBe(true);
  });

  it("uses the charset the response names", async () => {
    const resp = new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), {
      headers: { "content-type": "text/plain; charset=iso-8859-1" },
    });
    expect((await readBodyCapped(resp)).text).toBe("café");
  });

  it("aborts a body that stops sending at the deadline (T17)", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const resp = fake(stream([bytes(3)], true));
    await expect(
      readBodyCapped(resp, { signal: controller.signal, deadlineMs: 30 }),
    ).rejects.toBeInstanceOf(FetchDeadlineError);
  });
});

describe("withDeadline", () => {
  it("returns the result of work that finishes in time", async () => {
    await expect(withDeadline(1000, async () => 7)).resolves.toBe(7);
  });

  it("abandons work that ignores the signal", async () => {
    await expect(
      withDeadline(20, () => new Promise(() => undefined)),
    ).rejects.toThrow(/did not finish within/);
  });

  it("passes the signal to work and aborts it", async () => {
    let seen: AbortSignal | undefined;
    await expect(
      withDeadline(20, (signal) => {
        seen = signal;
        return new Promise(() => undefined);
      }),
    ).rejects.toBeInstanceOf(FetchDeadlineError);
    expect(seen?.aborted).toBe(true);
  });

  it("passes through an error from work", async () => {
    await expect(
      withDeadline(1000, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});
