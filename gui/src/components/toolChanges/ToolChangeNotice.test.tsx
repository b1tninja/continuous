import type { Tool } from "core";
import type { JSX } from "react";
import { describe, expect, it } from "vitest";
import {
  act,
  requestedAgo,
  screen,
  setPromptCacheState,
  setupNotice,
} from "../mainInput/noticeTestUtils";
import { PendingToolChangesNotice } from "../mainInput/PendingToolChangesNotice";
import { updateConfig } from "../../redux/slices/configSlice";
import { setSentToolList } from "../../redux/slices/sessionSlice";
import {
  setApplyToolChangesAtOnce,
  setToolPolicy,
} from "../../redux/slices/uiSlice";
import { heldToolList, toolListKey } from "../../util/toolListHold";
import { ToolChangeNotice } from "./ToolChangeNotice";

const mcpTool = (name: string): Tool => ({
  type: "function",
  displayTitle: name,
  readonly: false,
  group: "srv",
  function: { name, description: name, parameters: { type: "object" } },
});

/** Two MCP tools, a warm cache of `tokens`, and a request that offered both. */
async function setup(component: JSX.Element, tokens = 366_000) {
  const view = await setupNotice(component, "5m", "agent");
  const { store } = view;
  await act(async () => {
    store.dispatch(
      updateConfig({
        ...store.getState().config.config,
        tools: [mcpTool("srv_a"), mcpTool("srv_b")],
      }),
    );
    for (const toolName of ["srv_a", "srv_b"]) {
      store.dispatch(
        setToolPolicy({ toolName, policy: "allowedWithPermission" }),
      );
    }
    store.dispatch(
      setPromptCacheState(requestedAgo(1, { lastInputTokens: tokens })),
    );
    const state = store.getState();
    store.dispatch(
      setSentToolList({
        key: toolListKey(state),
        tools: heldToolList(state).tools,
      }),
    );
  });
  return view;
}

type Store = Awaited<ReturnType<typeof setup>>["store"];

const turnOffB = (store: Store) =>
  act(async () => {
    store.dispatch(setToolPolicy({ toolName: "srv_b", policy: "disabled" }));
  });

describe("ToolChangeNotice at the tool controls", () => {
  it("warns with the cost while the cache is warm and the re-read is significant", async () => {
    await setup(<ToolChangeNotice />);
    const notice = screen.getByTestId("tool-change-notice");
    expect(notice.textContent).toContain(
      "Prompt cache is warm: changing the tool list re-reads about 366k tokens at full price",
    );
    expect(notice.textContent).toContain("on the next request");
    expect(screen.queryByTestId("tool-change-choice")).toBeNull();
  });

  it("shows nothing for a small conversation, or with the wait turned off", async () => {
    const { store } = await setup(<ToolChangeNotice />, 5_000);
    expect(screen.queryByTestId("tool-change-notice")).toBeNull();
    await act(async () => {
      store.dispatch(setPromptCacheState(requestedAgo(1)));
      store.dispatch(setApplyToolChangesAtOnce(true));
    });
    expect(screen.queryByTestId("tool-change-notice")).toBeNull();
  });

  it("offers the choice once a change waits, with waiting as the default", async () => {
    const { store, user } = await setup(<ToolChangeNotice />);
    await turnOffB(store);
    const choice = screen.getByTestId("tool-change-choice");
    expect(choice.textContent).toContain(
      "1 tool change waiting for the cache to cool",
    );
    expect(choice.textContent).toContain("-srv_b");
    expect(
      screen.getByTestId("tool-change-when-cold").getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByTestId("tool-change-new-session")).toBeTruthy();

    await user.click(screen.getByTestId("tool-change-when-cold"));
    expect(screen.queryByTestId("tool-change-apply-now")).toBeNull();
    // The change still waits
    expect(heldToolList(store.getState()).held).toBe(true);
  });

  it("Apply now lets the next request take the new list", async () => {
    const { store, user } = await setup(<ToolChangeNotice />);
    await turnOffB(store);
    await user.click(screen.getByTestId("tool-change-apply-now"));
    expect(store.getState().session.applyToolChangesNext).toBe(true);
    const next = heldToolList(store.getState());
    expect(next.held).toBe(false);
    expect(next.tools.map((t) => t.function.name)).toEqual(["srv_a"]);
  });

  it("Start a new session with it starts a session with the new list", async () => {
    const { store, user } = await setup(<ToolChangeNotice />);
    await turnOffB(store);
    await user.click(screen.getByTestId("tool-change-new-session"));
    await act(async () => {});
    expect(store.getState().session.sentToolList).toBeUndefined();
  });

  it("says that a change drops earlier reasoning on a preserved-thinking model", async () => {
    const { store } = await setup(<ToolChangeNotice />);
    await act(async () => {
      const config = store.getState().config.config;
      const m = {
        ...config.selectedModelByRole.chat!,
        model: "claude-opus-5-5",
      };
      store.dispatch(
        updateConfig({
          ...config,
          selectedModelByRole: { ...config.selectedModelByRole, chat: m },
          modelsByRole: { ...config.modelsByRole, chat: [m] },
        }),
      );
    });
    expect(screen.getByTestId("tool-change-notice").textContent).toContain(
      "rebuilds the cache and drops earlier reasoning",
    );
  });
});

describe("PendingToolChangesNotice above the input", () => {
  it("appears while a change waits and goes after Apply now", async () => {
    const { store, user } = await setup(<PendingToolChangesNotice />);
    expect(screen.queryByTestId("pending-tool-changes")).toBeNull();
    await turnOffB(store);
    expect(screen.getByTestId("pending-tool-changes").textContent).toContain(
      "1 tool change waiting for the cache to cool",
    );
    await user.click(screen.getByTestId("pending-tool-changes-apply"));
    expect(screen.queryByTestId("pending-tool-changes")).toBeNull();
  });

  it("goes by itself once the cache is cold", async () => {
    const { store } = await setup(<PendingToolChangesNotice />);
    await turnOffB(store);
    await act(async () => {
      store.dispatch(setPromptCacheState(requestedAgo(10)));
    });
    expect(screen.queryByTestId("pending-tool-changes")).toBeNull();
  });
});
