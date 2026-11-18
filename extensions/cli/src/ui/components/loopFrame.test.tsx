import type { LoopItemState, LoopState } from "core/index.js";
import { createLoop, finishItemRun, startItemRun } from "core/util/loopMode.js";
import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";

import {
  LOOP_FRAME_COLORS,
  LOOP_FRAME_ICONS,
  loopFrameInfo,
  loopFrameState,
  loopFrameTop,
} from "./loopFrame.js";
import { LoopFrameTop } from "./LoopFrameTop.js";

const NOW = new Date("2026-11-07T10:00:00Z");
const plan = {
  items: [1, 2, 3].map((n) => ({
    id: String(n),
    text: `Item ${n}`,
    status: "pending" as const,
  })),
  updatedAt: NOW.toISOString(),
};

function running(): LoopState {
  const loop = createLoop(plan, { now: NOW, sessionTokens: 0 });
  return startItemRun(loop, "1", 0, NOW);
}

describe("the loop's frame colour map", () => {
  it("running is blue", () => {
    const info = loopFrameInfo(running());
    expect(info.state).toBe("running");
    expect(info.color).toBe("blue");
    expect(info.label).toMatch(/^Running · 0\/3 · R1\/\d+$/);
  });

  it("an open question or a plan to accept is yellow", () => {
    const loop = { ...running(), status: "awaiting_plan" as const };
    expect(loopFrameState(loop)).toBe("waiting");
    expect(loopFrameInfo(loop).color).toBe("yellow");
    expect(loopFrameState({ ...running(), status: "waiting" })).toBe("waiting");
  });

  it("a failed item while the repair re-plan runs is red; back to blue when it runs again", () => {
    let loop = startItemRun(
      createLoop(plan, { now: NOW, sessionTokens: 0 }),
      "1",
      0,
      NOW,
    );
    loop = finishItemRun(loop, { outcome: "stuck", summary: "no" });
    const failed: LoopState = {
      ...loop,
      status: "replanning",
      items: loop.items.map((i: LoopItemState) =>
        i.id === "1" ? { ...i, status: "failed" as const } : i,
      ),
    };
    const info = loopFrameInfo(failed);
    expect(info.state).toBe("failed");
    expect(info.color).toBe("red");
    expect(info.label).toContain("Item 1 failed · repairing");
    expect(loopFrameState({ ...failed, status: "running" })).toBe("running");
  });

  it("finished is green, any other stop is gray", () => {
    const done = {
      ...running(),
      status: "stopped" as const,
      stopReason: "done" as const,
    };
    expect(loopFrameInfo(done)).toMatchObject({ color: "green", icon: "✓" });
    const stopped = { ...done, stopReason: "stopped" as const };
    expect(loopFrameInfo(stopped)).toMatchObject({ color: "gray", icon: "■" });
    expect(loopFrameInfo(stopped).label).toMatch(/^Stopped/);
  });

  it("every state has a colour, a one-cell icon and a word", () => {
    expect(Object.values(LOOP_FRAME_COLORS)).toHaveLength(5);
    for (const icon of Object.values(LOOP_FRAME_ICONS)) {
      expect([...icon]).toHaveLength(1);
    }
  });
});

describe("the top border label", () => {
  it("is exactly as wide as the terminal, corners included", () => {
    const info = loopFrameInfo(running());
    for (const width of [20, 40, 80, 120]) {
      const top = loopFrameTop(info, width);
      expect([...top]).toHaveLength(width);
      expect(top.startsWith("╭─ ● Running")).toBe(true);
      expect(top.endsWith("─╮") || top.endsWith("…╮")).toBe(true);
    }
  });

  it("reads without colour: icon and word in the line Ink prints", () => {
    const { lastFrame } = render(
      <LoopFrameTop
        info={loopFrameInfo({ ...running(), status: "waiting" })}
      />,
    );
    expect(lastFrame()).toContain("╭─ ‖ Waiting for you");
  });
});
