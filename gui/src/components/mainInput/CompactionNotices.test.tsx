import { act, createEvent, fireEvent, screen } from "@testing-library/react";
import type { ModelDescription } from "core";
import { describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { EMPTY_CONFIG, updateConfig } from "../../redux/slices/configSlice";
import {
  newSession,
  type PreparedCompaction,
  setCompactionHold,
  setPreparedCompaction,
} from "../../redux/slices/sessionSlice";
import { setupStore } from "../../redux/store";
import type { RootState } from "../../redux/store";
import { currentCompactionPlan } from "../../redux/thunks/prepareCompaction";
import { renderWithProviders } from "../../util/test/render";
import { CompactionHoldNotice } from "./CompactionHoldNotice";
import {
  CompactionPreparedNotice,
  spanTurns,
} from "./CompactionPreparedNotice";

vi.mock("../../redux/util/getBaseSystemMessage", () => ({
  getBaseSystemMessage: vi.fn(() => "You are a helpful assistant."),
}));

const strata: ModelDescription = {
  title: "Qwen on Strata",
  model: "qwen3-coder",
  provider: "openai",
  underlyingProviderName: "openai",
  apiBase: "http://127.0.0.1:8086/v1",
  contextLength: 100_000,
};

const historyOf = (exchanges: number) =>
  Array.from({ length: exchanges }, (_, t) => [
    {
      message: {
        id: `u${t}`,
        role: "user",
        content: `${t} ${"q".repeat(14_400)}`,
      },
      contextItems: [],
    },
    {
      message: {
        id: `a${t}`,
        role: "assistant",
        content: `${t} ${"a".repeat(14_400)}`,
      },
      contextItems: [],
    },
  ]).flat();

async function setup(ui: React.ReactElement, exchanges = 10) {
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  const view = await renderWithProviders(ui, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  await act(async () => {
    store.dispatch(
      updateConfig({
        ...EMPTY_CONFIG,
        selectedModelByRole: {
          ...EMPTY_CONFIG.selectedModelByRole,
          chat: strata,
        },
        modelsByRole: { ...EMPTY_CONFIG.modelsByRole, chat: [strata] },
      } as any),
    );
    store.dispatch(
      newSession({
        sessionId: "s1",
        title: "t",
        workspaceDirectory: "",
        history: historyOf(exchanges),
      } as any),
    );
  });
  const getState = () => store.getState() as RootState;
  const prepare = async (extra: Partial<PreparedCompaction> = {}) => {
    const plan = currentCompactionPlan(getState())!;
    await act(async () => {
      store.dispatch(
        setPreparedCompaction({
          sessionId: "s1",
          planId: plan.id,
          spanStart: plan.spanStart,
          spanEnd: plan.spanEnd,
          status: "ready",
          summary: "The summary.",
          ...extra,
        }),
      );
    });
    return plan;
  };
  return { ...view, store, ideMessenger, getState, prepare };
}

describe("the prepared notice", () => {
  it("names the summarised turns and says it applies at the next turn", async () => {
    const t = await setup(<CompactionPreparedNotice />);
    expect(screen.queryByTestId("compaction-prepared-notice")).toBeNull();
    const plan = await t.prepare();
    const { first, last } = spanTurns(
      t.getState().session.history,
      plan.spanStart,
      plan.spanEnd,
    );
    expect(
      (await screen.findByTestId("compaction-prepared-notice")).textContent,
    ).toContain(
      `Compaction prepared (summary of turns ${first}–${last} ready); it applies at the next turn without re-reading.`,
    );
  });

  it("says pre-warmed once the server has read it", async () => {
    const t = await setup(<CompactionPreparedNotice />);
    await t.prepare({ prewarm: { status: "done" } });
    expect(
      (await screen.findByTestId("compaction-prepared-notice")).textContent,
    ).toMatch(/^Compaction prepared and pre-warmed \(summary of turns/);
  });

  it("says why it was not pre-warmed", async () => {
    const t = await setup(<CompactionPreparedNotice />);
    await t.prepare({
      prewarm: {
        status: "skipped",
        detail: "Strata reports about 4.3 GB of free memory",
      },
    });
    expect(
      (await screen.findByTestId("compaction-prepared-notice")).textContent,
    ).toContain("Not pre-warmed: Strata reports about 4.3 GB of free memory.");
  });

  it("Not now hides it and keeps the summary from applying at the next turn", async () => {
    const t = await setup(<CompactionPreparedNotice />);
    await t.prepare();
    await t.user.click(
      await screen.findByTestId("compaction-prepared-notice-dismiss"),
    );
    expect(screen.queryByTestId("compaction-prepared-notice")).toBeNull();
    expect(t.getState().session.preparedCompaction?.dismissed).toBe(true);
  });

  it("Compact now saves it at once", async () => {
    const t = await setup(<CompactionPreparedNotice />);
    const plan = await t.prepare();
    await t.user.click(
      await screen.findByTestId("compaction-prepared-compact-now"),
    );
    expect(
      t.getState().session.history[plan.spanEnd - 1].conversationSummary,
    ).toBe("The summary.");
  });

  it("counts turns from the person's messages", () => {
    const history = historyOf(5) as any;
    expect(spanTurns(history, 0, 6)).toEqual({ first: 1, last: 3 });
    expect(spanTurns(history, 4, 8)).toEqual({ first: 3, last: 4 });
  });
});

describe("the forced-path hold", () => {
  const held = {
    planId: "cp-0-20-x",
    rereadTokens: 390_000,
    editorState: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Go" }] }],
    },
    modifiers: { useCodebase: false, noContext: true },
  };

  async function holdSetup() {
    const t = await setup(<CompactionHoldNotice />, 12);
    await act(async () => {
      t.store.dispatch(setCompactionHold(held));
    });
    return t;
  }

  it("says what the message would cost and offers the two choices", async () => {
    await holdSetup();
    const notice = await screen.findByTestId("compaction-hold");
    expect(notice.textContent).toContain("Your message is waiting");
    expect(notice.textContent).toContain(
      "about 390k tokens would be read again",
    );
    expect(screen.getByTestId("compaction-hold-compact")).toBeInTheDocument();
    expect(screen.getByTestId("compaction-hold-continue")).toBeInTheDocument();
  });

  it("puts the focus on Compact now, so Enter chooses it", async () => {
    const t = await holdSetup();
    const compact = await screen.findByTestId("compaction-hold-compact");
    expect(document.activeElement).toBe(compact);
    t.ideMessenger.responseHandlers["conversation/compact"] = vi.fn(
      async () => undefined,
    ) as any;
    await t.user.keyboard("{Enter}");
    expect(
      t.ideMessenger.responseHandlers["conversation/compact"],
    ).toHaveBeenCalled();
    expect(t.getState().session.compactionHold).toBeUndefined();
  });

  it("a repeated key press chooses nothing", async () => {
    const t = await holdSetup();
    const compact = await screen.findByTestId("compaction-hold-compact");
    const repeat = createEvent.keyDown(compact, { key: "Enter", repeat: true });
    fireEvent(compact, repeat);
    expect(repeat.defaultPrevented).toBe(true);
    const fresh = createEvent.keyDown(compact, { key: "Enter" });
    fireEvent(compact, fresh);
    expect(fresh.defaultPrevented).toBe(false);
    expect(t.getState().session.compactionHold).toEqual(held);
  });

  it("Continue anyway takes a click, sends the message, and the plan is not held again", async () => {
    const t = await holdSetup();
    await t.user.click(await screen.findByTestId("compaction-hold-continue"));
    expect(t.getState().session.compactionHold).toBeUndefined();
    expect(t.getState().session.compactionHoldContinued).toBe(held.planId);
    expect(screen.queryByTestId("compaction-hold")).toBeNull();
  });
});
