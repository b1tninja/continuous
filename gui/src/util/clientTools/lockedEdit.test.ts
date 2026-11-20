import { beforeEach, describe, expect, it, vi } from "vitest";
import { withFileLockUntilClosed } from "./lockedEdit";

const status: Record<string, string | undefined> = {};

vi.mock("../../redux/selectors/selectToolCalls", () => ({
  selectApplyStateByToolCallId: (_state: unknown, id: string) =>
    status[id] ? { status: status[id] } : undefined,
}));

const extras = { getState: () => ({}) } as never;
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  for (const k of Object.keys(status)) delete status[k];
});

describe("withFileLockUntilClosed", () => {
  it("returns what the work returns", async () => {
    status.a = "closed";
    expect(
      await withFileLockUntilClosed("f1", "a", extras, async () => 7),
    ).toBe(7);
  });

  it("holds the file until the first edit's diff has closed", async () => {
    const order: string[] = [];
    status.first = "streaming";
    await withFileLockUntilClosed("f2", "first", extras, async () => {
      order.push("first runs");
    });
    const second = withFileLockUntilClosed("f2", "second", extras, async () => {
      order.push("second runs");
    });
    await tick();
    expect(order).toEqual(["first runs"]);
    status.first = "closed";
    await second;
    expect(order).toEqual(["first runs", "second runs"]);
  });

  it("does not make a different file wait", async () => {
    status.one = "streaming";
    await withFileLockUntilClosed("f3", "one", extras, async () => {});
    await withFileLockUntilClosed("f4", "two", extras, async () => {});
  });

  it("gives the file back when the work throws", async () => {
    await expect(
      withFileLockUntilClosed("f5", "bad", extras, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    status.ok = "closed";
    await withFileLockUntilClosed("f5", "ok", extras, async () => {});
  });

  it("does not hold the file when the state cannot be read", async () => {
    const broken = {
      getState: () => {
        throw new Error("no state");
      },
    } as never;
    await withFileLockUntilClosed("f6", "x", broken, async () => {});
    await withFileLockUntilClosed("f6", "y", extras, async () => {});
  });
});
