import { describe, expect, it, vi } from "vitest";

import {
  describeOutcome,
  DropDataTransfer,
  DroppedKind,
  isSecretPath,
  MAX_DROPPED_ITEMS,
  parseUriList,
  resolveDrop,
  stripFragment,
} from "./dropHandler";

/*
 * Fixtures shaped like what VS Code hands a tree view's `handleDrop`
 * (microsoft/vscode@580745c3, src/vs/workbench/browser/parts/views/treeView.ts
 * `CustomTreeViewDragAndDrop.drop` -> src/vs/editor/browser/dataTransfer.ts
 * `toExternalVSDataTransfer(…, true)`): only the types in `dropMimeTypes`
 * survive, and `text/uri-list` carries the workbench's full internal list
 * (`application/vnd.code.uri-list`) when there is one, otherwise `file:` URIs
 * built from Electron's `getPathForFile` for each OS file.
 */
function transfer(types: Record<string, string>): DropDataTransfer {
  return {
    get: (mime) =>
      mime in types ? { asString: async () => types[mime] } : undefined,
  };
}

const WS = "file:///home/me/project";
const WS2 = "file:///home/me/other";

const fixtures = {
  /** Explorer, one file: fillEditorsDragData writes the internal list. */
  explorerFile: transfer({ "text/uri-list": `${WS}/src/a.ts` }),
  /** Explorer multi-select: folders first, then files, CRLF separated. */
  explorerMulti: transfer({
    "text/uri-list": [`${WS}/src`, `${WS}/README.md`, `${WS}/src/b.ts`].join(
      "\r\n",
    ),
  }),
  /** Editor tab with a selection: the URI carries a fragment. */
  editorTabSelection: transfer({
    "text/uri-list": `${WS}/src/a.ts#L3,5-L9,1`,
  }),
  /** Untitled editor tab. */
  untitledTab: transfer({ "text/uri-list": "untitled:Untitled-1" }),
  /** OS file manager: a file and a folder inside the workspace. */
  osInside: transfer({
    "text/uri-list": `${WS}/docs/guide.md\r\n${WS}/docs`,
  }),
  /** OS file manager: a file elsewhere on disk. */
  osOutside: transfer({ "text/uri-list": "file:///home/me/Downloads/x.pdf" }),
  /** Remote window: Explorer gives vscode-remote URIs. */
  remoteExplorer: transfer({
    "text/uri-list": "vscode-remote://ssh-remote%2Bbox/srv/app/main.py",
  }),
  /** Another extension's tree item: only its own type, no uri-list. */
  otherTree: transfer({ "application/vnd.code.tree.foo": "{}" }),
};

function stat(map: Record<string, DroppedKind>) {
  return vi.fn(async (uri: string) => map[uri]);
}

describe("parseUriList", () => {
  it("splits CRLF and LF, drops comments and blanks", () => {
    expect(parseUriList("# c\r\nfile:///a\r\n\nfile:///b\n")).toEqual([
      "file:///a",
      "file:///b",
    ]);
  });
});

describe("stripFragment", () => {
  it("removes a selection fragment", () => {
    expect(stripFragment("file:///a.ts#L1")).toBe("file:///a.ts");
    expect(stripFragment("file:///a.ts")).toBe("file:///a.ts");
  });
});

describe("isSecretPath", () => {
  it.each([
    [".env", "file"],
    ["config/.env.local", "file"],
    ["certs/server.pem", "file"],
    ["keys/id_rsa", "file"],
    [".ssh/config", "file"],
    [".aws", "folder"],
    ["secrets", "folder"],
  ] as const)("refuses %s (%s)", (rel, kind) => {
    expect(isSecretPath(rel, kind)).toBe(true);
  });

  it.each([
    ["src/a.ts", "file"],
    ["src", "folder"],
    ["README.md", "file"],
    ["", "folder"],
  ] as const)("accepts %s (%s)", (rel, kind) => {
    expect(isSecretPath(rel, kind)).toBe(false);
  });
});

