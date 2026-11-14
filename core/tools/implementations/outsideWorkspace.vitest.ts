import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IDE, ToolExtras } from "../..";
import { validateSearchAndReplaceFilepath } from "../../edit/searchAndReplace/validateArgs";
import {
  absoluteLocalUri,
  inferResolvedUriFromRelativePath,
  resolveRelativePathInDir,
} from "../../util/ideUtils";
import { createNewFileImpl, outsideAbsolutePath } from "./createNewFile";
import { multiEditImpl, singleFindAndReplaceImpl } from "./exactEdits";

let root: string;
let work: string;
let elsewhere: string;
let ide: IDE;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "outside-ws-"));
  work = path.join(root, "workspace");
  elsewhere = path.join(root, "elsewhere");
  fs.mkdirSync(work);
  fs.mkdirSync(elsewhere);
  const uriPath = (u: string) => new URL(u).pathname;
  const local = (u: string) =>
    path.normalize(
      decodeURIComponent(uriPath(u)).replace(/^\/([a-zA-Z]:)/, "$1"),
    );
  ide = {
    getWorkspaceDirs: async () => [pathToFileURL(work).href],
    fileExists: async (u: string) => fs.existsSync(local(u)),
    readFile: async (u: string) => fs.readFileSync(local(u), "utf8"),
    writeFile: async (u: string, c: string) => {
      fs.mkdirSync(path.dirname(local(u)), { recursive: true });
      fs.writeFileSync(local(u), c);
    },
    openFile: async () => {},
    saveFile: async () => {},
    getCurrentFile: async () => undefined,
    waitForProblems: async () => [],
  } as unknown as IDE;
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const extras = (over: Partial<ToolExtras> = {}) =>
  ({ ide, workspaceDirs: [pathToFileURL(work).href], ...over }) as ToolExtras;

const BS = String.fromCharCode(92);

describe("absoluteLocalUri", () => {
  it("reads absolute paths and leaves relative ones alone", () => {
    expect(
      absoluteLocalUri(["D:", "code", "projecthub", "docs", "x.md"].join(BS)),
    ).toBe("file:///D:/code/projecthub/docs/x.md");
    expect(absoluteLocalUri("D:/temp/y.txt")).toBe("file:///D:/temp/y.txt");
    expect(absoluteLocalUri("/tmp/y.txt")).toBe("file:///tmp/y.txt");
    expect(absoluteLocalUri("src/a.ts")).toBeUndefined();
    expect(absoluteLocalUri("../x.md")).toBeUndefined();
    expect(absoluteLocalUri("https://example.com/a")).toBeUndefined();
    expect(absoluteLocalUri("file:///a/b")).toBe("file:///a/b");
  });
});

describe("a path outside the workspace, without the option", () => {
  it("is not a target for an exact edit", async () => {
    const file = path.join(elsewhere, "a.md");
    fs.writeFileSync(file, "one\n");
    await expect(validateSearchAndReplaceFilepath(file, ide)).rejects.toThrow(
      /does not exist/,
    );
    expect(await resolveRelativePathInDir(file, ide)).toBeUndefined();
  });

  it("a new file at an absolute path outside is not placed there", async () => {
    const target = path.join(elsewhere, "b.md");
    const uri = await inferResolvedUriFromRelativePath(target, ide);
    expect(uri).not.toBe(pathToFileURL(target).href);
    expect(uri.startsWith(pathToFileURL(work).href)).toBe(true);
  });

  it("an absolute path inside the workspace resolves to itself", async () => {
    const inside = path.join(work, "src", "a.ts");
    expect(await inferResolvedUriFromRelativePath(inside, ide)).toBe(
      pathToFileURL(inside).href,
    );
  });

  // It was joined onto the workspace folder (C:/repo/c:/elsewhere/a.md) and
  // the write failed with EINVAL from mkdir
  it("create_new_file refuses it, saying why, and writes nothing", async () => {
    const target = path.join(elsewhere, "refused.md");
    await expect(
      createNewFileImpl({ filepath: target, contents: "x" }, extras()),
    ).rejects.toThrow(/outside the workspace/);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(work)).not.toContain("c:");
  });

  it("create_new_file still writes a relative path", async () => {
    await createNewFileImpl(
      { filepath: "notes/kept.md", contents: "x" },
      extras(),
    );
    expect(fs.existsSync(path.join(work, "notes", "kept.md"))).toBe(true);
  });
});

