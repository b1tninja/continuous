import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the agent does on its own must never take the keyboard: a file it
 * created, an edit it applied, a diff that closes by itself. A person who is
 * typing into another editor or the chat box would otherwise find their
 * keystrokes going into the file the agent just touched.
 */
const shown = vi.hoisted(() => ({
  calls: [] as Array<{ doc: any; options: any }>,
  commands: [] as string[],
  /** The editor VS Code calls active; set by the last editor shown unless held */
  active: undefined as any,
  /** A test that wants another editor to stay active sets this */
  keepActive: false,
}));

vi.mock("vscode", () => ({
  Uri: { parse: (s: string) => ({ toString: () => s, fsPath: s }) },
  ViewColumn: { One: 1 },
  window: {
    tabGroups: { all: [] },
    showTextDocument: vi.fn(async (doc: unknown, options: unknown) => {
      shown.calls.push({ doc, options });
      const editor = { revealRange: vi.fn(), document: doc };
      if (!shown.keepActive) (shown as any).active = editor;
      return editor;
    }),
    get activeTextEditor() {
      return (shown as any).active;
    },
    showErrorMessage: vi.fn(),
  },
  workspace: {
    openTextDocument: vi.fn(async (uri: unknown) => ({ uri })),
    textDocuments: [] as unknown[],
  },
  commands: {
    executeCommand: vi.fn(async (name: string) => {
      shown.commands.push(name);
    }),
  },
}));
vi.mock("node-machine-id", () => ({ machineIdSync: () => "id" }));
vi.mock("core/data/log", () => ({ DataLogger: { getInstance: () => ({}) } }));
vi.mock("../extension/EditOutcomeTracker", () => ({
  editOutcomeTracker: { recordEditOutcome: vi.fn(async () => undefined) },
}));
vi.mock("../ContinueGUIWebviewViewProvider", () => ({}));
vi.mock("../VsCodeIde", () => ({}));

import * as vscode from "vscode";

import {
  forgetPendingNewFile,
  trackPendingNewFile,
} from "../apply/pendingNewFile";
import { openEditorAndRevealRange } from "../util/vscode";

import { processDiff } from "./processDiff";

const uri = (p: string) => ({ toString: () => `file://${p}` }) as any;

beforeEach(() => {
  shown.calls = [];
  shown.commands = [];
  shown.active = undefined;
  shown.keepActive = false;
  (vscode.workspace as any).textDocuments = [];
});

describe("openEditorAndRevealRange and focus", () => {
  it("takes focus when asked to open a file (a click)", async () => {
    await openEditorAndRevealRange(uri("/a.ts"));
    expect(shown.calls).toHaveLength(1);
    expect(shown.calls[0].options.preserveFocus).toBeUndefined();
  });

  it("keeps the keyboard where it was when asked to preserve focus", async () => {
    await openEditorAndRevealRange(
      uri("/a.ts"),
      undefined,
      undefined,
      false,
      true,
    );
    expect(shown.calls[0].options.preserveFocus).toBe(true);
  });

  it("treats an explicit false the same as not asking", async () => {
    await openEditorAndRevealRange(
      uri("/a.ts"),
      undefined,
      undefined,
      false,
      false,
    );
    expect(shown.calls[0].options.preserveFocus).toBeUndefined();
  });

  it("still reveals the range when it keeps the focus", async () => {
    const revealed = vi.fn();
    (vscode.window.showTextDocument as any).mockResolvedValueOnce({
      revealRange: revealed,
    });
    const range = { start: { line: 3 } } as any;
    await openEditorAndRevealRange(uri("/a.ts"), range, undefined, false, true);
    expect(revealed).toHaveBeenCalledWith(range);
  });
});

function fakes(streamId?: string) {
  const ide = {
    getCurrentFile: vi.fn(),
    openFile: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    saveFile: vi.fn(async () => undefined),
    readFile: vi.fn(async () => "content"),
  };
  const sidebar = {
    webviewProtocol: { request: vi.fn(async () => undefined) },
  };
  const core = { invoke: vi.fn() };
  const manager = {
    getStreamIdForFile: vi.fn(() => streamId),
    clearForfileUri: vi.fn(),
    finishDiff: vi.fn(async () => undefined),
  };
  return { ide, sidebar, core, manager };
}

const run = (
  action: "accept" | "reject",
  f: ReturnType<typeof fakes>,
  filepath: string,
) =>
  processDiff(
    action,
    f.sidebar as any,
    f.ide as any,
    f.core as any,
    f.manager as any,
    filepath,
    "stream-1",
    "call-1",
  );

