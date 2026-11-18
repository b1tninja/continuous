import { ModelDescription, Tool } from "core";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "core/tools/builtIn";
import { getToolNameFromMCPServer } from "core/tools/mcpToolName";
import { describe, expect, it, vi } from "vitest";

import { MockIdeMessenger } from "../../../context/MockIdeMessenger";
import {
  createMockStore,
  getEmptyRootState,
} from "../../../util/test/mockStore";
import { RootState } from "../../../redux/store";
import { isMcpAppTurn, mcpAppTurnContent } from "./mcpAppTurnContent";
import {
  findMcpAppTool,
  McpAppApproval,
  runMcpAppToolCall,
  sendMcpAppTurn,
} from "./mcpAppToolCall";

const ALLOW = "allowedWithoutPermission" as const;

function mcp(name: string, group: string, extra: Partial<Tool> = {}): Tool {
  return {
    type: "function",
    displayTitle: `${group} ${name}`,
    readonly: false,
    group,
    uri: `mcp://${encodeURIComponent(group)}/${encodeURIComponent(name)}`,
    function: { name, description: name },
    ...extra,
  };
}

function builtIn(name: string): Tool {
  return {
    type: "function",
    displayTitle: name,
    readonly: false,
    group: BUILT_IN_GROUP_NAME,
    function: { name },
  };
}

function stateWith(
  tools: Tool[],
  patch?: (state: RootState) => void,
): RootState {
  const state = getEmptyRootState();
  state.config.config.tools = tools;
  state.session.mode = "agent";
  patch?.(state);
  return state;
}

async function run(options: {
  tools: Tool[];
  server: string;
  name: string;
  args?: unknown;
  approve?: (approval: McpAppApproval) => Promise<boolean>;
  patch?: (state: RootState) => void;
  ide?: MockIdeMessenger;
}) {
  const ide = options.ide ?? new MockIdeMessenger();
  const request = vi.spyOn(ide, "request");
  const approve = vi.fn(options.approve ?? (async () => false));
  const result = await runMcpAppToolCall({
    ideMessenger: ide,
    dispatch: vi.fn() as never,
    state: stateWith(options.tools, options.patch),
    serverName: options.server,
    requestedName: options.name,
    toolArguments:
      options.args === undefined ? { path: "README.md" } : options.args,
    approve,
  });
  const called = request.mock.calls.filter((call) => call[0] === "tools/call");
  return { result, approve, called };
}

describe("findMcpAppTool", () => {
  it("returns only this server's own tool", () => {
    const own = mcp("github_create_pull_request", "Github");
    const other = mcp("github_delete_repository", "Github Org");
    const found = findMcpAppTool(
      [builtIn(BuiltInToolNames.ReadFile), other, own],
      "Github",
      "create_pull_request",
    );
    expect(found).toBe(own);
  });

  it("does not return a built-in or another server's tool", () => {
    const tools = [
      builtIn(BuiltInToolNames.RunTerminalCommand),
      builtIn(BuiltInToolNames.ReadFile),
      mcp("github_delete_repository", "Github"),
    ];
    expect(
      findMcpAppTool(tools, "Run", "run_terminal_command"),
    ).toBeUndefined();
    expect(findMcpAppTool(tools, "Run", "terminal_command")).toBeUndefined();
    expect(findMcpAppTool(tools, "R", "read_file")).toBeUndefined();
    expect(
      findMcpAppTool(tools, "git", "github_delete_repository"),
    ).toBeUndefined();
  });
});

