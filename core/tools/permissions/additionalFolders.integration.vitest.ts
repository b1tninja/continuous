import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IDE } from "../..";

const holder = vi.hoisted(() => ({ dir: "" }));
vi.mock("../../util/paths", async (original) => ({
  ...(await original<typeof import("../../util/paths")>()),
  getContinueGlobalPath: () => holder.dir,
}));

import { resolveInputPath } from "../../util/pathResolver";
import {
  createNewFileTool,
  editFileTool,
  multiEditTool,
  readFileTool,
  singleFindAndReplaceTool,
} from "../definitions";
import {
  clearAdditionalFoldersCacheForTests,
  readUserAdditionalFolders,
  withAdditionalFolders,
} from "./additionalFolders";
import { deputyWorkspace } from "./workspaceRoots";
import { evaluateToolPolicyWithRules, type EvaluateInput } from "./evaluate";
import { needsLink, tryLink } from "./testLinks";

const ASK = "allowedWithPermission";
const ALLOW = "allowedWithoutPermission";

/**
 * A folder the person added counts as the workspace for the "outside" question
 * and for nothing else: a secret, a file that changes what runs later, and a
 * path that leaves it by a link are judged as before. Real files, a real
 * config.yaml, and the evaluator as core calls it.
 */
const base = fs.realpathSync.native(
  fs.mkdtempSync(path.join(os.tmpdir(), "addfolders-int-")),
);
holder.dir = path.join(base, "global");
fs.mkdirSync(holder.dir);
const ws = path.join(base, "ws");
const shared = path.join(base, "shared");
const elsewhere = path.join(base, "elsewhere");
for (const d of [ws, shared, elsewhere, path.join(shared, ".git", "hooks")]) {
  fs.mkdirSync(d, { recursive: true });
}
fs.writeFileSync(path.join(shared, "ok.txt"), "x");
fs.writeFileSync(path.join(shared, ".env"), "KEY=1");
fs.writeFileSync(path.join(elsewhere, "x.txt"), "x");
// A junction needs no privilege on Windows; elsewhere it is a plain link.
const link = tryLink(elsewhere, path.join(shared, "escape"));
const secondRoot = path.join(base, "second-root");
fs.mkdirSync(secondRoot);
fs.writeFileSync(path.join(secondRoot, "r.txt"), "x");
let openedRoots: string[] = [pathToFileURL(ws).href];
const ide = {
  getWorkspaceDirs: async () => openedRoots,
  fileExists: async (uri: string) => fs.existsSync(new URL(uri)),
} as unknown as IDE;

afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

beforeEach(() => {
  openedRoots = [pathToFileURL(ws).href];
  clearAdditionalFoldersCacheForTests();
  fs.rmSync(path.join(holder.dir, "config.yaml"), { force: true });
});

const addFolders = (...folders: string[]) => {
  const items = folders.map((f) => `        - ${JSON.stringify(f)}`).join("\n");
  fs.writeFileSync(
    path.join(holder.dir, "config.yaml"),
    `toolPermissions:\n  auto:\n    environment:\n      additionalFolders:\n${items}\n`,
  );
  clearAdditionalFoldersCacheForTests();
};

/** What core's evaluatePolicy does for one file-tool call. */
async function decide(
  tool: typeof readFileTool,
  filepath: string,
  builtin: Record<string, boolean> = {},
) {
  const resolved = await resolveInputPath(ide, filepath);
  const dirs = withAdditionalFolders(
    await ide.getWorkspaceDirs(),
    readUserAdditionalFolders(),
  );
  return {
    resolved,
    result: evaluateToolPolicyWithRules({
      tool,
      toolName: tool.function.name,
      basePolicy: tool.defaultToolPolicy,
      parsedArgs: { filepath },
      processedArgs: { resolvedPath: resolved },
      permissions: undefined,
      cwd: ws,
      shell: "bash",
      home: os.homedir(),
      ...deputyWorkspace(dirs),
      approval: {
        levels: {
          context: "permissive",
          tools: "permissive",
          edits: "permissive",
          plan: "permissive",
          questions: "permissive",
        },
        builtin,
      },
    } as EvaluateInput),
  };
}

