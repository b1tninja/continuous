import { describe, expect, it } from "vitest";
import { acquireFileLock, waitUntil } from "./fileLock";

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("acquireFileLock", () => {
  it("grants the first holder at once", async () => {
    const release = await acquireFileLock("a");
    expect(typeof release).toBe("function");
    release();
  });

  it("makes a second holder of the same key wait for the release", async () => {
    const order: string[] = [];
    const first = await acquireFileLock("same");
    const second = acquireFileLock("same").then((release) => {
      order.push("second");
      release();
    });
    await tick();
    expect(order).toEqual([]);
    order.push("first-release");
    first();
    await second;
    expect(order).toEqual(["first-release", "second"]);
  });

  it("does not make different keys wait for each other", async () => {
    const a = await acquireFileLock("k1");
    const b = await acquireFileLock("k2");
    a();
    b();
  });

  it("serves three holders in order", async () => {
    const order: number[] = [];
    const r1 = await acquireFileLock("q");
    const p2 = acquireFileLock("q").then(async (r) => {
      order.push(2);
      r();
    });
    const p3 = acquireFileLock("q").then((r) => {
      order.push(3);
      r();
    });
    order.push(1);
    r1();
    await Promise.all([p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("tolerates a double release", async () => {
    const r = await acquireFileLock("dbl");
    r();
    r();
    const next = await acquireFileLock("dbl");
    next();
  });
});

describe("waitUntil", () => {
  it("resolves true at once when already done", async () => {
    expect(await waitUntil(() => true, 100)).toBe(true);
  });

  it("resolves true when the condition turns true in time", async () => {
    let done = false;
    setTimeout(() => (done = true), 20);
    expect(await waitUntil(() => done, 500, 5)).toBe(true);
  });

  it("resolves false at the timeout", async () => {
    expect(await waitUntil(() => false, 30, 5)).toBe(false);
  });
});
