import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { clearAdditionalFoldersCacheForTests } from "core/tools/permissions/additionalFolders.js";
import { removeTestTempDir, testTempDir } from "core/util/testTempDir.js";

import { outsideWorkspaceNote } from "./workspaceBoundary.js";

const holder = vi.hoisted(() => ({ dir: "" }));
vi.mock("core/util/paths.js", async (original) => ({
  ...(await original<typeof import("core/util/paths.js")>()),
  getContinueGlobalPath: () => holder.dir,
}));

/**
 * The CLI's "outside the working directory" note, with the folders the person
 * added in their own config.yaml. The note is what makes a headless write
 * refuse and an interactive one preview a warning.
 */
describe("outsideWorkspaceNote and additional folders", () => {
  let base: string;
  let cwd: string;
  let shared: string;
  let elsewhere: string;

  beforeAll(() => {
    base = testTempDir("cli-addfolders-");
    holder.dir = path.join(base, "global");
    fs.mkdirSync(holder.dir);
    cwd = path.join(base, "proj");
    shared = path.join(base, "shared");
    elsewhere = path.join(base, "elsewhere");
    for (const d of [cwd, shared, elsewhere]) fs.mkdirSync(d);
  });

  afterAll(() => removeTestTempDir(base));

  beforeEach(() => {
    clearAdditionalFoldersCacheForTests();
    fs.rmSync(path.join(holder.dir, "config.yaml"), { force: true });
  });

  const addFolders = (...folders: string[]) => {
    const items = folders
      .map((f) => `        - ${JSON.stringify(f)}`)
      .join("\n");
    fs.writeFileSync(
      path.join(holder.dir, "config.yaml"),
      `toolPermissions:\n  auto:\n    environment:\n      additionalFolders:\n${items}\n`,
    );
    clearAdditionalFoldersCacheForTests();
  };

  it("a path in a sibling folder has a note when no folder was added (control)", () => {
    const note = outsideWorkspaceNote(
      path.join(shared, "a.ts"),
      cwd,
      undefined,
    );
    expect(note).toContain("Outside the working directory");
  });

  it("has no note once that folder is added, for the folder itself and below it", () => {
    addFolders(shared);
    expect(
      outsideWorkspaceNote(path.join(shared, "a.ts"), cwd, undefined),
    ).toBeUndefined();
    expect(
      outsideWorkspaceNote(
        path.join(shared, "deep", "b", "c.ts"),
        cwd,
        undefined,
      ),
    ).toBeUndefined();
    expect(outsideWorkspaceNote(shared, cwd, undefined)).toBeUndefined();
  });

  it("still has a note for a folder that was not added", () => {
    addFolders(shared);
    expect(
      outsideWorkspaceNote(path.join(elsewhere, "x.ts"), cwd, undefined),
    ).toContain("Outside the working directory");
  });

  it("a sibling whose name starts with an added folder's name is not covered", () => {
    addFolders(shared);
    const sibling = shared + "-two";
    fs.mkdirSync(sibling);
    expect(
      outsideWorkspaceNote(path.join(sibling, "a.ts"), cwd, undefined),
    ).toContain("Outside the working directory");
  });

  it("the home folder and the filesystem root add nothing", () => {
    addFolders(os.homedir(), path.parse(base).root);
    expect(
      outsideWorkspaceNote(path.join(elsewhere, "x.ts"), cwd, undefined),
    ).toContain("Outside the working directory");
  });

  it("an unreadable config.yaml changes nothing", () => {
    fs.writeFileSync(path.join(holder.dir, "config.yaml"), "a: [unclosed");
    clearAdditionalFoldersCacheForTests();
    expect(
      outsideWorkspaceNote(path.join(shared, "a.ts"), cwd, undefined),
    ).toContain("Outside the working directory");
  });
});