describe("resolveDrop", () => {
  const deps = (map: Record<string, DroppedKind>, dirs = [WS]) => ({
    workspaceDirs: dirs,
    stat: stat(map),
  });

  it("Explorer file becomes an @file chip", async () => {
    const out = await resolveDrop(
      fixtures.explorerFile,
      deps({ [`${WS}/src/a.ts`]: "file" }),
    );
    expect(out.chips).toEqual([
      { type: "file", fullPath: `${WS}/src/a.ts`, name: "a.ts" },
    ]);
    expect(out.refused).toEqual([]);
  });

  it("Explorer multi-select keeps order and marks folders", async () => {
    const out = await resolveDrop(
      fixtures.explorerMulti,
      deps({
        [`${WS}/src`]: "folder",
        [`${WS}/README.md`]: "file",
        [`${WS}/src/b.ts`]: "file",
      }),
    );
    expect(out.chips.map((c) => [c.type, c.name])).toEqual([
      ["folder", "src"],
      ["file", "README.md"],
      ["file", "b.ts"],
    ]);
  });

  it("editor tab with a selection names the file once", async () => {
    const out = await resolveDrop(
      transfer({
        "text/uri-list": `${WS}/src/a.ts#L1\r\n${WS}/src/a.ts#L9`,
      }),
      deps({ [`${WS}/src/a.ts`]: "file" }),
    );
    expect(out.chips).toHaveLength(1);
    expect(out.chips[0].fullPath).toBe(`${WS}/src/a.ts`);
    const single = await resolveDrop(
      fixtures.editorTabSelection,
      deps({ [`${WS}/src/a.ts`]: "file" }),
    );
    expect(single.chips[0].fullPath).toBe(`${WS}/src/a.ts`);
  });

  it("refuses an untitled tab as outside the workspace", async () => {
    const d = deps({});
    const out = await resolveDrop(fixtures.untitledTab, d);
    expect(out.chips).toEqual([]);
    expect(out.refused[0].reason).toBe("is outside the workspace");
    expect(d.stat).not.toHaveBeenCalled();
  });

  it("OS files inside the workspace are accepted", async () => {
    const out = await resolveDrop(
      fixtures.osInside,
      deps({ [`${WS}/docs/guide.md`]: "file", [`${WS}/docs`]: "folder" }),
    );
    expect(out.chips.map((c) => c.type)).toEqual(["file", "folder"]);
  });

  it("OS files outside the workspace are refused without a stat", async () => {
    const d = deps({ "file:///home/me/Downloads/x.pdf": "file" });
    const out = await resolveDrop(fixtures.osOutside, d);
    expect(out.chips).toEqual([]);
    expect(out.refused).toEqual([
      { name: "x.pdf", reason: "is outside the workspace" },
    ]);
    expect(d.stat).not.toHaveBeenCalled();
  });

  it("dot segments cannot climb out of the workspace", async () => {
    const out = await resolveDrop(
      transfer({ "text/uri-list": `${WS}/../secret.txt` }),
      deps({ [`${WS}/../secret.txt`]: "file" }),
    );
    expect(out.refused[0].reason).toBe("is outside the workspace");
  });

  it("remote Explorer URIs match remote workspace folders", async () => {
    const remoteWs = "vscode-remote://ssh-remote%2Bbox/srv/app";
    const out = await resolveDrop(
      fixtures.remoteExplorer,
      deps({ "vscode-remote://ssh-remote%2Bbox/srv/app/main.py": "file" }, [
        remoteWs,
      ]),
    );
    expect(out.chips[0].name).toBe("main.py");
  });

  it("refuses secret files by name before asking the host", async () => {
    const d = deps({ [`${WS}/.env`]: "file" });
    const out = await resolveDrop(
      transfer({ "text/uri-list": `${WS}/.env` }),
      d,
    );
    expect(out.refused).toEqual([
      { name: ".env", reason: "looks like it holds secrets or keys" },
    ]);
    expect(d.stat).not.toHaveBeenCalled();
  });

  it("refuses a secret folder after learning it is a folder", async () => {
    const out = await resolveDrop(
      transfer({ "text/uri-list": `${WS}/secrets` }),
      deps({ [`${WS}/secrets`]: "folder" }),
    );
    expect(out.refused[0].reason).toBe("looks like it holds secrets or keys");
  });

  it("refuses a resource that no longer exists", async () => {
    const out = await resolveDrop(
      transfer({ "text/uri-list": `${WS}/gone.ts` }),
      deps({}),
    );
    expect(out.refused[0].reason).toBe("was not found");
  });

  it("matches a second workspace folder", async () => {
    const out = await resolveDrop(
      transfer({ "text/uri-list": `${WS2}/x.ts` }),
      deps({ [`${WS2}/x.ts`]: "file" }, [WS, WS2]),
    );
    expect(out.chips).toHaveLength(1);
  });

  it("compares file paths without case when asked", async () => {
    const t = transfer({ "text/uri-list": "file:///D%3A/Code/App/a.ts" });
    const map = { "file:///D%3A/Code/App/a.ts": "file" as const };
    const strict = await resolveDrop(t, {
      workspaceDirs: ["file:///d%3A/code/app"],
      stat: stat(map),
    });
    expect(strict.chips).toEqual([]);
    const loose = await resolveDrop(t, {
      workspaceDirs: ["file:///d%3A/code/app"],
      stat: stat(map),
      caseInsensitiveFiles: true,
    });
    expect(loose.chips).toHaveLength(1);
  });

  it("does nothing for a drag with no uri-list", async () => {
    const out = await resolveDrop(fixtures.otherTree, deps({}));
    expect(out).toEqual({ chips: [], refused: [] });
    expect(describeOutcome(out)).toBeUndefined();
  });

  it("caps one drop", async () => {
    const uris = Array.from(
      { length: MAX_DROPPED_ITEMS + 2 },
      (_, i) => `${WS}/f${i}.ts`,
    );
    const map = Object.fromEntries(uris.map((u) => [u, "file" as const]));
    const out = await resolveDrop(
      transfer({ "text/uri-list": uris.join("\r\n") }),
      deps(map),
    );
    expect(out.chips).toHaveLength(MAX_DROPPED_ITEMS);
    expect(out.refused).toHaveLength(2);
  });
});

describe("describeOutcome", () => {
  it("names one chip and summarises refusals", () => {
    expect(
      describeOutcome({
        chips: [{ type: "file", fullPath: `${WS}/a.ts`, name: "a.ts" }],
        refused: [
          { name: ".env", reason: "looks like it holds secrets or keys" },
        ],
      }),
    ).toBe(
      "Added a.ts to the chat input. Not added: .env looks like it holds secrets or keys.",
    );
  });

  it("truncates long refusal lists", () => {
    const refused = Array.from({ length: 5 }, (_, i) => ({
      name: `f${i}`,
      reason: "is outside the workspace",
    }));
    expect(describeOutcome({ chips: [], refused })).toContain("(and 2 more)");
  });
});
