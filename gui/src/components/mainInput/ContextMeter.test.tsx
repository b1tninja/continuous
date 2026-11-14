import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { EMPTY_CONFIG, updateConfig } from "../../redux/slices/configSlice";
import {
  addRequestUsageToSession,
  newSession,
  setContextPercentage,
  setIsPruned,
  setAllSessionMetadata,
  setPromptCacheState,
} from "../../redux/slices/sessionSlice";
import { setPromptCacheSetting } from "../../redux/slices/uiSlice";
import { setupStore } from "../../redux/store";
import { renderWithProviders } from "../../util/test/render";
import { ContextMeter, HOVER_OPEN_MS } from "./ContextMeter";
import { ToolbarWidthContext, type WidthTier } from "./InputToolbar/widthTier";

const sonnet = {
  title: "Sonnet",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  underlyingProviderName: "anthropic",
  contextLength: 200_000,
} as any;
const haiku55 = {
  title: "Haiku 5.5",
  provider: "bedrock",
  model: "us.anthropic.claude-haiku-5-5",
  underlyingProviderName: "bedrock",
  contextLength: 1_000_000,
} as any;
const strata = {
  title: "Strata",
  provider: "openai",
  model: "qwen3.8-flash-next-nvfp4-nvfp4",
  apiBase: "http://127.0.0.1:8083/v1/",
  underlyingProviderName: "openai",
  contextLength: 200_000,
} as any;

const history = [
  {
    message: { role: "user", content: "Read src/x.ts" },
    contextItems: [],
  },
  {
    message: {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "c1",
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ filepath: "src/x.ts" }),
          },
        },
      ],
    },
    contextItems: [],
    toolCallStates: [
      {
        toolCallId: "c1",
        toolCall: {
          id: "c1",
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ filepath: "src/x.ts" }),
          },
        },
        status: "done",
        parsedArgs: { filepath: "src/x.ts" },
        output: [
          {
            name: "x.ts",
            description: "src/x.ts",
            content: "x".repeat(48_000),
          },
        ],
      },
    ],
  },
];

interface Options {
  model?: any;
  /** Provider-reported input tokens of the last request. */
  reported?: number;
  /** Core's estimate, when no usage is reported. */
  estimate?: number;
  pruned?: boolean;
  tier?: WidthTier;
}

async function setup({
  model = sonnet,
  reported,
  estimate,
  pruned,
  tier = "wide",
}: Options = {}) {
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  const view = await renderWithProviders(
    <ToolbarWidthContext.Provider value={tier}>
      <ContextMeter />
    </ToolbarWidthContext.Provider>,
    { store, mockIdeMessenger: ideMessenger },
  );
  await act(async () => {
    store.dispatch(
      updateConfig({
        ...EMPTY_CONFIG,
        selectedModelByRole: {
          ...EMPTY_CONFIG.selectedModelByRole,
          chat: model,
        },
        modelsByRole: { ...EMPTY_CONFIG.modelsByRole, chat: [model] },
      } as any),
    );
    store.dispatch(
      setPromptCacheSetting({ modelTitle: model.title, setting: "5m" }),
    );
    store.dispatch(
      newSession({
        sessionId: "s",
        title: "t",
        workspaceDirectory: "",
        history,
      } as any),
    );
    if (estimate !== undefined) store.dispatch(setContextPercentage(estimate));
    if (pruned) store.dispatch(setIsPruned(true));
    if (reported !== undefined) {
      store.dispatch(
        addRequestUsageToSession({
          provider: model.provider,
          model: model.model,
          usage: { promptTokens: reported, completionTokens: 0 },
        }),
      );
      store.dispatch(
        setPromptCacheState({
          escalated: false,
          lastRequestAt: Date.now() - 1000,
          lastTtl: "5m",
          lastInputTokens: reported,
        }),
      );
    }
  });
  return { ...view, store, ideMessenger };
}

