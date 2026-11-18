import type { ModelDescription, Tool } from "core";
import { readFileTool } from "core/tools/definitions/readFile";
import { describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../context/MockIdeMessenger";
import { EMPTY_CONFIG, updateConfig } from "../redux/slices/configSlice";
import {
  applyToolChangesNow,
  newSession,
  setMode,
  setPromptCacheState,
  setSentToolList,
} from "../redux/slices/sessionSlice";
import {
  setApplyToolChangesAtOnce,
  setPromptCacheSetting,
  setToolPolicy,
} from "../redux/slices/uiSlice";
import { setupStore } from "../redux/store";
import { buildChatRequest } from "../redux/util/buildChatRequest";
import { heldToolList, withheldTools } from "./toolListHold";

const claude: ModelDescription = {
  title: "Claude Sonnet",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  underlyingProviderName: "anthropic",
};

const mcpTool = (name: string, description = `${name} tool`): Tool => ({
  type: "function",
  displayTitle: name,
  readonly: false,
  group: "srv",
  function: {
    name,
    description,
    parameters: { type: "object", properties: {} },
  },
});

const T0 = Date.parse("2026-11-14T10:00:00Z");
const SECOND = 1000;

/**
 * A store in Agent mode with two MCP tools and readFile, a warm 5-minute
 * cache that last read `tokens` tokens at T0, and one request already sent.
 */
function setup(tokens = 366_000) {
  const store = setupStore({ ideMessenger: new MockIdeMessenger() });
  store.dispatch(
    updateConfig({
      ...EMPTY_CONFIG,
      tools: [readFileTool, mcpTool("srv_a"), mcpTool("srv_b")],
      selectedModelByRole: {
        ...EMPTY_CONFIG.selectedModelByRole,
        chat: claude,
      },
      modelsByRole: { ...EMPTY_CONFIG.modelsByRole, chat: [claude] },
    } as any),
  );
  store.dispatch(
    setPromptCacheSetting({ modelTitle: claude.title, setting: "5m" }),
  );
  store.dispatch(setMode("agent"));
  for (const name of ["srv_a", "srv_b", readFileTool.function.name]) {
    store.dispatch(
      setToolPolicy({ toolName: name, policy: "allowedWithPermission" }),
    );
  }
  store.dispatch(
    setPromptCacheState({
      escalated: false,
      lastRequestAt: T0,
      lastTtl: "5m",
      lastInputTokens: tokens,
    }),
  );
  // The request at T0: what it offered is what the next one starts from
  const first = buildChatRequest(store.getState(), undefined, T0);
  store.dispatch(
    setSentToolList({ key: first.toolList.key, tools: first.toolList.tools }),
  );
  return { store, first };
}

const toolBytes = (r: ReturnType<typeof buildChatRequest>) =>
  JSON.stringify(r.completionOptions.tools);
const names = (r: ReturnType<typeof buildChatRequest>) =>
  r.activeTools.map((t) => t.function.name);

describe("the tool list while the prompt cache is warm (C80, C88)", () => {
  it("sends the same tool bytes while a change waits, and the new list once the cache is cold", () => {
    const { store, first } = setup();
    expect(names(first)).toContain("srv_b");

    store.dispatch(setToolPolicy({ toolName: "srv_b", policy: "disabled" }));
    const warm = buildChatRequest(
      store.getState(),
      undefined,
      T0 + 60 * SECOND,
    );
    expect(toolBytes(warm)).toBe(toolBytes(first));
    expect(warm.toolList.held).toBe(true);
    expect(warm.toolList.pending.removed).toEqual(["srv_b"]);

    const cold = buildChatRequest(
      store.getState(),
      undefined,
      T0 + 6 * 60 * SECOND,
    );
    expect(cold.toolList.held).toBe(false);
    expect(names(cold)).not.toContain("srv_b");
    expect(toolBytes(cold)).not.toBe(toolBytes(first));
  });

  it("does not offer a tool turned on while warm until the change applies", () => {
    const { store, first } = setup();
    store.dispatch(
      updateConfig({
        ...store.getState().config.config,
        tools: [...store.getState().config.config.tools, mcpTool("srv_late")],
      }),
    );
    const warm = buildChatRequest(store.getState(), undefined, T0 + SECOND);
    expect(names(warm)).not.toContain("srv_late");
    expect(toolBytes(warm)).toBe(toolBytes(first));
    expect(warm.toolList.pending.added).toEqual(["srv_late"]);
  });

  it("holds a server that comes back with a changed description", () => {
    const { store, first } = setup();
    const tools = store
      .getState()
      .config.config.tools.map((t) =>
        t.function.name === "srv_a" ? mcpTool("srv_a", "rewritten") : t,
      );
    store.dispatch(updateConfig({ ...store.getState().config.config, tools }));
    const warm = buildChatRequest(store.getState(), undefined, T0 + SECOND);
    expect(toolBytes(warm)).toBe(toolBytes(first));
    expect(warm.toolList.pending.changed).toEqual(["srv_a"]);
  });

  it("applies at the next request after Apply now, and the request settles it", () => {
    const { store } = setup();
    store.dispatch(setToolPolicy({ toolName: "srv_b", policy: "disabled" }));
    store.dispatch(applyToolChangesNow());
    const next = buildChatRequest(store.getState(), undefined, T0 + SECOND);
    expect(names(next)).not.toContain("srv_b");
    store.dispatch(
      setSentToolList({ key: next.toolList.key, tools: next.toolList.tools }),
    );
    expect(store.getState().session.applyToolChangesNext).toBeUndefined();
  });

  it("applies in a new session (and after compaction, which reloads the session)", () => {
    const { store } = setup();
    store.dispatch(setToolPolicy({ toolName: "srv_b", policy: "disabled" }));
    store.dispatch(newSession());
    expect(store.getState().session.sentToolList).toBeUndefined();
    const next = buildChatRequest(store.getState(), undefined, T0 + SECOND);
    expect(names(next)).not.toContain("srv_b");
  });

  it("applies at once when the re-read is small", () => {
    const { store } = setup(5_000);
    store.dispatch(setToolPolicy({ toolName: "srv_b", policy: "disabled" }));
    const next = buildChatRequest(store.getState(), undefined, T0 + SECOND);
    expect(next.toolList.held).toBe(false);
    expect(names(next)).not.toContain("srv_b");
  });

  it("applies at once with the wait turned off", () => {
    const { store } = setup();
    store.dispatch(setApplyToolChangesAtOnce(true));
    store.dispatch(setToolPolicy({ toolName: "srv_b", policy: "disabled" }));
    const next = buildChatRequest(store.getState(), undefined, T0 + SECOND);
    expect(names(next)).not.toContain("srv_b");
  });

  it("applies with a mode switch, which rebuilds the list anyway", () => {
    const { store } = setup();
    store.dispatch(setToolPolicy({ toolName: "srv_b", policy: "disabled" }));
    store.dispatch(setMode("plan"));
    const next = buildChatRequest(store.getState(), undefined, T0 + SECOND);
    expect(next.toolList.held).toBe(false);
  });

  it("names a withheld tool as turned off, or as gone with its server", () => {
    const { store } = setup();
    store.dispatch(setToolPolicy({ toolName: "srv_b", policy: "disabled" }));
    store.dispatch(
      updateConfig({
        ...store.getState().config.config,
        tools: store
          .getState()
          .config.config.tools.filter((t) => t.function.name !== "srv_a"),
      }),
    );
    const status = heldToolList(store.getState(), T0 + SECOND);
    expect(withheldTools(status, store.getState().config.config.tools)).toEqual(
      expect.arrayContaining([
        { name: "srv_a", gone: true },
        { name: "srv_b", gone: false },
      ]),
    );
  });

  it("reports the loss that makes a change wait", () => {
    const { store } = setup();
    const status = heldToolList(store.getState(), T0 + SECOND);
    expect(status.waits).toBe(true);
    expect(status.loss?.tokens).toBe(366_000);
    expect(heldToolList(store.getState(), T0 + 6 * 60 * SECOND).waits).toBe(
      false,
    );
  });
});

describe("preserved thinking when a tool change applies (PR #893)", () => {
  const withModel = (model: string) => {
    const { store } = setup();
    const m = { ...claude, model, title: `T ${model}` };
    store.dispatch(
      updateConfig({
        ...store.getState().config.config,
        selectedModelByRole: {
          ...store.getState().config.config.selectedModelByRole,
          chat: m,
        },
        modelsByRole: {
          ...store.getState().config.config.modelsByRole,
          chat: [m],
        },
      }),
    );
    store.dispatch(
      setPromptCacheSetting({ modelTitle: m.title, setting: "5m" }),
    );
    // One earlier turn with signed reasoning, then the person's new message
    store.dispatch(
      newSession({
        sessionId: "s",
        title: "t",
        workspaceDirectory: "",
        history: [
          { message: { role: "user", content: "first" }, contextItems: [] },
          {
            message: {
              role: "thinking",
              content: "earlier reasoning",
              signature: "sig",
            },
            contextItems: [],
          },
          {
            message: { role: "assistant", content: "answer" },
            contextItems: [],
          },
          { message: { role: "user", content: "second" }, contextItems: [] },
        ],
      } as any),
    );
    store.dispatch(
      setPromptCacheState({
        escalated: false,
        lastRequestAt: T0,
        lastTtl: "5m",
        lastInputTokens: 366_000,
      }),
    );
    const before = buildChatRequest(store.getState(), undefined, T0);
    store.dispatch(
      setSentToolList({
        key: before.toolList.key,
        tools: before.toolList.tools,
        thinkingCut: before.thinkingCut,
      }),
    );
    return { store, before };
  };
  const hasThinking = (r: ReturnType<typeof buildChatRequest>) =>
    r.messages.some((m) => m.role === "thinking");

  for (const model of ["claude-fable-5-2", "claude-opus-5-5"]) {
    it(`drops the earlier thinking blocks after Apply now on ${model}`, () => {
      const { store, before } = withModel(model);
      expect(hasThinking(before)).toBe(true);
      store.dispatch(setToolPolicy({ toolName: "srv_b", policy: "disabled" }));
      store.dispatch(applyToolChangesNow());
      const applied = buildChatRequest(
        store.getState(),
        undefined,
        T0 + SECOND,
      );
      expect(applied.thinkingCut).toBe(4);
      expect(hasThinking(applied)).toBe(false);
      // and on the next request too, once the cut is recorded
      store.dispatch(
        setSentToolList({
          key: applied.toolList.key,
          tools: applied.toolList.tools,
          thinkingCut: applied.thinkingCut,
        }),
      );
      const later = buildChatRequest(
        store.getState(),
        undefined,
        T0 + 2 * SECOND,
      );
      expect(hasThinking(later)).toBe(false);
    });

    it(`drops them too when a queued change applies on a cold cache (${model})`, () => {
      const { store } = withModel(model);
      store.dispatch(setToolPolicy({ toolName: "srv_b", policy: "disabled" }));
      const queued = buildChatRequest(store.getState(), undefined, T0 + SECOND);
      expect(hasThinking(queued)).toBe(true);
      const cold = buildChatRequest(
        store.getState(),
        undefined,
        T0 + 6 * 60 * SECOND,
      );
      expect(hasThinking(cold)).toBe(false);
    });
  }

  it("keeps the reasoning on a model without the prefix check", () => {
    const { store } = withModel("claude-sonnet-4-6");
    store.dispatch(setToolPolicy({ toolName: "srv_b", policy: "disabled" }));
    store.dispatch(applyToolChangesNow());
    const applied = buildChatRequest(store.getState(), undefined, T0 + SECOND);
    expect(applied.thinkingCut).toBeUndefined();
    expect(hasThinking(applied)).toBe(true);
  });
});