describe("processDiff never takes focus", () => {
  it("an edit to an existing file that finishes by itself keeps the focus", async () => {
    const f = fakes("stream-1");
    await run("accept", f, "file:///work/a.ts");
    expect(f.ide.openFile).toHaveBeenCalledWith("file:///work/a.ts", {
      preserveFocus: true,
    });
  });

  it("the same for a rejected edit", async () => {
    const f = fakes("stream-1");
    await run("reject", f, "file:///work/a.ts");
    expect(f.ide.openFile).toHaveBeenCalledWith("file:///work/a.ts", {
      preserveFocus: true,
    });
  });

  it("a new file that is accepted is written, shown without focus, and its draft closed", async () => {
    const f = fakes("stream-1");
    const doc = {
      uri: { toString: () => "untitled:Untitled-1" },
      getText: () => "new!",
    };
    (vscode.workspace as any).textDocuments = [doc];
    trackPendingNewFile("untitled:Untitled-1", "file:///work/new.ts");
    await run("accept", f, "file:///work/new.ts");
    expect(f.ide.writeFile).toHaveBeenCalledWith("file:///work/new.ts", "new!");
    // every editor the code shows is shown without focus
    expect(shown.calls.length).toBeGreaterThan(0);
    for (const c of shown.calls) expect(c.options.preserveFocus).toBe(true);
    expect(shown.commands).toContain(
      "workbench.action.revertAndCloseActiveEditor",
    );
    expect(f.ide.openFile).toHaveBeenCalledWith("file:///work/new.ts", {
      preserveFocus: true,
    });
    forgetPendingNewFile("file:///work/new.ts");
  });

  it("a new file that is rejected is closed without taking focus", async () => {
    const f = fakes("stream-1");
    const doc = {
      uri: { toString: () => "untitled:Untitled-2" },
      getText: () => "x",
    };
    (vscode.workspace as any).textDocuments = [doc];
    trackPendingNewFile("untitled:Untitled-2", "file:///work/new2.ts");
    await run("reject", f, "file:///work/new2.ts");
    expect(shown.calls.length).toBeGreaterThan(0);
    for (const c of shown.calls) expect(c.options.preserveFocus).toBe(true);
    expect(shown.commands).toContain(
      "workbench.action.revertAndCloseActiveEditor",
    );
    expect(f.core.invoke).toHaveBeenCalledWith("cancelApply", undefined);
    forgetPendingNewFile("file:///work/new2.ts");
  });

  it("does not revert the person's file if something else became the active editor", async () => {
    const f = fakes("stream-1");
    const draft = {
      uri: { toString: () => "untitled:Untitled-3" },
      getText: () => "x",
    };
    (vscode.workspace as any).textDocuments = [draft];
    trackPendingNewFile("untitled:Untitled-3", "file:///work/new3.ts");
    // the person's own file is the active editor, and stays so
    shown.active = {
      document: { uri: { toString: () => "file:///their/open.ts" } },
    };
    shown.keepActive = true;
    await run("reject", f, "file:///work/new3.ts");
    // the revert-and-close command reverts what it closes: it must not run
    expect(shown.commands).not.toContain(
      "workbench.action.revertAndCloseActiveEditor",
    );
    forgetPendingNewFile("file:///work/new3.ts");
  });

  it("closes the draft when it is the active editor", async () => {
    const f = fakes("stream-1");
    const draft = {
      uri: { toString: () => "untitled:Untitled-4" },
      getText: () => "x",
    };
    (vscode.workspace as any).textDocuments = [draft];
    trackPendingNewFile("untitled:Untitled-4", "file:///work/new4.ts");
    await run("reject", f, "file:///work/new4.ts");
    expect(shown.commands).toContain(
      "workbench.action.revertAndCloseActiveEditor",
    );
    forgetPendingNewFile("file:///work/new4.ts");
  });

  it("no path asks the editor for focus", async () => {
    const f = fakes("stream-1");
    await run("accept", f, "file:///work/a.ts");
    for (const [, options] of f.ide.openFile.mock.calls as unknown as Array<
      [string, { preserveFocus?: boolean }]
    >) {
      expect(options?.preserveFocus).toBe(true);
    }
    for (const c of shown.calls)
      expect(c.options.preserveFocus).not.toBe(false);
  });
});
