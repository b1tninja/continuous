import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeSilence,
  isStreamStalled,
  nextWithDeadline,
  STALL_AFTER_FIRST_CHUNK_LOCAL_MS,
  STALL_AFTER_FIRST_CHUNK_MS,
  STALL_BEFORE_FIRST_CHUNK_LOCAL_MS,
  STALL_BEFORE_FIRST_CHUNK_MS,
  stallLimitMs,
  StreamStalledError,
} from "./streamDeadline";
import { classifyRequestFailure } from "./requestFailures";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("stallLimitMs", () => {
  it("allows more silence before the first chunk than after it", () => {
    expect(stallLimitMs({ sawChunk: false, local: false })).toBe(
      STALL_BEFORE_FIRST_CHUNK_MS,
    );
    expect(stallLimitMs({ sawChunk: true, local: false })).toBe(
      STALL_AFTER_FIRST_CHUNK_MS,
    );
    expect(STALL_BEFORE_FIRST_CHUNK_MS).toBeGreaterThan(
      STALL_AFTER_FIRST_CHUNK_MS,
    );
  });

  it("allows a server the person runs more time at each stage", () => {
    expect(stallLimitMs({ sawChunk: false, local: true })).toBe(
      STALL_BEFORE_FIRST_CHUNK_LOCAL_MS,
    );
    expect(stallLimitMs({ sawChunk: true, local: true })).toBe(
      STALL_AFTER_FIRST_CHUNK_LOCAL_MS,
    );
    expect(STALL_AFTER_FIRST_CHUNK_LOCAL_MS).toBeGreaterThan(
      STALL_AFTER_FIRST_CHUNK_MS,
    );
    expect(STALL_BEFORE_FIRST_CHUNK_LOCAL_MS).toBeGreaterThan(
      STALL_BEFORE_FIRST_CHUNK_MS,
    );
  });

  it("every limit is far below the two-hour HTTP inactivity default", () => {
    for (const sawChunk of [true, false]) {
      for (const local of [true, false]) {
        expect(stallLimitMs({ sawChunk, local })).toBeLessThan(7_200_000);
      }
    }
  });
});

describe("describeSilence", () => {
  it("says seconds under a minute and a half, then minutes", () => {
    expect(describeSilence(45_000)).toBe("45 seconds");
    expect(describeSilence(89_000)).toBe("89 seconds");
    expect(describeSilence(120_000)).toBe("2 minutes");
    expect(describeSilence(600_000)).toBe("10 minutes");
    expect(describeSilence(90_000)).toBe("2 minutes");
  });
});

describe("nextWithDeadline", () => {
  it("returns a chunk that arrives in time and leaves no timer behind", async () => {
    const onStall = vi.fn();
    const result = nextWithDeadline(
      () => new Promise<string>((r) => setTimeout(() => r("chunk"), 1_000)),
      5_000,
      true,
      onStall,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toBe("chunk");
    expect(onStall).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends a silent stream: calls onStall, then throws a StreamStalledError", async () => {
    const onStall = vi.fn();
    const result = nextWithDeadline(
      () => new Promise<string>(() => {}),
      5_000,
      true,
      onStall,
    );
    const caught = result.catch((e) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    const error = await caught;
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(isStreamStalled(error)).toBe(true);
    expect((error as StreamStalledError).silentMs).toBe(5_000);
    expect((error as StreamStalledError).sawChunk).toBe(true);
  });

  it("does not fire one millisecond early", async () => {
    const onStall = vi.fn();
    const result = nextWithDeadline(
      () => new Promise<string>((r) => setTimeout(() => r("late"), 5_000)),
      5_001,
      true,
      onStall,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toBe("late");
    expect(onStall).not.toHaveBeenCalled();
  });

  it("fires at the limit", async () => {
    const onStall = vi.fn();
    const result = nextWithDeadline(
      () => new Promise<string>(() => {}),
      5_000,
      false,
      onStall,
    ).catch((e) => e);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(onStall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(isStreamStalled(await result)).toBe(true);
  });

  it("each call has its own clock: steady chunks never stall", async () => {
    const onStall = vi.fn();
    for (let i = 0; i < 20; i++) {
      const result = nextWithDeadline(
        () => new Promise<number>((r) => setTimeout(() => r(i), 4_000)),
        5_000,
        true,
        onStall,
      );
      await vi.advanceTimersByTimeAsync(4_000);
      await expect(result).resolves.toBe(i);
    }
    expect(onStall).not.toHaveBeenCalled();
  });

  it("passes a stream's own error through, without a stall", async () => {
    const onStall = vi.fn();
    const result = nextWithDeadline(
      () => Promise.reject(new Error("connection reset")),
      5_000,
      true,
      onStall,
    );
    await expect(result).rejects.toThrow("connection reset");
    expect(onStall).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still ends the turn if onStall throws", async () => {
    const result = nextWithDeadline(
      () => new Promise<string>(() => {}),
      1_000,
      true,
      () => {
        throw new Error("abort failed");
      },
    ).catch((e) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    // the stall error is not replaced by the abort's
    const error = await result;
    expect(error instanceof Error).toBe(true);
  });

  it("the request settling later does not become an unhandled rejection", async () => {
    let rejectLater: (e: Error) => void = () => {};
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const result = nextWithDeadline(
      () =>
        new Promise<string>((_, reject) => {
          rejectLater = reject;
        }),
      1_000,
      true,
    ).catch((e) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    await result;
    rejectLater(new Error("aborted"));
    await vi.advanceTimersByTimeAsync(10);
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("has no deadline for Infinity, zero or a negative number", async () => {
    for (const ms of [Infinity, 0, -5, NaN]) {
      const onStall = vi.fn();
      const result = nextWithDeadline(
        () => new Promise<string>((r) => setTimeout(() => r("ok"), 10_000_000)),
        ms,
        true,
        onStall,
      );
      await vi.advanceTimersByTimeAsync(10_000_000);
      await expect(result).resolves.toBe("ok");
      expect(onStall).not.toHaveBeenCalled();
    }
  });
});

describe("StreamStalledError", () => {
  it("says what happened and what is kept, with the length of the silence", () => {
    const after = new StreamStalledError(120_000, true).message;
    expect(after).toContain("2 minutes");
    expect(after).toContain("what arrived are kept");
    expect(after).toContain("Resume");
    const before = new StreamStalledError(600_000, false).message;
    expect(before).toContain("10 minutes");
    expect(before).toContain("sent nothing");
  });

  it("is not mistaken for an overload, which would be retried", () => {
    for (const e of [
      new StreamStalledError(120_000, true),
      new StreamStalledError(600_000, false),
    ]) {
      expect(e.message.toLowerCase()).not.toContain("overloaded");
      expect(e.message).not.toContain("529");
      expect(classifyRequestFailure(e.message, undefined)).not.toBe(
        "overloaded",
      );
    }
  });

  it("is recognised by isStreamStalled and by nothing else", () => {
    expect(isStreamStalled(new StreamStalledError(1, true))).toBe(true);
    expect(isStreamStalled(new Error("x"))).toBe(false);
    expect(isStreamStalled(undefined)).toBe(false);
    expect(isStreamStalled("stalled")).toBe(false);
  });
});
