import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  folders: [] as { uri: { toString(): string } }[],
  kinds: {} as Record<string, number>,
  warning: vi.fn(),
  status: vi.fn(),
  setContext: vi.fn(),
}));

vi.mock("vscode", () => {
  class TreeItem {
    constructor(
      public label: string,
      public collapsibleState: number,
    ) {}
  }
  class ThemeIcon {
    constructor(public id: string) {}
  }
  class MarkdownString {
    constructor(public value: string) {}
  }
  return {
    TreeItem,
    ThemeIcon,
    MarkdownString,
    TreeItemCollapsibleState: { None: 0 },
    FileType: { File: 1, Directory: 2 },
    Uri: { parse: (s: string) => ({ s }) },
    workspace: {
      get workspaceFolders() {
        return state.folders;
      },
      fs: {
        stat: async ({ s }: { s: string }) => {
          if (!(s in state.kinds)) {
            throw new Error("ENOENT");
          }
          return { type: state.kinds[s] };
        },
      },
    },
    window: {
      showWarningMessage: state.warning,
      setStatusBarMessage: state.status,
    },
    commands: { executeCommand: state.setContext },
  };
});

import { ChatDropZone, isWebviewDropBlocked } from "./ChatDropZone";

const WS = "file:///home/me/project";
const token = { isCancellationRequested: false } as any;

function dt(list: string) {
  return {
    get: (m: string) =>
      m === "text/uri-list" ? { asString: async () => list } : undefined,
  } as any;
}

describe("isWebviewDropBlocked", () => {
  it.each([
    ["1.139.0", false],
    ["1.105.2", false],
    ["1.140.0", true],
    ["1.145.2", true],
    ["1.146.0-insider", true],
    ["2.0.0", true],
    ["garbage", false],
  ])("%s -> %s", (v, expected) => {
    expect(isWebviewDropBlocked(v)).toBe(expected);
  });
});

describe("ChatDropZone", () => {
  beforeEach(() => {
    state.folders = [{ uri: { toString: () => WS } }];
    state.kinds = {};
    state.warning.mockReset();
    state.status.mockReset();
  });

  it("accepts text/uri-list only, and drags nothing out", () => {
    const zone = new ChatDropZone(async () => {});
    expect(zone.dropMimeTypes).toEqual(["text/uri-list"]);
    expect(zone.dragMimeTypes).toEqual([]);
  });

  it("shows one placeholder row that opens the picker", () => {
    const zone = new ChatDropZone(async () => {});
    const rows = zone.getChildren();
    expect(rows).toHaveLength(1);
    const item = zone.getTreeItem(rows[0]) as any;
    expect(item.label).toBe("Drop files or folders here");
    expect(item.command.command).toBe("continuous.dropZone.pickFiles");
    expect(zone.getChildren(rows[0])).toEqual([]);
  });

  it("delivers chips for an Explorer drop and reports in the status bar", async () => {
    state.kinds = { [`${WS}/src`]: 2, [`${WS}/a.ts`]: 1 };
    const deliver = vi.fn(async () => {});
    const zone = new ChatDropZone(deliver);
    await zone.handleDrop(undefined, dt(`${WS}/src\r\n${WS}/a.ts`), token);
    expect(deliver).toHaveBeenCalledWith([
      { type: "folder", fullPath: `${WS}/src`, name: "src" },
      { type: "file", fullPath: `${WS}/a.ts`, name: "a.ts" },
    ]);
    expect(state.status).toHaveBeenCalledWith(
      "Added 2 items to the chat input.",
      4000,
    );
    expect(state.warning).not.toHaveBeenCalled();
  });

  it("warns and delivers nothing when every item is refused", async () => {
    const deliver = vi.fn(async () => {});
    const zone = new ChatDropZone(deliver);
    await zone.handleDrop(
      undefined,
      dt(`${WS}/.env\r\nfile:///tmp/outside.txt`),
      token,
    );
    expect(deliver).not.toHaveBeenCalled();
    expect(state.warning).toHaveBeenCalledWith(
      "Not added: .env looks like it holds secrets or keys; outside.txt is outside the workspace.",
    );
  });

  it("refuses everything when no folder is open", async () => {
    state.folders = [];
    state.kinds = { [`${WS}/a.ts`]: 1 };
    const deliver = vi.fn(async () => {});
    await new ChatDropZone(deliver).handleDrop(
      undefined,
      dt(`${WS}/a.ts`),
      token,
    );
    expect(deliver).not.toHaveBeenCalled();
    expect(state.warning).toHaveBeenCalled();
  });
});
