import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearAdditionalFoldersCacheForTests,
  MAX_ADDITIONAL_FOLDERS,
  parseAdditionalFolders,
  readUserAdditionalFolders,
  withAdditionalFolders,
  type FolderFacts,
} from "./additionalFolders";
import { stripUntrustedLoosening } from "./trust";

/** An in-memory tree of folders (true), files (false) and links, per path flavour. */
function facts(
  flavor: "posix" | "win32",
  tree: Record<string, boolean | { link: string }>,
  home: string,
  protectedRoots: string[] = [],
): FolderFacts {
  const path = flavor === "win32" ? nodePath.win32 : nodePath.posix;
  const norm = (p: string) =>
    flavor === "win32" ? path.normalize(p).toLowerCase() : path.normalize(p);
  const table = new Map(Object.entries(tree).map(([k, v]) => [norm(k), v]));
  const resolve = (p: string): string => {
    let cur = path.normalize(p);
    for (let i = 0; i < 8; i++) {
      const e = table.get(norm(cur));
      if (e === undefined) throw new Error("ENOENT");
      if (typeof e === "object") cur = e.link;
      else return cur;
    }
    throw new Error("loop");
  };
  return {
    home,
    path,
    protectedRoots,
    realpath: resolve,
    isDirectory: (p) => table.get(norm(p)) === true,
  };
}

const POSIX = facts(
  "posix",
  {
    "/": true,
    "/home": true,
    "/home/me": true,
    "/home/me/src": true,
    "/home/me/src/shared": true,
    "/home/me/src/other": true,
    "/home/me/.continuous": true,
    "/home/me/notes.txt": false,
    "/data": true,
    "/data/docs": true,
    "/link-to-shared": { link: "/home/me/src/shared" },
    "/link-to-home": { link: "/home/me" },
  },
  "/home/me",
  ["/home/me/.continuous"],
);

describe("parseAdditionalFolders", () => {
  it("keeps absolute folders that exist", () => {
    expect(
      parseAdditionalFolders(["/home/me/src/shared", "/data/docs"], POSIX),
    ).toEqual({
      folders: ["/home/me/src/shared", "/data/docs"],
      rejected: [],
    });
  });

  it("expands ~ to the home folder", () => {
    expect(
      parseAdditionalFolders(["~/src/shared", "~\\src\\other"], POSIX).folders,
    ).toEqual(["/home/me/src/shared", "/home/me/src/other"]);
  });

  it("resolves a link to the folder it leads to", () => {
    expect(parseAdditionalFolders(["/link-to-shared"], POSIX).folders).toEqual([
      "/home/me/src/shared",
    ]);
  });

  it("says nothing for an absent or empty setting", () => {
    expect(parseAdditionalFolders(undefined, POSIX)).toEqual({
      folders: [],
      rejected: [],
    });
    expect(parseAdditionalFolders(null, POSIX)).toEqual({
      folders: [],
      rejected: [],
    });
    expect(parseAdditionalFolders([], POSIX)).toEqual({
      folders: [],
      rejected: [],
    });
  });

  it("rejects a value that is not a list", () => {
    const r = parseAdditionalFolders("/data/docs", POSIX);
    expect(r.folders).toEqual([]);
    expect(r.rejected[0].reason).toContain("not a list");
  });

  it("rejects what is not a path, a relative path, a missing path and a file", () => {
    const r = parseAdditionalFolders(
      [42, "", "  ", "src/shared", "/nope", "/home/me/notes.txt"],
      POSIX,
    );
    expect(r.folders).toEqual([]);
    const reasons = r.rejected.map((x) => x.reason);
    expect(reasons.filter((x) => x.includes("not a path")).length).toBe(3);
    expect(reasons).toContain("it is not an absolute path");
    expect(reasons).toContain("it does not exist");
    expect(reasons).toContain("it is not a folder");
  });

  it("rejects the filesystem root, the home folder and a folder that contains it", () => {
    for (const bad of ["/", "/home", "/home/me", "~", "/link-to-home"]) {
      const r = parseAdditionalFolders([bad], POSIX);
      expect(r.folders, bad).toEqual([]);
      expect(r.rejected[0].reason, bad).toMatch(/root|home folder/);
    }
  });

  it("rejects the product's own folders, and anything that contains them", () => {
    const r = parseAdditionalFolders(["/home/me/.continuous"], POSIX);
    expect(r.folders).toEqual([]);
    expect(r.rejected[0].reason).toContain("product's own");
  });

  it("lists a folder once however it is spelled", () => {
    const r = parseAdditionalFolders(
      ["/home/me/src/shared", "~/src/shared", "/link-to-shared"],
      POSIX,
    );
    expect(r.folders).toEqual(["/home/me/src/shared"]);
    expect(r.rejected).toEqual([]);
  });

  it("uses at most the limit and says which entries it left out", () => {
    const tree: Record<string, boolean> = { "/": true, "/home/me": true };
    const entries: string[] = [];
    for (let i = 0; i < MAX_ADDITIONAL_FOLDERS + 3; i++) {
      tree[`/proj${i}`] = true;
      entries.push(`/proj${i}`);
    }
    const r = parseAdditionalFolders(entries, facts("posix", tree, "/home/me"));
    expect(r.folders.length).toBe(MAX_ADDITIONAL_FOLDERS);
    expect(r.rejected.length).toBe(3);
    expect(r.rejected[0].reason).toContain(`${MAX_ADDITIONAL_FOLDERS}`);
  });
});

