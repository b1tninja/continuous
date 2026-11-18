import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { IDE } from "../..";
import { evaluateToolPolicyWithRules } from "../permissions/evaluate";
import { findProtected } from "../permissions/protectedCall";
import { uriToPath } from "../permissions/names";
import { readCurrentlyOpenFileTool } from "./readCurrentlyOpenFile";

function ideWith(current: string | undefined, workspace: string): IDE {
  return {
    getCurrentFile: async () =>
      current
        ? { isUntitled: false, path: current, contents: "SECRET=1" }
        : undefined,
    getWorkspaceDirs: async () => [workspace],
    fileExists: async () => true,
  } as unknown as IDE;
}

// Real paths of this machine: a `file:///home/u/...` URI has no drive letter,
// so `fileURLToPath` refuses it on Windows. The folder is resolved first
// because the tool follows links, and a temp folder can be one (macOS).
const home = fs.realpathSync.native(
  fs.mkdtempSync(path.join(os.tmpdir(), "open-file-")),
);
const project = path.join(home, "proj");
fs.mkdirSync(project);
fs.writeFileSync(path.join(project, ".env"), "SECRET=1");
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

const workspace = pathToFileURL(project).href;
const open = pathToFileURL(path.join(project, ".env")).href;
const homePath = uriToPath(pathToFileURL(home).href)!;

describe("read_currently_open_file", () => {
  it("checks the open file against protected paths and path rules", async () => {
    const processed = await readCurrentlyOpenFileTool.preprocessArgs!(
      {},
      { ide: ideWith(open, workspace) },
    );
    const resolved = processed.resolvedPath as { uri: string };
    expect(resolved.uri).toBe(open);
    expect(uriToPath(resolved.uri)).toBe(`${homePath}/proj/.env`);
    expect(
      findProtected({
        toolName: "read_currently_open_file",
        parsedArgs: {},
        resolvedPath: uriToPath(resolved.uri),
        home: homePath,
      })?.kind,
    ).toBe("secret");

    const asked = evaluateToolPolicyWithRules({
      tool: readCurrentlyOpenFileTool,
      toolName: "read_currently_open_file",
      basePolicy: "allowedWithoutPermission",
      parsedArgs: {},
      processedArgs: processed,
      permissions: undefined,
    });
    expect(asked).toMatchObject({
      policy: "allowedWithPermission",
      source: "protected-path",
    });

    const denied = evaluateToolPolicyWithRules({
      tool: readCurrentlyOpenFileTool,
      toolName: "read_currently_open_file",
      basePolicy: "allowedWithoutPermission",
      parsedArgs: {},
      processedArgs: processed,
      permissions: { deny: ["readFile(**/.env)"] },
    });
    expect(denied).toMatchObject({ policy: "disabled", source: "deny-rule" });
  });

  it("has nothing to check when no file is open", async () => {
    const processed = await readCurrentlyOpenFileTool.preprocessArgs!(
      {},
      { ide: ideWith(undefined, workspace) },
    );
    expect(processed.resolvedPath).toBeNull();
    expect(
      findProtected({
        toolName: "read_currently_open_file",
        parsedArgs: {},
        home: homePath,
      }),
    ).toBeUndefined();
  });
});
