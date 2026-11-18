import { act, fireEvent, screen } from "@testing-library/react";
import type { LoopQuestion, LoopState, TaskPlan } from "core";
import { createLoop } from "core/util/loopMode";
import { beforeEach, describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import {
  newSession,
  setLoop,
  setTaskPlan,
} from "../../redux/slices/sessionSlice";
import { setupStore } from "../../redux/store";
import { renderWithProviders } from "../../util/test/render";
import { announce, resetAnnouncer } from "../a11y/announcer";
import { ChatAnnouncer } from "../a11y/ChatAnnouncer";
import { describeLoopChange } from "./useLoopAnnouncements";
import { NeedsYouTray, recommendedFor } from "./NeedsYouTray";

const PLAN = {
  items: [
    { id: "1", text: "Pick the grammar", status: "pending" },
    { id: "2", text: "Write the lexer", status: "pending" },
  ],
  updatedAt: "2026-11-10T10:00:00Z",
} as TaskPlan;

function question(id: string, over: Partial<LoopQuestion> = {}): LoopQuestion {
  return {
    id,
    itemId: "1",
    question: `Question ${id}?`,
    kind: "blocking",
    options: ["Yes (recommended)", "No"],
    askedAt: "2026-11-10T10:00:00Z",
    ...over,
  };
}

function base(): LoopState {
  return createLoop(PLAN, {
    now: new Date(),
    sessionTokens: 0,
    autonomy: "auto",
  });
}

async function setup(loop: LoopState) {
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  const view = await renderWithProviders(
    <>
      <ChatAnnouncer />
      <NeedsYouTray />
    </>,
    { store, mockIdeMessenger: ideMessenger },
  );
  await act(async () => {
    store.dispatch(newSession());
    store.dispatch(setTaskPlan(PLAN));
    store.dispatch(setLoop(loop));
  });
  return { ...view, store };
}

describe("NeedsYouTray", () => {
  beforeEach(() => resetAnnouncer());

  it("is one grey line when nothing waits", async () => {
    await setup({ ...base(), status: "running" });
    const tray = screen.getByTestId("needs-you-tray");
    expect(tray.getAttribute("data-quiet")).toBe("true");
    expect(tray.textContent).toBe("Nothing needs you. The loop is running.");
    expect(tray.getAttribute("aria-label")).toBe("Needs you");
  });

  it("adds no live region of its own", async () => {
    await setup({
      ...base(),
      status: "waiting",
      questions: [question("q1"), question("q2")],
    });
    const tray = screen.getByTestId("needs-you-tray");
    expect(tray.querySelector("[aria-live]")).toBeNull();
    expect(tray.querySelector("[role=status],[role=alert]")).toBeNull();
  });

  it("shows one question at a time with a pager", async () => {
    await setup({
      ...base(),
      status: "waiting",
      questions: [question("q1"), question("q2"), question("q3")],
    });
    expect(screen.getByTestId("needs-you-pager").textContent).toBe("1 of 3");
    expect(screen.getAllByTestId(/^loop-question-/)).toHaveLength(1);
    expect(screen.getByTestId("loop-question-q1")).toBeDefined();
    await act(async () =>
      fireEvent.click(screen.getByTestId("needs-you-next")),
    );
    expect(screen.getByTestId("needs-you-pager").textContent).toBe("2 of 3");
    expect(screen.getByTestId("loop-question-q2")).toBeDefined();
    expect(screen.getByTestId("needs-you-prev")).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("offers Use recommended for all N when every question carries a recommended label", async () => {
    await setup({
      ...base(),
      status: "waiting",
      questions: [question("q1"), question("q2"), question("q3")],
    });
    expect(screen.getByTestId("needs-you-use-recommended").textContent).toBe(
      "Use recommended for all 3",
    );
  });

  it("says how many have a recommendation when not all do", async () => {
    await setup({
      ...base(),
      status: "waiting",
      questions: [
        question("q1"),
        question("q2"),
        question("q3", { options: ["A", "B"] }),
      ],
    });
    expect(screen.getByTestId("needs-you-use-recommended").textContent).toBe(
      "Use recommended for 2 of 3",
    );
  });

  it("does not offer it for a single question or without recommendations", async () => {
    await setup({
      ...base(),
      status: "waiting",
      questions: [question("q1", { options: ["A", "B"] }), question("q2")],
    });
    expect(screen.queryByTestId("needs-you-use-recommended")).toBeNull();
  });

  it("holds the plan accept when a re-plan waits", async () => {
    await setup({
      ...base(),
      status: "awaiting_plan",
      replanReason: "Item 2 failed",
    });
    expect(screen.getByTestId("needs-you-plan-reason").textContent).toContain(
      "Item 2 failed",
    );
    for (const id of [
      "needs-you-review-diff",
      "needs-you-keep-planning",
      "needs-you-accept-plan",
    ]) {
      expect(screen.getByTestId(id)).toBeDefined();
    }
    expect(screen.getByTestId("needs-you-count").textContent).toBe("1");
  });

  it("says finished and offers a new plan", async () => {
    await setup({ ...base(), status: "stopped", stopReason: "done" });
    expect(screen.getByTestId("needs-you-tray").textContent).toContain(
      "Loop finished",
    );
    expect(screen.getByTestId("needs-you-new-plan")).toBeDefined();
  });

  it("announces a wait through the shared polite region", async () => {
    const { store } = await setup({ ...base(), status: "running" });
    await act(async () => {
      store.dispatch(
        setLoop({
          ...base(),
          status: "waiting",
          questions: [question("q1"), question("q2")],
        }),
      );
    });
    expect(screen.getByTestId("live-region-polite").textContent).toContain(
      "2 questions need you",
    );
  });
});

describe("recommendedFor", () => {
  it("prefers the assumption among the options, then a labelled option", () => {
    expect(
      recommendedFor(
        question("q", {
          options: ["A", "B"],
          assumption: "B",
          kind: "assumption",
        }),
      ),
    ).toBe("B");
    expect(recommendedFor(question("q"))).toBe("Yes (recommended)");
    expect(
      recommendedFor(question("q", { options: ["A", "B"] })),
    ).toBeUndefined();
    expect(recommendedFor(question("q", { kind: "approval" }))).toBeUndefined();
  });
});

describe("describeLoopChange", () => {
  const before = { state: "running", open: 0, awaitingPlan: false };

  it("says nothing the first time and nothing when nothing changed", () => {
    expect(describeLoopChange(undefined, base(), 0)).toBeUndefined();
    expect(describeLoopChange(before, base(), 0)).toBeUndefined();
  });

  it("names the state changes and no others", () => {
    const loop = base();
    expect(
      describeLoopChange(before, { ...loop, status: "awaiting_plan" }, 0),
    ).toBe("Loop waiting for you: new plan to accept");
    expect(describeLoopChange(before, loop, 1)).toBe("1 question needs you");
    expect(
      describeLoopChange(
        { ...before, state: "waiting" },
        { ...loop, status: "running" },
        0,
      ),
    ).toBe("Loop running again");
    expect(
      describeLoopChange(
        before,
        {
          ...loop,
          status: "stopped",
          stopReason: "done",
          items: loop.items.map((i) => ({ ...i, status: "done" as const })),
        },
        0,
      ),
    ).toBe("Loop finished, 2 of 2 done");
  });
});

// The announcer is shared: an unrelated announcement does not touch the tray
describe("announcer", () => {
  it("is not used by the tray when nothing changes", async () => {
    resetAnnouncer();
    announce("Elsewhere");
    await setup({ ...base(), status: "running" });
    expect(screen.getByTestId("live-region-polite").textContent).toBe(
      "Elsewhere",
    );
  });
});
