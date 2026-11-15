import { act, fireEvent, screen } from "@testing-library/react";
import type { LoopQuestion, LoopState, TaskPlan } from "core";
import { createLoop } from "core/util/loopMode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import {
  newSession,
  setLoop,
  setTaskPlan,
} from "../../redux/slices/sessionSlice";
import { setupStore } from "../../redux/store";
import { renderWithProviders } from "../../util/test/render";
import { getAnnouncement, resetAnnouncer } from "../a11y/announcer";
import { ChatAnnouncer } from "../a11y/ChatAnnouncer";
import { NeedsYouTray } from "./NeedsYouTray";

vi.mock("../../redux/thunks/loop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../redux/thunks/loop")>()),
  // dispatch() hands back what a thunk returns: an object with unwrap()
  answerLoopQuestion: () => () => ({
    unwrap: async () => ({ ok: false, error: "The loop moved on" }),
  }),
}));

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

describe("NeedsYouTray bulk error", () => {
  beforeEach(() => resetAnnouncer());

  it("shows the error as plain text and says it through the existing announcer, not a role=alert of its own", async () => {
    await setup({
      ...base(),
      status: "waiting",
      questions: [question("q1"), question("q2")],
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("needs-you-use-recommended"));
    });
    const error = await screen.findByTestId("needs-you-bulk-error");
    expect(error.textContent).toBe("The loop moved on");
    expect(error.getAttribute("role")).toBeNull();
    expect(
      screen.getByTestId("needs-you-tray").querySelector("[role=alert]"),
    ).toBeNull();
    expect(getAnnouncement("assertive").text).toBe("The loop moved on");
  });
});
