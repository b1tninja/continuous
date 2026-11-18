import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { EMPTY_CONFIG, updateConfig } from "../../redux/slices/configSlice";
import {
  addRequestUsageToSession,
  clearContextRemovalUndo,
  newSession,
  setPromptCacheState,
} from "../../redux/slices/sessionSlice";
import { setPromptCacheSetting } from "../../redux/slices/uiSlice";
import { setupStore } from "../../redux/store";
import { renderWithProviders } from "../../util/test/render";
import { ContextMeter } from "./ContextMeter";
import { ToolbarWidthContext } from "./InputToolbar/widthTier";
import { KEEP_GROUP_VISIBLE } from "./SelectiveCompactDialog";

const sonnet = {
  title: "Sonnet",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  underlyingProviderName: "anthropic",
  contextLength: 200_000,
} as any;

const read = (n: number) => ({
  id: `c${n}`,
  type: "function" as const,
  function: {
    name: "read_file",
    arguments: JSON.stringify({ filepath: `src/f${n}.ts` }),
  },
});

/** Two turns: the first read seven files, the second is the latest. */
const files = [1, 2, 3, 4, 5, 6, 7];
const history = [
  {
    message: { id: "u1", role: "user", content: "Read the files" },
    contextItems: [],
  },
  {
    message: {
      id: "a1",
      role: "assistant",
      content: "",
      toolCalls: files.map(read),
    },
    contextItems: [],
    toolCallStates: files.map((n) => ({
      toolCallId: `c${n}`,
      toolCall: read(n),
      status: "done",
      parsedArgs: { filepath: `src/f${n}.ts` },
      output: [
        {
          name: `f${n}.ts`,
          description: `src/f${n}.ts`,
          content: "x".repeat(4000 * n),
        },
      ],
    })),
  },
  {
    message: { id: "u2", role: "user", content: "Thanks" },
    contextItems: [],
  },
  {
    message: { id: "a2", role: "assistant", content: "Done." },
    contextItems: [],
  },
];

async function setup({ warm = true }: { warm?: boolean } = {}) {
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  const view = await renderWithProviders(
    <ToolbarWidthContext.Provider value="wide">
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
          chat: sonnet,
        },
        modelsByRole: { ...EMPTY_CONFIG.modelsByRole, chat: [sonnet] },
      } as any),
    );
    store.dispatch(
      setPromptCacheSetting({ modelTitle: sonnet.title, setting: "5m" }),
    );
    store.dispatch(
      newSession({
        sessionId: "s",
        title: "t",
        workspaceDirectory: "",
        history,
      } as any),
    );
    store.dispatch(
      addRequestUsageToSession({
        provider: sonnet.provider,
        model: sonnet.model,
        usage: { promptTokens: 86_000, completionTokens: 0 },
      }),
    );
    store.dispatch(
      setPromptCacheState({
        escalated: false,
        lastRequestAt: Date.now() - (warm ? 1000 : 3_600_000),
        lastTtl: "5m",
        lastInputTokens: 86_000,
      }),
    );
  });
  return { ...view, store, ideMessenger };
}

async function openDialog(user: any) {
  await user.click(screen.getByTestId("context-meter"));
  await user.click(
    await screen.findByRole("button", { name: "Choose what to keep…" }),
  );
  return screen.findByRole("dialog", { name: "Choose what to keep" });
}