describe("a file in an added folder", () => {
  it("is outside the workspace and asks when no folder was added (control)", async () => {
    const { resolved, result } = await decide(
      readFileTool,
      path.join(shared, "ok.txt"),
    );
    expect(resolved?.isWithinWorkspace).toBe(false);
    expect(result.policy).toBe(ASK);
    expect(result.protection).toBe("file-deputy");
  });

  it("is inside the workspace once the folder is added, and a read runs", async () => {
    addFolders(shared);
    const { resolved, result } = await decide(
      readFileTool,
      path.join(shared, "ok.txt"),
    );
    expect(resolved?.isWithinWorkspace).toBe(true);
    expect(result.policy).toBe(ALLOW);
  });

  it("an edit of a file that exists there runs too: it is the workspace for this question", async () => {
    addFolders(shared);
    const { resolved, result } = await decide(
      createNewFileTool,
      path.join(shared, "ok.txt"),
    );
    expect(resolved?.isWithinWorkspace).toBe(true);
    expect(result.policy).toBe(ALLOW);
  });

  it("a new file at an absolute path gets the answer the workspace itself gets", async () => {
    // What a new file at an absolute path does is decided by the edit rules, not
    // by this feature: the real workspace is the control, and an added folder
    // must match it exactly. (This used to assert "asks"; at Permissive the
    // workspace allows it, on main as well, so the invariant is the match.)
    const inWorkspace = await decide(
      createNewFileTool,
      path.join(ws, "new.txt"),
    );
    expect(inWorkspace.resolved?.isWithinWorkspace).toBe(true);
    addFolders(shared);
    const inAdded = await decide(
      createNewFileTool,
      path.join(shared, "new.txt"),
    );
    expect(inAdded.resolved?.isWithinWorkspace).toBe(true);
    expect(inAdded.result.policy).toBe(inWorkspace.result.policy);
    expect(inAdded.result.protection).toBe(inWorkspace.result.protection);
  });

  it("a new file in a folder that was not added is not treated like the workspace", async () => {
    addFolders(shared);
    const inWorkspace = await decide(
      createNewFileTool,
      path.join(ws, "new.txt"),
    );
    const notAdded = await decide(
      createNewFileTool,
      path.join(elsewhere, "new.txt"),
    );
    expect(notAdded.resolved?.isWithinWorkspace).toBe(false);
    // outside the workspace it asks, whatever the workspace itself does
    expect(notAdded.result.policy).toBe(ASK);
    expect(notAdded.result.protection).toBe("file-deputy");
    expect(inWorkspace.resolved?.isWithinWorkspace).toBe(true);
  });

  it("a folder that was not added still asks", async () => {
    addFolders(shared);
    const { resolved, result } = await decide(
      readFileTool,
      path.join(elsewhere, "x.txt"),
    );
    expect(resolved?.isWithinWorkspace).toBe(false);
    expect(result.policy).toBe(ASK);
  });
});

describe("what an added folder does not loosen", () => {
  it("a secret file inside it still asks", async () => {
    addFolders(shared);
    const { result } = await decide(readFileTool, path.join(shared, ".env"));
    expect(result.policy).toBe(ASK);
    expect(result.protection).toBe("secret");
  });

  it("a file that changes what runs later still asks to be written", async () => {
    addFolders(shared);
    const { result } = await decide(
      createNewFileTool,
      path.join(shared, ".git", "hooks", "pre-commit"),
    );
    expect(result.policy).toBe(ASK);
  });

  it.skipIf(!link.ok)(
    needsLink("a link inside it that leads out of it still asks", link),
    async () => {
      addFolders(shared);
      const { resolved, result } = await decide(
        readFileTool,
        path.join(shared, "escape", "x.txt"),
      );
      expect(resolved?.isWithinWorkspace).toBe(false);
      expect(result.policy).toBe(ASK);
    },
  );

  it("the home folder, the filesystem root and a missing folder add nothing", async () => {
    addFolders(os.homedir(), path.parse(base).root, path.join(base, "gone"));
    expect(readUserAdditionalFolders()).toEqual([]);
    const { resolved } = await decide(
      readFileTool,
      path.join(shared, "ok.txt"),
    );
    expect(resolved?.isWithinWorkspace).toBe(false);
  });

  it("turning the outside-paths check off is a separate switch and still works as before", async () => {
    const { result } = await decide(readFileTool, path.join(shared, "ok.txt"), {
      "ask-outside-paths": false,
    });
    expect(result.policy).toBe(ALLOW);
  });
});

