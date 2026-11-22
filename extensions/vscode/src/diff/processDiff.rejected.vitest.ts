import { describe, expect, it, vi } from "vitest";

/**
 * A rejected diff must reach the chat as rejected. The closed apply state
 * used to look the same for accept and reject, so a diff rejected from the
 * editor was reported to the model as "Successfully edited".
 */
vi.mock("vscode", () => ({
  Uri: { parse: (s: string) => ({ toString: () => s, fsPath: s }) },
  window: { showTextDocument: vi.fn(), showErrorMessage: vi.fn() },
  workspace: { textDocuments: [] as unknown[] },
  commands: { executeCommand: vi.fn() },
}));
vi.mock("node-machine-id", () => ({ machineIdSync: () => "id" }));
vi.mock("core/data/log", () => ({ DataLogger: { getInstance: () => ({}) } }));
vi.mock("../extension/EditOutcomeTracker", () => ({
  editOutcomeTracker: { recordEditOutcome: vi.fn(async () => undefined) },
}));
vi.mock("../ContinueGUIWebviewViewProvider", () => ({}));
vi.mock("../VsCodeIde", () => ({}));

import { processDiff } from "./processDiff";

function fakes() {
  const ide = {
    getCurrentFile: vi.fn(),
    openFile: vi.fn(async () => undefined),
    saveFile: vi.fn(async () => undefined),
    readFile: vi.fn(async () => "content"),
  };
  const sidebar = {
    webviewProtocol: { request: vi.fn(async () => undefined) },
  };
  const core = { invoke: vi.fn() };
  const manager = {
    getStreamIdForFile: vi.fn(() => "stream-1"),
    clearForfileUri: vi.fn(),
    finishDiff: vi.fn(async () => undefined),
  };
  return { ide, sidebar, core, manager };
}

const run = (action: "accept" | "reject", f: ReturnType<typeof fakes>) =>
  processDiff(
    action,
    f.sidebar as any,
    f.ide as any,
    f.core as any,
    f.manager as any,
    "file:///w/a.ts",
    "stream-1",
    "call-1",
  );

describe("processDiff says when the person rejected the diff", () => {
  it("a reject clears the diff as rejected by the person and closes it as rejected", async () => {
    const f = fakes();
    await run("reject", f);
    expect(f.manager.clearForfileUri).toHaveBeenCalledWith(
      "file:///w/a.ts",
      false,
      true,
    );
    expect(f.sidebar.webviewProtocol.request).toHaveBeenCalledWith(
      "updateApplyState",
      expect.objectContaining({ status: "closed", rejected: true }),
    );
  });

  it("an accept does neither", async () => {
    const f = fakes();
    await run("accept", f);
    expect(f.manager.clearForfileUri).toHaveBeenCalledWith(
      "file:///w/a.ts",
      true,
      false,
    );
    const closed = (f.sidebar.webviewProtocol.request as any).mock.calls.find(
      (c: any[]) => c[0] === "updateApplyState",
    )[1];
    expect(closed.status).toBe("closed");
    expect(closed.rejected).toBeUndefined();
  });
});
