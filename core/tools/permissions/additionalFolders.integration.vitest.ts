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
import { createNewFileTool, readFileTool } from "../definitions";
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
const ide = {
  getWorkspaceDirs: async () => [pathToFileURL(ws).href],
  fileExists: async (uri: string) => fs.existsSync(new URL(uri)),
} as unknown as IDE;

afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

beforeEach(() => {
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

  it("an absolute path to a file that does not exist yet asks, as it does in the workspace itself", async () => {
    // Existing behaviour, not a limit of this feature: the control below is
    // the real workspace, and the same path there asks too.
    const inWorkspace = await decide(
      createNewFileTool,
      path.join(ws, "new.txt"),
    );
    expect(inWorkspace.result.policy).toBe(ASK);
    addFolders(shared);
    const inAdded = await decide(
      createNewFileTool,
      path.join(shared, "new.txt"),
    );
    expect(inAdded.result.policy).toBe(inWorkspace.result.policy);
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