describe("Choose what to keep", () => {
  it("opens from the context panel beside Compact now, changing nothing", async () => {
    const { user, store } = await setup();
    const dialog = await openDialog(user);
    expect(screen.queryByTestId("context-panel")).toBeNull();
    expect(screen.getByTestId("keep-totals").textContent).toContain(
      "Context now: 86k of 200k (43%)",
    );
    expect(screen.getByTestId("keep-after").textContent).toBe(
      "After: 86k tokens (43%)",
    );
    expect(screen.getByTestId("keep-apply")).toBeDisabled();
    expect(within(dialog).queryByTestId("keep-cost")).toBeNull();
    // Warned before any change, since the cache is warm
    expect(screen.getByTestId("keep-cache-upfront")).toBeInTheDocument();
    expect(store.getState().session.history[1].removedByUser).toBeUndefined();
  });

  it("lists the largest items first, a few at a time", async () => {
    const { user } = await setup();
    const dialog = await openDialog(user);
    const group = within(dialog).getByTestId("keep-group-toolResults");
    const boxes = within(group).getAllByRole("checkbox");
    // The group's own box, then the largest results
    expect(boxes).toHaveLength(1 + KEEP_GROUP_VISIBLE);
    expect(boxes[1]).toHaveAccessibleName(/Read src\/f7\.ts/);
    const more = within(group).getByRole("button", { name: "Show 2 more" });
    await user.click(more);
    expect(within(group).getAllByRole("checkbox")).toHaveLength(1 + 7);
  });

  it("updates the total after and warns what the edit costs the cache", async () => {
    const { user } = await setup();
    await openDialog(user);
    await user.click(
      screen.getByRole("checkbox", { name: /Read src\/f7\.ts/ }),
    );
    const after = screen.getByTestId("keep-after").textContent!;
    expect(after).not.toBe("After: 86k tokens (43%)");
    expect(screen.getByTestId("keep-totals")).toHaveAttribute(
      "aria-live",
      "polite",
    );
    const cost = screen.getByTestId("keep-cost").textContent!;
    expect(cost).toMatch(
      /^This edits the conversation from turn 1 on: the next request re-reads \d+k tokens at full price \(about \$\d+\.\d\d more\) instead of reading it from the cache\./,
    );
    expect(cost).toContain("Undo in the context panel puts everything back");
    expect(screen.getByTestId("keep-apply").textContent).toMatch(
      /^Remove \d+(\.\d)?k$/,
    );
    // The group is now partly kept
    expect(
      screen.getByTestId("keep-group-toolResults-checkbox"),
    ).toHaveAttribute("aria-checked", "mixed");
  });

  it("says the edit costs nothing extra when the cache is cold", async () => {
    const { user } = await setup({ warm: false });
    await openDialog(user);
    expect(screen.queryByTestId("keep-cache-upfront")).toBeNull();
    await user.click(
      screen.getByRole("checkbox", { name: /Read src\/f7\.ts/ }),
    );
    expect(screen.getByTestId("keep-cost").textContent).toContain(
      "costs nothing extra",
    );
  });

  it("applies the selection as marks, and Undo in the panel puts it back", async () => {
    const { user, store } = await setup();
    await openDialog(user);
    await user.click(
      screen.getByRole("checkbox", { name: /Read src\/f7\.ts/ }),
    );
    await user.click(screen.getByTestId("keep-apply"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(store.getState().session.history[1].removedByUser).toEqual({
      toolResults: ["c7"],
    });
    const undo = store.getState().session.contextRemovalUndo!;
    expect(undo.previous).toEqual({ a1: null });
    expect(undo.removedTokens).toBeGreaterThan(6000);

    await user.click(screen.getByTestId("context-meter"));
    const note = await screen.findByTestId("context-removal-undo-note");
    expect(note.textContent).toContain("You took about");
    expect(note.textContent).toContain("until you send the next one");
    await user.click(within(note).getByRole("button", { name: "Undo" }));
    expect(store.getState().session.history[1].removedByUser).toBeUndefined();
    expect(store.getState().session.contextRemovalUndo).toBeUndefined();
  });

  it("opens on what is removed now, so a removal can be put back later", async () => {
    const { user, store } = await setup();
    await openDialog(user);
    await user.click(
      screen.getByRole("checkbox", { name: /Read src\/f7\.ts/ }),
    );
    await user.click(screen.getByTestId("keep-apply"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // A request was sent: Undo is gone, the removal stays
    act(() => {
      store.dispatch(clearContextRemovalUndo());
    });
    await openDialog(user);
    const box = screen.getByRole("checkbox", { name: /Read src\/f7\.ts/ });
    expect(box).not.toBeChecked();
    expect(box.closest("label")!.textContent).toContain("(removed now)");
    await user.click(box);
    await user.click(screen.getByTestId("keep-apply"));
    expect(store.getState().session.history[1].removedByUser).toBeUndefined();
  });

  it("removes old turns from the start only, never the latest", async () => {
    const { user } = await setup();
    const dialog = await openDialog(user);
    const turns = within(dialog).getByTestId("keep-group-turns");
    expect(
      within(turns)
        .getAllByRole("checkbox")
        .map((b) => b.getAttribute("id")),
    ).toEqual(["keep-group-turns", "keep-turn:u1"]);
    await user.click(screen.getByRole("checkbox", { name: /Turn 1: Read/ }));
    // The results of that turn go with it
    expect(
      screen.getByRole("checkbox", { name: /Read src\/f7\.ts/ }),
    ).toBeDisabled();
  });

  it("Cancel and Escape change nothing and give focus back to the meter", async () => {
    const { user, store } = await setup();
    await openDialog(user);
    await user.click(
      screen.getByRole("checkbox", { name: /Read src\/f7\.ts/ }),
    );
    await user.click(screen.getByTestId("keep-cancel"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(store.getState().session.history[1].removedByUser).toBeUndefined();
    expect(screen.getByTestId("context-meter")).toHaveFocus();

    await openDialog(user);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("context-meter")).toHaveFocus();
  });

  it("keeps the keyboard inside while open, and Space ticks a box", async () => {
    const { user } = await setup();
    const dialog = await openDialog(user);
    await waitFor(() =>
      expect(dialog.contains(document.activeElement)).toBe(true),
    );
    for (let i = 0; i < 16; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    for (let i = 0; i < 4; i++) {
      await user.tab({ shift: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    const box = screen.getByRole("checkbox", { name: /Read src\/f7\.ts/ });
    box.focus();
    await user.keyboard(" ");
    expect(box).not.toBeChecked();
  });
});
