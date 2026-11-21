import { describe, expect, it } from "vitest";
import type { IDE } from "..";
import { validateSearchAndReplaceFilepath } from "../edit/searchAndReplace/validateArgs";
import { resolveRelativePathInDir } from "./ideUtils";

const BS = String.fromCharCode(92);

/** An IDE whose files are named by decoded, lower-cased path, as VS Code compares them. */
function fakeIde(workspace: string[], files: string[]): IDE {
  const norm = (uri: string) =>
    decodeURIComponent(new URL(uri).pathname).toLowerCase();
  const known = new Set(files.map((f) => f.toLowerCase()));
  return {
    getWorkspaceDirs: async () => workspace,
    fileExists: async (uri: string) => known.has(norm(uri)),
  } as unknown as IDE;
}

// A Windows workspace as VS Code writes it: lower-case drive, encoded colon
const WS = "file:///c%3A/work/My-Project";
const FILE_PATH = "/c:/work/my-project/infra/envs/prod/main.tf";
const REL = "infra/envs/prod/main.tf";

describe("resolveRelativePathInDir: an absolute path inside the workspace", () => {
  const ide = fakeIde([WS], [FILE_PATH]);
  const expectResolved = async (p: string) =>
    expect(await resolveRelativePathInDir(p, ide)).toBeTruthy();

  it("resolves a Windows path with backslashes", async () => {
    await expectResolved(
      ["c:", "work", "My-Project", "infra", "envs", "prod", "main.tf"].join(BS),
    );
  });

  it("resolves it with an upper-case drive letter", async () => {
    await expectResolved(`C:/work/My-Project/${REL}`);
  });

  it("resolves a file URI", async () => {
    await expectResolved(`file:///c%3A/work/My-Project/${REL}`);
  });

  it("still resolves a workspace-relative path", async () => {
    await expectResolved(REL);
  });

  it("is undefined for a file that does not exist", async () => {
    expect(
      await resolveRelativePathInDir("c:/work/My-Project/nope.tf", ide),
    ).toBeUndefined();
  });
});

describe("validateSearchAndReplaceFilepath (multi_edit, find and replace)", () => {
  const ide = fakeIde([WS], [FILE_PATH]);

  it("accepts the absolute Windows path the model typed", async () => {
    const typed = [
      "c:",
      "work",
      "My-Project",
      "infra",
      "envs",
      "prod",
      "main.tf",
    ].join(BS);
    await expect(
      validateSearchAndReplaceFilepath(typed, ide),
    ).resolves.toBeTruthy();
  });

  it("still says a missing file does not exist, naming it", async () => {
    await expect(
      validateSearchAndReplaceFilepath("c:/work/My-Project/nope.tf", ide),
    ).rejects.toThrow("c:/work/My-Project/nope.tf does not exist");
  });
});

describe("resolveRelativePathInDir: an absolute path outside the workspace", () => {
  const outside = "/c:/elsewhere/secret.tf";
  const ide = fakeIde([WS], [outside]);

  it("is not a target without the outside-workspace option", async () => {
    expect(
      await resolveRelativePathInDir("c:/elsewhere/secret.tf", ide),
    ).toBeUndefined();
  });

  it("is a target with it", async () => {
    expect(
      await resolveRelativePathInDir("c:/elsewhere/secret.tf", ide, undefined, {
        allowOutside: true,
      }),
    ).toBeTruthy();
  });

  it("does not let a path that climbs out of the workspace through", async () => {
    expect(
      await resolveRelativePathInDir("../elsewhere/secret.tf", ide),
    ).toBeUndefined();
  });
});
