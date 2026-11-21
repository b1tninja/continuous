import { afterEach, describe, expect, it, vi } from "vitest";

const { chat } = vi.hoisted(() => ({
  chat: {} as Record<string, unknown>,
}));

vi.mock("vscode", () => {
  class Disposable {
    dispose() {}
  }
  class EventEmitter {
    event = () => new Disposable();
    fire() {}
    dispose() {}
  }
  return {
    chat,
    EventEmitter,
    lm: {
      registerLanguageModelChatProvider: () => new Disposable(),
      registerMcpServerDefinitionProvider: () => new Disposable(),
    },
    workspace: {
      getConfiguration: () => ({
        get: (_key: string, fallback: unknown) => fallback,
      }),
      onDidChangeConfiguration: () => new Disposable(),
    },
  };
});

import { registerVsCodeAi } from "./registerVsCodeAi";

const context = {
  subscriptions: [] as unknown[],
  globalState: { get: () => undefined, update: async () => {} },
} as any;
const configHandler = {
  loadConfig: async () => ({ config: undefined }),
  onConfigUpdate: () => {},
  reloadConfig: async () => {},
} as any;

// The message VS Code throws for a proposed API the manifest does not
// declare, from the log in #981
const NOT_ENABLED = [
  "Extension 'b1tninja.continuous' CANNOT use API proposal: chatSessionsProvider.",
  "Its package.json#enabledApiProposals-property declares: [] but NOT chatSessionsProvider.",
  "The missing proposal MUST be added and you must start in extension development mode or use the following command line switch: --enable-proposed-api b1tninja.continuous",
].join("\n");

describe("registerVsCodeAi and the agent sessions API", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of Object.keys(chat)) {
      delete chat[key];
    }
  });

  it("goes on without agent sessions when the proposed API throws", () => {
    chat.createChatSessionItemController = () => {
      throw new Error(NOT_ENABLED);
    };
    chat.registerChatSessionContentProvider = () => ({ dispose() {} });
    chat.createChatParticipant = () => ({ dispose() {} });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const registered = registerVsCodeAi(context, configHandler);

    expect(registered.agentSessions).toBe(false);
    expect(registered.models).toBeDefined();
    expect(registered.mcp).toBeDefined();
    // One warning, on one line, that says which extension it is from
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual([
      "Continuous: the Agents window integration is unavailable: Extension 'b1tninja.continuous' CANNOT use API proposal: chatSessionsProvider.",
    ]);
  });

  it("says nothing when the API is not there at all", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(registerVsCodeAi(context, configHandler).agentSessions).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
