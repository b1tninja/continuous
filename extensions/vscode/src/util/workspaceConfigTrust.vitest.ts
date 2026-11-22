import {
  agentFilesWithheld,
  recordInstructionFilesState,
  resetInstructionFilesSession,
} from "core/config/markdown/instructionFiles";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  askForWorkspaceConfigTrust,
  gateAgentFilesOnWorkspaceTrust,
  instructionFilesState,
} from "./workspaceConfigTrust";

const vscodeState = vi.hoisted(() => ({
  isTrusted: false,
  grant: undefined as undefined | (() => void),
  commands: [] as string[],
  warnings: [] as string[],
  answer: undefined as string | undefined,
}));

const trustState = vi.hoisted(() => ({
  pending: [] as {
    projectDir: string;
    scope: string;
    fingerprint: string;
    files: string[];
  }[],
  trusted: [] as { dir: string; fingerprints: Record<string, string> }[],
}));

vi.mock("core/config/projectTrust", () => ({
  pendingProjectTrust: () => trustState.pending.slice(),
  trustProjectScopes: (dir: string, fingerprints: Record<string, string>) => {
    trustState.trusted.push({ dir, fingerprints });
  },
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
  window: {
    showWarningMessage: async (text: string) => {
      vscodeState.warnings.push(text);
      return vscodeState.answer;
    },
  },
  commands: {
    executeCommand: async (id: string) => {
      vscodeState.commands.push(id);
    },
  },
}));

afterEach(() => {
  resetInstructionFilesSession();
  vscodeState.isTrusted = false;
  vscodeState.commands = [];
  vscodeState.warnings = [];
  vscodeState.answer = undefined;
  trustState.pending = [];
  trustState.trusted = [];
});

describe("Trust this folder, from the MCP servers tab", () => {
  const pending = {
    projectDir: "/ws",
    scope: "mcp",
    fingerprint: "abc",
    files: [".continuous/mcpServers/db.yaml"],
  };

  it("opens the editor's own workspace trust page in Restricted Mode, and asks nothing else", async () => {
    trustState.pending = [pending];
    const reloadConfig = vi.fn();
    expect(await askForWorkspaceConfigTrust({ reloadConfig } as never)).toEqual(
      { shown: "workspace" },
    );
    expect(vscodeState.commands).toEqual(["workbench.trust.manage"]);
    expect(vscodeState.warnings).toEqual([]);
    expect(trustState.trusted).toEqual([]);
  });

  it("says so when nothing waits to be trusted", async () => {
    vscodeState.isTrusted = true;
    expect(
      await askForWorkspaceConfigTrust({ reloadConfig: vi.fn() } as never),
    ).toEqual({ shown: "none" });
    expect(vscodeState.warnings).toEqual([]);
  });

  it("shows the question again after a 'not now', and records trust only on the person's yes", async () => {
    vscodeState.isTrusted = true;
    trustState.pending = [pending];
    const reloadConfig = vi.fn(async () => {});
    // Dismissed once
    await askForWorkspaceConfigTrust({ reloadConfig } as never);
    expect(vscodeState.warnings).toHaveLength(1);
    expect(vscodeState.warnings[0]).toContain(".continuous/mcpServers/db.yaml");
    expect(trustState.trusted).toEqual([]);
    expect(reloadConfig).not.toHaveBeenCalled();
    // Asked again from the button: the same question, and now a yes
    vscodeState.answer = "Trust this folder";
    expect(await askForWorkspaceConfigTrust({ reloadConfig } as never)).toEqual(
      { shown: "config" },
    );
    expect(vscodeState.warnings).toHaveLength(2);
    expect(trustState.trusted).toEqual([
      { dir: "/ws", fingerprints: { mcp: "abc" } },
    ]);
    expect(reloadConfig).toHaveBeenCalledOnce();
  });
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
