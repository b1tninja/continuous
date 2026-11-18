import { describe, expect, it } from "vitest";

import { MessageAbortControllers } from "./messageAbortControllers";

async function* stream(values: number[], fail?: Error) {
  for (const value of values) {
    yield value;
  }
  if (fail) {
    throw fail;
  }
  return "done";
}

async function drain<T, R>(gen: AsyncGenerator<T, R>) {
  const values: T[] = [];
  for (;;) {
    const next = await gen.next();
    if (next.done) {
      return { values, result: next.value };
    }
    values.push(next.value);
  }
}

describe("MessageAbortControllers", () => {
  it("forgets a stream that ends normally, keeping its values and result", async () => {
    const registry = new MessageAbortControllers();
    const controller = registry.add("m1");
    const wrapped = registry.releaseWhenDone(
      "m1",
      controller,
      stream([1, 2, 3]),
    );
    expect(registry.size).toBe(1);
    expect(await drain(wrapped)).toEqual({
      values: [1, 2, 3],
      result: "done",
    });
    expect(registry.size).toBe(0);
  });

  it("forgets a stream that throws, and passes the error on", async () => {
    const registry = new MessageAbortControllers();
    const controller = registry.add("m1");
    const wrapped = registry.releaseWhenDone(
      "m1",
      controller,
      stream([1], new Error("boom")),
    );
    await expect(drain(wrapped)).rejects.toThrow("boom");
    expect(registry.size).toBe(0);
  });

  it("forgets a stream its consumer stops early", async () => {
    const registry = new MessageAbortControllers();
    const controller = registry.add("m1");
    const wrapped = registry.releaseWhenDone(
      "m1",
      controller,
      stream([1, 2, 3]),
    );
    await wrapped.next();
    await wrapped.return("stopped" as never);
    expect(registry.size).toBe(0);
  });

  it("still aborts by id, and forgets the aborted request", () => {
    const registry = new MessageAbortControllers();
    const controller = registry.add("m1");
    registry.abort("m1");
    expect(controller.signal.aborted).toBe(true);
    expect(registry.size).toBe(0);
    // Aborting an unknown or finished id is harmless
    registry.abort("m1");
    registry.abort("unknown");
  });

  it("does not forget a newer request that reused the id", () => {
    const registry = new MessageAbortControllers();
    const old = registry.add("m1");
    const newer = registry.add("m1");
    registry.release("m1", old);
    expect(registry.size).toBe(1);
    registry.abort("m1");
    expect(newer.signal.aborted).toBe(true);
    expect(old.signal.aborted).toBe(false);
  });

  it("stays empty over many finished requests", async () => {
    const registry = new MessageAbortControllers();
    for (let i = 0; i < 1000; i++) {
      const id = `m${i}`;
      const controller = registry.add(id);
      await drain(registry.releaseWhenDone(id, controller, stream([i])));
    }
    expect(registry.size).toBe(0);
  });
});