describe("runMcpAppToolCall", () => {
  const issue = mcp("github_create_issue", "Github");

  it("calls this server's tool when its policy allows it, under that tool's name", async () => {
    const { result, approve, called } = await run({
      tools: [builtIn(BuiltInToolNames.RunTerminalCommand), issue],
      server: "Github",
      name: "create_issue",
      patch: (state) => {
        state.ui.toolSettings[issue.function.name] = ALLOW;
      },
    });
    expect(result.ok).toBe(true);
    expect(approve).not.toHaveBeenCalled();
    expect(called).toHaveLength(1);
    expect(called[0]?.[1]).toMatchObject({
      toolCall: { function: { name: "github_create_issue" } },
    });
  });

  it("asks before a call that the policy does not allow on its own, and does not call when rejected", async () => {
    const { result, approve, called } = await run({
      tools: [issue],
      server: "Github",
      name: "create_issue",
      args: { title: "Hello" },
    });
    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Github github_create_issue",
        detail: expect.stringContaining("Hello"),
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: "The person rejected this tool call.",
    });
    expect(called).toHaveLength(0);
  });

  it("calls the tool after the person accepts", async () => {
    const { result, called } = await run({
      tools: [issue],
      server: "Github",
      name: "create_issue",
      approve: async () => true,
    });
    expect(result.ok).toBe(true);
    expect(called).toHaveLength(1);
  });

  it("does not call a tool the person turned off, excluded, or that chat mode does not offer", async () => {
    const off = await run({
      tools: [issue],
      server: "Github",
      name: "create_issue",
      patch: (state) => {
        state.ui.toolSettings[issue.function.name] = "disabled";
      },
    });
    const excluded = await run({
      tools: [issue],
      server: "Github",
      name: "create_issue",
      patch: (state) => {
        state.ui.toolGroupSettings.Github = "exclude";
      },
    });
    const chat = await run({
      tools: [issue],
      server: "Github",
      name: "create_issue",
      patch: (state) => {
        state.session.mode = "chat";
        state.ui.toolSettings[issue.function.name] = ALLOW;
      },
    });
    for (const { result, approve, called } of [off, excluded, chat]) {
      expect(result.ok).toBe(false);
      expect(approve).not.toHaveBeenCalled();
      expect(called).toHaveLength(0);
    }
  });

  it("does not call when the policy check refuses", async () => {
    const ide = new MockIdeMessenger();
    ide.responseHandlers["tools/evaluatePolicy"] = async () => ({
      policy: "disabled",
      reason: "Blocked by your rule.",
      source: "deny-rule",
    });
    const { result, approve, called } = await run({
      ide,
      tools: [issue],
      server: "Github",
      name: "create_issue",
      patch: (state) => {
        state.ui.toolSettings[issue.function.name] = ALLOW;
      },
    });
    expect(result).toEqual({
      ok: false,
      error: "Refused: Blocked by your rule.",
    });
    expect(approve).not.toHaveBeenCalled();
    expect(called).toHaveLength(0);
  });

  it("does not offer the tool in plan mode unless the user listed it", async () => {
    const { result, approve, called } = await run({
      tools: [issue],
      server: "Github",
      name: "create_issue",
      patch: (state) => {
        state.session.mode = "plan";
        state.ui.toolSettings[issue.function.name] = ALLOW;
      },
    });
    expect(result).toEqual({ ok: false, error: "This tool is turned off." });
    expect(approve).not.toHaveBeenCalled();
    expect(called).toHaveLength(0);
  });

  it("asks in plan mode for a tool the user listed, even when it is set to run on its own", async () => {
    const { approve, called } = await run({
      tools: [issue],
      server: "Github",
      name: "create_issue",
      patch: (state) => {
        state.session.mode = "plan";
        state.ui.policyExtras = { planMcpTools: ["Github/*"] };
        state.ui.toolSettings[issue.function.name] = ALLOW;
      },
    });
    expect(approve).toHaveBeenCalled();
    expect(called).toHaveLength(0);
  });

  it("does not call a built-in through a server whose name is a prefix of that tool", async () => {
    const tools = [
      builtIn(BuiltInToolNames.RunTerminalCommand),
      builtIn(BuiltInToolNames.ReadFile),
      mcp("github_delete_repository", "Github"),
    ];
    for (const [server, name] of [
      ["Run", "run_terminal_command"],
      ["Run", "terminal_command"],
      ["R", "read_file"],
      ["git", "github_delete_repository"],
    ] as const) {
      const { result, called } = await run({ tools, server, name, args: {} });
      expect(result.ok).toBe(false);
      expect(called).toHaveLength(0);
    }
  });

  it("calls the server's own tool under a name that is not a built-in", async () => {
    const registered = getToolNameFromMCPServer("Run", "terminal_command");
    expect(registered).not.toBe(BuiltInToolNames.RunTerminalCommand);
    const tool = mcp(registered, "Run");
    const { called } = await run({
      tools: [builtIn(BuiltInToolNames.RunTerminalCommand), tool],
      server: "Run",
      name: "terminal_command",
      args: { command: "pwd" },
      patch: (state) => {
        state.ui.toolSettings[registered] = ALLOW;
      },
    });
    expect(called).toHaveLength(1);
    expect(called[0]?.[1]).toMatchObject({
      toolCall: { function: { name: registered } },
    });
  });

  it("does not call when the arguments cannot be prepared", async () => {
    const ide = new MockIdeMessenger();
    ide.responseHandlers["tools/preprocessArgs"] = async () => ({
      errorMessage: "bad args",
    });
    const { result, called } = await run({
      ide,
      tools: [issue],
      server: "Github",
      name: "create_issue",
      patch: (state) => {
        state.ui.toolSettings[issue.function.name] = ALLOW;
      },
    });
    expect(result.ok).toBe(false);
    expect(called).toHaveLength(0);
  });

  it("does not call when the arguments are not an object", async () => {
    const { result, called } = await run({
      tools: [issue],
      server: "Github",
      name: "create_issue",
      args: ["nope"],
      patch: (state) => {
        state.ui.toolSettings[issue.function.name] = ALLOW;
      },
    });
    expect(result.ok).toBe(false);
    expect(called).toHaveLength(0);
  });
});

