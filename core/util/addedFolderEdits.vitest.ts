import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IDE } from "..";

const holder = vi.hoisted(() => ({ dir: "" }));
vi.mock("./paths", async (original) => ({
  ...(await original<typeof import("./paths")>()),
  getContinueGlobalPath: () => holder.dir,
}));

import { clearAdditionalFoldersCacheForTests } from "../tools/permissions/additionalFolders";
import { resolveRelativePathInDir } from "./ideUtils";

/**
 * A folder the person added with additionalFolders is part of the workspace for
 * the file tools too. Before this, a search-and-replace edit into it was
 * refused as "does not exist", because the edit tools resolved paths against
 * the IDE's folders only.
 */
const base = fs.realpathSync.native(
  fs.mkdtempSync(path.join(os.tmpdir(), "added-folder-edits-")),
);
holder.dir = path.join(base, "global");
const ws = path.join(base, "ws");
const shared = path.join(base, "shared");
const elsewhere = path.join(base, "elsewhere");

fs.mkdirSync(holder.dir, { recursive: true });
fs.mkdirSync(ws, { recursive: true });
fs.mkdirSync(shared, { recursive: true });
fs.mkdirSync(elsewhere, { recursive: true });
fs.writeFileSync(path.join(shared, "lib.ts"), "export const a = 1;\n");
fs.writeFileSync(path.join(elsewhere, "other.ts"), "export const b = 2;\n");

function ideWith(): IDE {
  return {
    getWorkspaceDirs: async () => [pathToFileURL(ws).href],
    fileExists: async (uri: string) => fs.existsSync(fileURLToPath(uri)),
  } as unknown as IDE;
}

beforeEach(() => {
  clearAdditionalFoldersCacheForTests();
  fs.writeFileSync(
    path.join(holder.dir, "config.yaml"),
    `toolPermissions:\n  auto:\n    environment:\n      additionalFolders:\n        - ${JSON.stringify(shared).slice(1, -1)}\n`,
  );
});

describe("edit tools and folders the person added", () => {
  it("finds a file in an added folder by its full path", async () => {
    const found = await resolveRelativePathInDir(
      path.join(shared, "lib.ts"),
      ideWith(),
    );
    expect(found).toBeDefined();
  });

  it("still refuses a file in a folder nobody added", async () => {
    const found = await resolveRelativePathInDir(
      path.join(elsewhere, "other.ts"),
      ideWith(),
    );
    expect(found).toBeUndefined();
  });
});