describe("ContextMeter glyph", () => {
  it("is absent before there is a number", async () => {
    await setup();
    expect(screen.queryByTestId("context-meter")).toBeNull();
  });

  it("shows the share of the window and is named for it", async () => {
    await setup({ reported: 86_000 });
    const meter = screen.getByRole("button", { name: "Context 43% used" });
    expect(meter.textContent).toBe("Context 43%");
    expect(meter.getAttribute("data-level")).toBe("ok");
  });

  it("drops the word at narrower widths but keeps it in the name", async () => {
    await setup({ reported: 86_000, tier: "narrow" });
    const meter = screen.getByTestId("context-meter");
    expect(meter.textContent).toBe("43%");
    expect(meter.getAttribute("aria-label")).toBe("Context 43% used");
  });

  it("falls back to core's estimate when no usage is reported", async () => {
    await setup({ estimate: 0.7 });
    const meter = screen.getByRole("button", { name: "Context 70% used" });
    expect(meter.getAttribute("data-level")).toBe("warn");
  });

  it("turns to the error colour from 80% and when messages are left out", async () => {
    await setup({ reported: 170_000 });
    expect(screen.getByTestId("context-meter").getAttribute("data-level")).toBe(
      "high",
    );
    expect(screen.getByTestId("context-meter-fill").className).toContain(
      "bg-error",
    );
  });

  it("says so in its name when the oldest messages are left out", async () => {
    await setup({ estimate: 0.3, pruned: true });
    const meter = screen.getByRole("button", {
      name: "Context 30% used, oldest messages left out",
    });
    expect(meter.getAttribute("data-level")).toBe("high");
  });

  it("is at least the warning colour at a size that costs real money", async () => {
    // 250k tokens is 25% of a 1M window
    await setup({ model: haiku55, reported: 250_000 });
    expect(screen.getByTestId("context-meter").getAttribute("data-level")).toBe(
      "warn",
    );
  });
});