describe("outsideAbsolutePath", () => {
  const dirs = () => [pathToFileURL(work).href];

  it("finds an absolute path outside, also with an encoded drive colon", () => {
    const outside = path.join(elsewhere, "x.ts");
    expect(outsideAbsolutePath(outside, dirs())).toBeDefined();
    if (/^[a-zA-Z]:/.test(outside)) {
      const encoded = outside
        .replace(/^([a-zA-Z]):/, "$1%3A")
        .replace(/\\/g, "/");
      expect(outsideAbsolutePath(encoded, dirs())).toBeDefined();
    }
  });

  it("is undefined inside the workspace, for relative paths and with no folders", () => {
    expect(
      outsideAbsolutePath(path.join(work, "a.ts"), dirs()),
    ).toBeUndefined();
    expect(outsideAbsolutePath("src/a.ts", dirs())).toBeUndefined();
    expect(outsideAbsolutePath("../x.md", dirs())).toBeUndefined();
    expect(
      outsideAbsolutePath(path.join(elsewhere, "a.ts"), []),
    ).toBeUndefined();
  });
});

describe("with allowOutsideWorkspace (File edits at IDGAF)", () => {
  it("create_new_file writes an absolute path outside and says so", async () => {
    const target = path.join(elsewhere, "projecthub", "docs", "x.md");
    const items = await createNewFileImpl(
      { filepath: target, contents: "hello\n" },
      extras({ allowOutsideWorkspace: true }),
    );
    expect(fs.readFileSync(target, "utf8")).toBe("hello\n");
    expect(items[0].content).toContain("File created");
    expect(items[0].content).toContain("Wrote outside the workspace: ");
    expect(items[0].content).toContain("x.md");
  });

  it("create_new_file inside the workspace carries no outside note", async () => {
    const target = path.join(work, "in.md");
    const items = await createNewFileImpl(
      { filepath: target, contents: "x" },
      extras({ allowOutsideWorkspace: true }),
    );
    expect(fs.existsSync(target)).toBe(true);
    expect(items[0].content).not.toContain("outside the workspace");
  });

  it("create_new_file reaches a `..` climb too", async () => {
    await createNewFileImpl(
      { filepath: "../elsewhere/up.txt", contents: "up" },
      extras({ allowOutsideWorkspace: true }),
    );
    expect(fs.readFileSync(path.join(elsewhere, "up.txt"), "utf8")).toBe("up");
  });

  it("single_find_and_replace edits a file outside", async () => {
    const file = path.join(elsewhere, "s.md");
    fs.writeFileSync(file, "alpha beta\n");
    const items = await singleFindAndReplaceImpl(
      { filepath: file, old_string: "alpha", new_string: "gamma" },
      extras({ allowOutsideWorkspace: true }),
    );
    expect(fs.readFileSync(file, "utf8")).toBe("gamma beta\n");
    expect(items[0].content).toContain("Wrote outside the workspace: ");
  });

  it("multi_edit edits a file outside", async () => {
    const file = path.join(elsewhere, "m.md");
    fs.writeFileSync(file, "a b c\n");
    const items = await multiEditImpl(
      {
        filepath: file,
        edits: [
          { old_string: "a", new_string: "1" },
          { old_string: "c", new_string: "3" },
        ],
      },
      extras({ allowOutsideWorkspace: true }),
    );
    expect(fs.readFileSync(file, "utf8")).toBe("1 b 3\n");
    expect(items[0].content).toContain("Wrote outside the workspace: ");
  });

  it("an edit inside the workspace has no note", async () => {
    const file = path.join(work, "n.md");
    fs.writeFileSync(file, "x\n");
    const items = await singleFindAndReplaceImpl(
      { filepath: "n.md", old_string: "x", new_string: "y" },
      extras({ allowOutsideWorkspace: true }),
    );
    expect(items[0].content).not.toContain("outside the workspace");
  });

  it("a missing file outside is still not found", async () => {
    await expect(
      validateSearchAndReplaceFilepath(path.join(elsewhere, "nope.md"), ide, {
        allowOutside: true,
      }),
    ).rejects.toThrow(/does not exist/);
  });

  it("without the option an exact edit outside still fails", async () => {
    const file = path.join(elsewhere, "keep.md");
    fs.writeFileSync(file, "same\n");
    await expect(
      singleFindAndReplaceImpl(
        { filepath: file, old_string: "same", new_string: "changed" },
        extras(),
      ),
    ).rejects.toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe("same\n");
  });
});
