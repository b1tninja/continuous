import {
  agentFilesWithheld,
  recordInstructionFilesState,
  resetInstructionFilesSession,
} from "core/config/markdown/instructionFiles";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  gateAgentFilesOnWorkspaceTrust,
  instructionFilesState,
} from "./workspaceConfigTrust";

const vscodeState = vi.hoisted(() => ({
  isTrusted: false,
  grant: undefined as undefined | (() => void),
}));

vi.mock("vscode", () => ({
  workspace: {
    get isTrusted() {
      return vscodeState.isTrusted;
    },
    onDidGrantWorkspaceTrust: (fn: () => void) => {
      vscodeState.grant = fn;
      return { dispose() {} };
    },
  },
  window: {},
}));

afterEach(() => {
  resetInstructionFilesSession();
  vscodeState.isTrusted = false;
});

describe("AGENTS.md in Restricted Mode (X20)", () => {
  it("withholds agent files while the workspace is untrusted, and reloads on trust", () => {
    const reload = vi.fn();
    const context = { subscriptions: [] as unknown[] };
    gateAgentFilesOnWorkspaceTrust(context as never, reload);
    expect(agentFilesWithheld()).toBe(true);
    vscodeState.isTrusted = true;
    expect(agentFilesWithheld()).toBe(false);
    vscodeState.grant?.();
    expect(reload).toHaveBeenCalledOnce();
    expect(context.subscriptions).toHaveLength(1);
  });

  it("Load reads them for this session, stores nothing and reloads once", async () => {
    gateAgentFilesOnWorkspaceTrust({ subscriptions: [] } as never, () => {});
    recordInstructionFilesState({
      withheld: ["file:///ws/AGENTS.md"],
      notices: [],
    });
    const reloadConfig = vi.fn(async () => {
      recordInstructionFilesState({ withheld: [], notices: [] });
    });

    expect(await instructionFilesState(undefined, { reloadConfig })).toEqual({
      withheld: ["file:///ws/AGENTS.md"],
      notices: [],
    });
    expect(reloadConfig).not.toHaveBeenCalled();

    expect(await instructionFilesState(true, { reloadConfig })).toEqual({
      withheld: [],
      notices: [],
    });
    expect(reloadConfig).toHaveBeenCalledOnce();
    expect(agentFilesWithheld()).toBe(false);
  });
});
