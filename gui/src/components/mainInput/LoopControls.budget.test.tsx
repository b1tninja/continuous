import { cleanup, fireEvent, screen } from "@testing-library/react";
import type { LoopItemState, LoopState } from "core";
import { createLoop } from "core/util/loopMode";
import { describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { setLoop } from "../../redux/slices/sessionSlice";
import { setupStore } from "../../redux/store";
import { renderWithProviders } from "../../util/test/render";
import { LoopControls } from "./LoopControls";

const NOW = new Date("2026-11-09T10:00:00Z");
const PLAN = {
  items: [
    {
      id: "1",
      text: "Fix it",
      status: "pending" as const,
      budget: { tokens: 10_000, minutes: 5, turns: 20 },
    },
    { id: "2", text: "Ship it", status: "pending" as const },
  ],
  updatedAt: NOW.toISOString(),
};

describe("LoopControls and per-item budgets", () => {
  async function render(
    loopChange: Partial<LoopState> = {},
    itemChange: Partial<LoopItemState> = {},
  ) {
    const loop: LoopState = {
      ...createLoop(PLAN, { now: NOW, sessionTokens: 0, autonomy: "auto" }),
      ...loopChange,
    };
    loop.items = loop.items.map((i) =>
      i.id === "1"
        ? {
            ...i,
            attempts: 1,
            usage: { tokens: 4_000, ms: 60_000 },
            ...itemChange,
          }
        : i,
    );
    const ideMessenger = new MockIdeMessenger();
    const store = setupStore({ ideMessenger });
    await renderWithProviders(<LoopControls loop={loop} taskPlan={PLAN} />, {
      store,
      mockIdeMessenger: ideMessenger,
    });
    store.dispatch(setLoop(loop));
    return { store };
  }

  it("shows an item's budget with what is left, and none for one without", async () => {
    await render();
    const line = screen.getByTestId("loop-budget-1").textContent;
    expect(line).toContain("4K of 10K tokens, 6K left");
    expect(line).toContain("1m of 5m, 4m left");
    expect(line).toContain("20 turns a run");
    expect(screen.queryByTestId("loop-budget-2")).toBeNull();
  });

  it("says when an item ran over, and how often it was extended", async () => {
    await render({}, { extensions: 1 });
    expect(screen.queryByTestId("loop-over-budget-1")).toBeNull();
    expect(screen.getByTestId("loop-budget-1").textContent).toContain(
      "extended 1×",
    );
    cleanup();
    await render(
      {},
      {
        status: "failed",
        overBudget: { which: "tokens", used: 11_000, limit: 10_000 },
      },
    );
    expect(screen.getByTestId("loop-over-budget-1").textContent).toContain(
      "used 11,000 of its 10,000 tokens",
    );
  });

  it("shows an item's cost beside its tokens, and its dollar budget when the cost is known", async () => {
    const withUsd = {
      ...PLAN,
      items: [{ ...PLAN.items[0], budget: { usd: 1 } }, PLAN.items[1]],
    };
    const loop: LoopState = createLoop(withUsd, {
      now: NOW,
      sessionTokens: 0,
      costMark: {},
    });
    // A budget that differs from the level's own shows the usage rows
    loop.budget = { ...loop.budget, maxRounds: loop.budget.maxRounds + 1 };
    loop.items = loop.items.map((i) =>
      i.id === "1"
        ? {
            ...i,
            attempts: 1,
            usage: { tokens: 4_000, ms: 60_000, cost: 0.25 },
          }
        : i,
    );
    const ideMessenger = new MockIdeMessenger();
    const store = setupStore({ ideMessenger });
    await renderWithProviders(<LoopControls loop={loop} taskPlan={withUsd} />, {
      store,
      mockIdeMessenger: ideMessenger,
    });
    store.dispatch(setLoop(loop));
    expect(screen.getByTestId("loop-runs-1").textContent).toContain(
      "4K tokens · $0.25 · 1m",
    );
    expect(screen.getByTestId("loop-budget-1").textContent).toContain(
      "$0.25 of $1.00, $0.75 left",
    );
  });

  it("says the dollar budget is not enforced when the cost is unknown", async () => {
    const withUsd = {
      ...PLAN,
      items: [{ ...PLAN.items[0], budget: { usd: 1 } }, PLAN.items[1]],
    };
    const loop: LoopState = createLoop(withUsd, {
      now: NOW,
      sessionTokens: 0,
      costMark: {},
    });
    // A budget that differs from the level's own shows the usage rows
    loop.budget = { ...loop.budget, maxRounds: loop.budget.maxRounds + 1 };
    loop.items = loop.items.map((i) =>
      i.id === "1"
        ? {
            ...i,
            attempts: 1,
            usage: { tokens: 4_000, ms: 60_000, cost: "unknown" as const },
          }
        : i,
    );
    const ideMessenger = new MockIdeMessenger();
    const store = setupStore({ ideMessenger });
    await renderWithProviders(<LoopControls loop={loop} taskPlan={withUsd} />, {
      store,
      mockIdeMessenger: ideMessenger,
    });
    store.dispatch(setLoop(loop));
    expect(screen.getByTestId("loop-runs-1").textContent).toContain(
      "cost unknown",
    );
    expect(screen.getByTestId("loop-budget-1").textContent).toContain(
      "cost unknown for this model; dollar budget not enforced",
    );
  });

  it("titles the item text", async () => {
    await render();
    expect(
      screen.getByTestId("loop-item-1").querySelector("[title]"),
    ).toHaveAttribute("title", "1. Fix it");
  });
});