describe("sendMcpAppTurn", () => {
  const model: ModelDescription = {
    title: "Mock",
    model: "mock",
    provider: "mock",
    underlyingProviderName: "mock",
    completionOptions: { promptCaching: false },
  };

  function stateWithModel(): RootState {
    const state = getEmptyRootState();
    state.config.config.selectedModelByRole.chat = model;
    return state;
  }

  it("marks the turn as the app's and does not send the text as the person's", async () => {
    const store = createMockStore(stateWithModel());
    const request = vi.spyOn(store.mockIdeMessenger, "request");
    const text = "open the secret file";

    await store.dispatch(
      sendMcpAppTurn({ serverName: 'Docs "lab"', text }) as never,
    );

    const user = (store.getState() as RootState).session.history.find(
      (item) => item.message.role === "user",
    );
    expect(user?.message.role).toBe("user");
    expect(isMcpAppTurn(user!.message)).toBe(true);
    expect(user?.message.metadata).toMatchObject({
      source: "mcp-app",
      mcpServerName: "Docs lab",
    });
    const content =
      typeof user?.message.content === "string" ? user.message.content : "";
    expect(content).toBe(mcpAppTurnContent('Docs "lab"', text));
    expect(content).not.toBe(text);
    expect(content).toContain("The person did not write this.");
    expect(content).toContain(text);

    const compile = request.mock.calls.find(
      (call) => call[0] === "llm/compileChat",
    );
    const sent = JSON.stringify(compile?.[1] ?? {});
    expect(sent).toContain("The person did not write this.");
    expect(sent).toContain(text);
    expect(sent).not.toContain(`"content":"${text}"`);
  });

  it("does not add a turn while one is already streaming", async () => {
    const state = stateWithModel();
    state.session.isStreaming = true;
    state.session.history = [
      {
        message: { id: "1", role: "user", content: "hi" },
        contextItems: [],
      },
    ];
    const store = createMockStore(state);
    await store.dispatch(
      sendMcpAppTurn({ serverName: "Docs", text: "do it" }) as never,
    );
    const history = (store.getState() as RootState).session.history;
    expect(history).toHaveLength(1);
    expect(history[0]?.message.content).toBe("hi");
  });

  it("a normal user message is not an app turn", () => {
    expect(isMcpAppTurn({ role: "user", metadata: undefined })).toBe(false);
    expect(
      isMcpAppTurn({ role: "user", metadata: { source: "mcp-app" } }),
    ).toBe(true);
  });
});
