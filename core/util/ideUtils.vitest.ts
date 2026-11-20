import { describe, expect, it } from "vitest";
import { isOutsideDirs, staysInDir } from "./ideUtils";
import { findUriInDirs } from "./uri";

/**
 * The workspace from issue #954, as VS Code writes it (`file:///d%3A/...`)
 * and as a model writes the same folder.
 */
const VSCODE = "file:///d%3A/Qsync/VBNETProjects/Kuid%20Lister";
const VSCODE_TRAIL = `${VSCODE}/`;
const FILE_URI =
  "file:///D:/Qsync/VBNETProjects/Kuid%20Lister/.gitignore-python";
const BACKSLASH = "D:\\Qsync\\VBNETProjects\\Kuid Lister\\.gitignore-python";
const FORWARD = "D:/Qsync/VBNETProjects/Kuid Lister/.gitignore-python";
const LOWER_TRAIL = "d:\\Qsync\\VBNETProjects\\Kuid Lister\\";

describe("Windows paths that spell one place stay inside the workspace", () => {
  it.each([
    ["file URI drive letter", FILE_URI, VSCODE],
    ["file URI trailing separator", FILE_URI, VSCODE_TRAIL],
    [
      "backslashes against forward slashes",
      BACKSLASH,
      FORWARD.replace(/\/\.gitignore-python$/, ""),
    ],
    ["backslashes against a trailing separator", BACKSLASH, LOWER_TRAIL],
    [
      "forward slashes against backslashes",
      FORWARD,
      "D:\\Qsync\\VBNETProjects\\Kuid Lister",
    ],
    [
      "the folder itself, other slash and drive case",
      "d:/Qsync/VBNETProjects/Kuid Lister",
      "D:\\Qsync\\VBNETProjects\\Kuid Lister\\",
    ],
    [
      "uriToPath's /d:/ form against backslashes",
      BACKSLASH,
      "/d:/Qsync/VBNETProjects/Kuid Lister",
    ],
    [
      "uriToPath's /d:/ form with a trailing separator",
      FORWARD,
      "/d:/Qsync/VBNETProjects/Kuid Lister/",
    ],
  ])("%s", (_name, child, parent) => {
    expect(staysInDir(child, parent)).toBe(true);
    expect(isOutsideDirs(child, [parent])).toBe(false);
  });

  it("folds the rest of a Windows path, and still resolves ..", () => {
    expect(findUriInDirs(FILE_URI, [VSCODE]).foundInDir).toBe(VSCODE);
    expect(
      staysInDir(
        "file:///D:/Qsync/VBNETProjects/Kuid%20Lister/src/%2E%2E/.gitignore-python",
        VSCODE,
      ),
    ).toBe(true);
    expect(
      staysInDir(
        "file:///D:/Qsync/VBNETProjects/Kuid%20Lister/%2E%2E/secret.txt",
        VSCODE,
      ),
    ).toBe(false);
  });

  it("a path that is genuinely outside stays outside", () => {
    expect(staysInDir("D:\\elsewhere\\secret.txt", LOWER_TRAIL)).toBe(false);
    expect(staysInDir(BACKSLASH, "/c:/Qsync/VBNETProjects/Kuid Lister")).toBe(
      false,
    );
    expect(staysInDir("C:/Qsync/VBNETProjects/Kuid Lister/a.txt", VSCODE)).toBe(
      false,
    );
    expect(
      staysInDir(
        "D:/Qsync/VBNETProjects/Kuid Lister Evil/.gitignore-python",
        "D:\\Qsync\\VBNETProjects\\Kuid Lister\\",
      ),
    ).toBe(false);
    expect(staysInDir("file:///D:/elsewhere/secret.txt", VSCODE_TRAIL)).toBe(
      false,
    );
    expect(isOutsideDirs(BACKSLASH, ["D:\\elsewhere"])).toBe(true);
  });

  it("a POSIX path stays case-sensitive", () => {
    expect(staysInDir("file:///home/u/Proj/a.ts", "file:///home/u/proj")).toBe(
      false,
    );
    expect(staysInDir("file:///home/u/proj/a.ts", "file:///home/u/proj/")).toBe(
      true,
    );
    expect(
      findUriInDirs("file:///home/u/Proj/a.ts", ["file:///home/u/proj"])
        .foundInDir,
    ).toBeNull();
  });
});