describe("parseAdditionalFolders with Windows paths", () => {
  const WIN = facts(
    "win32",
    {
      "C:\\": true,
      "C:\\Users": true,
      "C:\\Users\\me": true,
      "D:\\": true,
      "D:\\work": true,
      "D:\\work\\shared": true,
    },
    "C:\\Users\\me",
  );

  it("keeps a folder on another drive, in either slash and any case", () => {
    expect(parseAdditionalFolders(["D:\\work\\shared"], WIN).folders).toEqual([
      "D:\\work\\shared",
    ]);
    expect(parseAdditionalFolders(["d:/WORK/shared"], WIN).folders.length).toBe(
      1,
    );
  });

  it("rejects a drive root, the home folder and the Users folder", () => {
    for (const bad of ["C:\\", "D:\\", "C:\\Users\\me", "C:\\Users"]) {
      expect(parseAdditionalFolders([bad], WIN).folders, bad).toEqual([]);
    }
  });

  it("lists a folder once whatever its case", () => {
    const r = parseAdditionalFolders(
      ["D:\\work\\shared", "d:\\WORK\\SHARED"],
      WIN,
    );
    expect(r.folders.length).toBe(process.platform === "win32" ? 1 : 2);
  });
});

describe("withAdditionalFolders", () => {
  it("appends file URIs to a list of URIs, after the workspace", () => {
    const out = withAdditionalFolders(
      ["file:///work/app"],
      ["/home/me/src/shared"],
    );
    expect(out[0]).toBe("file:///work/app");
    expect(out[1]).toBe(pathToFileURL("/home/me/src/shared").href);
    expect(out.length).toBe(2);
  });

  it("appends plain paths to a list of plain paths", () => {
    expect(withAdditionalFolders(["/work/app"], ["/data/docs"])).toEqual([
      "/work/app",
      "/data/docs",
    ]);
  });

  it("changes nothing without additional folders, and does not alter its input", () => {
    const dirs = ["file:///work/app"];
    expect(withAdditionalFolders(dirs, [])).toEqual(dirs);
    withAdditionalFolders(dirs, ["/x"]);
    expect(dirs).toEqual(["file:///work/app"]);
  });

  it("adds a folder that is already a workspace folder only once", () => {
    const uri = pathToFileURL("/work/app").href;
    expect(withAdditionalFolders([uri], ["/work/app"])).toEqual([uri]);
    expect(withAdditionalFolders(["/work/app"], ["/work/app"])).toEqual([
      "/work/app",
    ]);
  });

  it("keeps the first folder first, so the folder commands run in does not change", () => {
    const out = withAdditionalFolders(["/a", "/b"], ["/c"]);
    expect(out[0]).toBe("/a");
  });

  it("starts the list when the workspace is empty", () => {
    expect(withAdditionalFolders([], ["/data/docs"])).toEqual(["/data/docs"]);
  });
});

describe("readUserAdditionalFolders", () => {
  let dir: string;
  beforeEach(() => {
    clearAdditionalFoldersCacheForTests();
    dir = fs.realpathSync.native(
      fs.mkdtempSync(nodePath.join(os.tmpdir(), "addfolders-")),
    );
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (text: string) => {
    const file = nodePath.join(dir, "config.yaml");
    fs.writeFileSync(file, text);
    return file;
  };

  it("reads the folders from toolPermissions.auto.environment", () => {
    const shared = nodePath.join(dir, "shared");
    fs.mkdirSync(shared);
    const file = write(
      `toolPermissions:\n  auto:\n    environment:\n      additionalFolders:\n        - ${JSON.stringify(shared)}\n`,
    );
    expect(readUserAdditionalFolders(file)).toEqual([shared]);
  });

  it("is empty for a missing file, a file without the key, and invalid YAML", () => {
    expect(readUserAdditionalFolders(nodePath.join(dir, "none.yaml"))).toEqual(
      [],
    );
    expect(readUserAdditionalFolders(write("name: x\n"))).toEqual([]);
    expect(readUserAdditionalFolders(write("a: [unclosed"))).toEqual([]);
  });

  it("drops entries that do not exist or are the home folder, and keeps the rest", () => {
    const shared = nodePath.join(dir, "shared");
    fs.mkdirSync(shared);
    const file = write(
      `toolPermissions:\n  auto:\n    environment:\n      additionalFolders:\n        - ${JSON.stringify(shared)}\n        - ${JSON.stringify(nodePath.join(dir, "gone"))}\n        - ${JSON.stringify(os.homedir())}\n`,
    );
    expect(readUserAdditionalFolders(file)).toEqual([shared]);
  });

  it("notices the file changing", () => {
    const a = nodePath.join(dir, "a");
    const b = nodePath.join(dir, "b");
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    const file = write(
      `toolPermissions:\n  auto:\n    environment:\n      additionalFolders: [${JSON.stringify(a)}]\n`,
    );
    expect(readUserAdditionalFolders(file)).toEqual([a]);
    write(
      `toolPermissions:\n  auto:\n    environment:\n      additionalFolders: [${JSON.stringify(a)}, ${JSON.stringify(b)}]\n`,
    );
    // a different size is enough to refresh, as for the other user limits
    expect(readUserAdditionalFolders(file)).toEqual([a, b]);
  });
});

describe("a repository cannot add a folder", () => {
  it("the key is removed from a workspace configuration, with a notice naming it", () => {
    const { config, removed } = stripUntrustedLoosening({
      toolPermissions: {
        deny: ["x"],
        auto: {
          environment: { additionalFolders: ["/etc"], trustedDomains: [] },
        },
      },
    });
    expect(removed).toContain(
      "toolPermissions.auto.environment.additionalFolders",
    );
    expect(JSON.stringify(config)).not.toContain("additionalFolders");
    // what a repository may do, tighten, is kept
    expect(JSON.stringify(config)).toContain('"deny":["x"]');
  });
});
