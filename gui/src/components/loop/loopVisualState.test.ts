import type { LoopState } from "core";
import { describe, expect, it } from "vitest";
import { getLoopVisualState, LOOP_VISUAL } from "./loopVisualState";

function loop(over: Partial<LoopState>): LoopState {
  return { status: "running", items: [], ...over } as LoopState;
}

describe("getLoopVisualState", () => {
  it("maps the running statuses to running", () => {
    expect(getLoopVisualState(loop({ status: "running" }))).toBe("running");
    expect(getLoopVisualState(loop({ status: "replanning" }))).toBe("running");
  });

  it("maps a wait on the person to waiting", () => {
    expect(getLoopVisualState(loop({ status: "waiting" }))).toBe("waiting");
    expect(getLoopVisualState(loop({ status: "awaiting_plan" }))).toBe(
      "waiting",
    );
  });

  it("maps a stop for done to finished", () => {
    expect(
      getLoopVisualState(loop({ status: "stopped", stopReason: "done" })),
    ).toBe("finished");
  });

  it("maps an error stop to failed and every other stop to stopped", () => {
    for (const reason of ["error", "failures", "replan_failed"] as const) {
      expect(
        getLoopVisualState(loop({ status: "stopped", stopReason: reason })),
      ).toBe("failed");
    }
    for (const reason of [
      "stopped",
      "left_loop",
      "rounds",
      "tokens",
      "time",
      "no_progress",
    ] as const) {
      expect(
        getLoopVisualState(loop({ status: "stopped", stopReason: reason })),
      ).toBe("stopped");
    }
    expect(getLoopVisualState(loop({ status: "stopped" }))).toBe("stopped");
  });

  it("shows a failed item as failed while its repair re-plan runs", () => {
    const repairing = loop({
      status: "replanning",
      items: [{ id: "5", status: "failed", attempts: 2 }] as LoopState["items"],
      current: {
        kind: "replan",
        itemId: "5",
        historyIndex: 0,
        startedAt: "",
      },
    });
    expect(getLoopVisualState(repairing)).toBe("failed");
    // A failed item that is not being repaired does not paint the whole loop
    expect(getLoopVisualState({ ...repairing, current: undefined })).toBe(
      "running",
    );
  });

  it("gives every state an icon, a word and a colour", () => {
    for (const style of Object.values(LOOP_VISUAL)) {
      expect(style.word.length).toBeGreaterThan(0);
      expect(style.text).toMatch(/^text-/);
      expect(style.fill).toMatch(/^bg-/);
      expect(style.border).toMatch(/^border-/);
    }
    expect(LOOP_VISUAL.running.icon).toBe("dot");
    expect(LOOP_VISUAL.finished.icon).toBe("check");
    expect(LOOP_VISUAL.waiting.icon).toBe("pause");
    expect(LOOP_VISUAL.failed.icon).toBe("cross");
    expect(LOOP_VISUAL.stopped.icon).toBe("stop");
  });
});