describe("ContextMeter details", () => {
  it("open with a click and close with Escape", async () => {
    const { user } = await setup({ reported: 86_000 });
    await user.click(screen.getByTestId("context-meter"));
    const panel = await screen.findByTestId("context-panel");
    expect(panel.textContent).toContain("Context: 86k of 200k tokens (43%)");
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByTestId("context-panel")).toBeNull(),
    );
  });

  it("open from the keyboard with Enter, no pointer needed", async () => {
    const { user } = await setup({ reported: 86_000 });
    screen.getByTestId("context-meter").focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByTestId("context-panel")).toBeInTheDocument();
    expect(screen.getByTestId("context-meter")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("open on hover and close when the pointer leaves", async () => {
    const { user } = await setup({ reported: 86_000 });
    await user.hover(screen.getByTestId("context-meter"));
    expect(
      await screen.findByTestId(
        "context-panel",
        {},
        { timeout: HOVER_OPEN_MS * 5 },
      ),
    ).toBeInTheDocument();
    await user.unhover(screen.getByTestId("context-meter"));
    await waitFor(() =>
      expect(screen.queryByTestId("context-panel")).toBeNull(),
    );
  });

  it("stay open when the details a hover opened are clicked", async () => {
    const { user } = await setup({ reported: 86_000 });
    const meter = screen.getByTestId("context-meter");
    await user.hover(meter);
    await screen.findByTestId(
      "context-panel",
      {},
      { timeout: HOVER_OPEN_MS * 5 },
    );
    await user.click(meter);
    await user.unhover(meter);
    await new Promise((r) => setTimeout(r, HOVER_OPEN_MS * 2));
    expect(screen.getByTestId("context-panel")).toBeInTheDocument();
  });

  it("have a table that says what the bar shows, scaled to the provider's count", async () => {
    const { user } = await setup({ reported: 86_000 });
    await user.click(screen.getByTestId("context-meter"));
    const table = await screen.findByRole("table", {
      name: "What the context holds",
    });
    const rows = within(table)
      .getAllByRole("rowheader")
      .map((h) => h.textContent);
    expect(rows).toContain("Tool results");
    expect(rows).toContain("Free space");
    expect(rows).toContain("Reserved for the reply");
    expect(screen.getByTestId("context-split-note").textContent).toContain(
      "Estimated split",
    );
    // The bar itself is hidden from screen readers: the table carries it
    expect(screen.getByTestId("context-stacked-bar")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(screen.getByTestId("context-largest").textContent).toContain(
      "Read src/x.ts",
    );
  });

  it("Compact now sends the existing compaction request for the whole conversation", async () => {
    const { user, ideMessenger } = await setup({ reported: 86_000 });
    const compact = vi.fn(async () => undefined);
    ideMessenger.responseHandlers["conversation/compact"] = compact as any;
    await user.click(screen.getByTestId("context-meter"));
    await user.click(
      await screen.findByRole("button", { name: "Compact now" }),
    );
    await waitFor(() => expect(compact).toHaveBeenCalledTimes(1));
    expect(compact.mock.calls[0]).toEqual([
      expect.objectContaining({ index: history.length - 1, sessionId: "s" }),
    ]);
    // The details close so the conversation is in view
    await waitFor(() =>
      expect(screen.queryByTestId("context-panel")).toBeNull(),
    );
  });

  it("New session starts an empty conversation", async () => {
    const { user, store } = await setup({ reported: 86_000 });
    await user.click(screen.getByTestId("context-meter"));
    await user.click(
      await screen.findByRole("button", { name: "New session" }),
    );
    await waitFor(() => expect(store.getState().session.history).toEqual([]));
  });

  it("keep the notes the battery had: cost per message and quality", async () => {
    const { user } = await setup({
      reported: 250_000,
      model: { ...sonnet, contextLength: 1_000_000 },
    });
    await user.click(screen.getByTestId("context-meter"));
    const note = await screen.findByTestId("context-size-note");
    expect(note.textContent).toContain(
      "250k tokens are sent with every message",
    );
    // 250,000 tokens: read $0.30/MTok = $0.07, 5m write $3.75/MTok = $0.94
    expect(note.textContent).toContain("$0.08");
    expect(note.textContent).toContain("$0.94");
    expect(screen.getByTestId("context-quality-note")).toBeInTheDocument();
    expect(screen.getByTestId("context-cache-status").textContent).toContain(
      "Prompt cache: warm",
    );
  });

  it("warn about the long-context price on Haiku 5.5", async () => {
    const { user } = await setup({ model: haiku55, reported: 120_000 });
    await user.click(screen.getByTestId("context-meter"));
    const note = await screen.findByTestId("long-context-note");
    expect(note.textContent).toContain("5x per token");
  });

  it("warn that compacting drops what a local server has cached", async () => {
    const { user } = await setup({ model: strata, reported: 120_000 });
    await user.click(screen.getByTestId("context-meter"));
    const note = await screen.findByTestId("compaction-cache-note");
    expect(note.textContent).toContain("120k tokens");
    expect(note.textContent).toContain("the model server's cache");
  });

  it("say when the oldest messages are left out", async () => {
    const { user } = await setup({ estimate: 0.95, pruned: true });
    await user.click(screen.getByTestId("context-meter"));
    expect(
      await screen.findByTestId("context-pruned-note"),
    ).toBeInTheDocument();
  });
});

describe("ContextMeter session file (STOR8)", () => {
  const listed = (fileBytes?: number, storage?: "json" | "log") =>
    setAllSessionMetadata([
      {
        sessionId: "other",
        title: "Other",
        dateCreated: "0",
        workspaceDirectory: "",
        fileBytes: 999 * 1024 * 1024,
      },
      {
        sessionId: "s",
        title: "t",
        dateCreated: "0",
        workspaceDirectory: "",
        fileBytes,
        ...(storage && { storage }),
      },
    ]);

  it("shows the current session's file size and item count", async () => {
    const { user, store } = await setup({ reported: 86_000 });
    await act(async () => {
      store.dispatch(listed(3.4 * 1024 * 1024));
    });
    await user.click(screen.getByTestId("context-meter"));
    const note = await screen.findByTestId("context-session-file");
    expect(note.textContent).toBe("Session file 3.4 MB, 2 items.");
    expect(note.getAttribute("data-over-budget")).toBeNull();
  });

  it("warns past the session budget", async () => {
    const { user, store } = await setup({ reported: 86_000 });
    await act(async () => {
      store.dispatch(listed(63 * 1024 * 1024));
    });
    await user.click(screen.getByTestId("context-meter"));
    const note = await screen.findByTestId("context-session-file");
    expect(note.getAttribute("data-over-budget")).toBe("true");
    expect(note.className).toContain("text-warning");
    expect(note.textContent).toContain("Session file 63 MB, 2 items.");
    expect(note.textContent).toContain("Past the 50 MB session budget");
  });

  it("counts a log session's log and stored outputs", async () => {
    const { user, store } = await setup({ reported: 86_000 });
    await act(async () => {
      store.dispatch(listed(1.5 * 1024 * 1024, "log"));
    });
    await user.click(screen.getByTestId("context-meter"));
    const note = await screen.findByTestId("context-session-file");
    expect(note.textContent).toBe(
      "Session 1.5 MB on disk (log and stored outputs), 2 items.",
    );
  });

  it("warns past the budget for a log session without saying saves rewrite it", async () => {
    const { user, store } = await setup({ reported: 86_000 });
    await act(async () => {
      store.dispatch(listed(70 * 1024 * 1024, "log"));
    });
    await user.click(screen.getByTestId("context-meter"));
    const note = await screen.findByTestId("context-session-file");
    expect(note.getAttribute("data-over-budget")).toBe("true");
    expect(note.textContent).toContain("Past the 50 MB session budget");
    expect(note.textContent).toContain("opening it reads all of it");
    expect(note.textContent).not.toContain("rewrites");
  });

  it("says nothing while the size is unknown", async () => {
    const { user, store } = await setup({ reported: 86_000 });
    await act(async () => {
      store.dispatch(listed(undefined));
    });
    await user.click(screen.getByTestId("context-meter"));
    await screen.findByTestId("context-panel");
    expect(screen.queryByTestId("context-session-file")).toBeNull();
  });
});