/**
 * The search-and-replace edit tools hand the permission layer a `fileUri` from
 * preprocessArgs and no resolved path of their own, so the "outside the
 * workspace" answer comes from the folders (opened and added) alone. Every edit
 * tool must give an added folder the answer the workspace itself gets.
 */
describe("every edit tool treats an added folder as the workspace", () => {
  const EDIT_TOOLS = [
    ["multi_edit", multiEditTool],
    ["single_find_and_replace", singleFindAndReplaceTool],
    ["edit_file", editFileTool],
  ] as const;

  async function decideEdit(
    tool: typeof multiEditTool,
    filepath: string,
    builtin: Record<string, boolean> = {},
  ) {
    const fileUri = pathToFileURL(filepath).href;
    const dirs = withAdditionalFolders(
      await ide.getWorkspaceDirs(),
      readUserAdditionalFolders(),
    );
    return evaluateToolPolicyWithRules({
      tool,
      toolName: tool.function.name,
      basePolicy: tool.defaultToolPolicy,
      parsedArgs: { filepath },
      // What preprocessArgs returns: a file URI, and no resolved path
      processedArgs: { fileUri },
      permissions: undefined,
      cwd: ws,
      shell: "bash",
      home: os.homedir(),
      ...deputyWorkspace(dirs),
      approval: {
        levels: {
          context: "permissive",
          tools: "permissive",
          edits: "permissive",
          plan: "permissive",
          questions: "permissive",
        },
        builtin,
      },
    } as EvaluateInput);
  }

  it.each(EDIT_TOOLS)(
    "%s: a file in an added folder gets the workspace's answer",
    async (_n, tool) => {
      fs.writeFileSync(path.join(ws, "w.txt"), "x");
      const inWorkspace = await decideEdit(tool, path.join(ws, "w.txt"));
      addFolders(shared);
      const inAdded = await decideEdit(tool, path.join(shared, "ok.txt"));
      expect(inAdded.policy).toBe(inWorkspace.policy);
      expect(inAdded.protection).toBe(inWorkspace.protection);
    },
  );

  it.each(EDIT_TOOLS)(
    "%s: a folder nobody added still asks",
    async (_n, tool) => {
      addFolders(shared);
      const r = await decideEdit(tool, path.join(elsewhere, "x.txt"));
      expect(r.policy).toBe(ASK);
      expect(r.protection).toBe("file-deputy");
    },
  );

  it.each(EDIT_TOOLS)(
    "%s: without the folder added, the same file asks (control)",
    async (_n, tool) => {
      const r = await decideEdit(tool, path.join(shared, "ok.txt"));
      expect(r.policy).toBe(ASK);
      expect(r.protection).toBe("file-deputy");
    },
  );

  it.each(EDIT_TOOLS)(
    "%s: a second opened workspace root counts too",
    async (_n, tool) => {
      openedRoots = [pathToFileURL(ws).href, pathToFileURL(secondRoot).href];
      const r = await decideEdit(tool, path.join(secondRoot, "r.txt"));
      expect(r.protection).not.toBe("file-deputy");
    },
  );

  it.each(EDIT_TOOLS)(
    "%s: a secret in an added folder still asks",
    async (_n, tool) => {
      addFolders(shared);
      const r = await decideEdit(tool, path.join(shared, ".env"));
      expect(r.policy).toBe(ASK);
      expect(r.protection).toBe("secret");
    },
  );
});
