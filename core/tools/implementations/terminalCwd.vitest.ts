import * as nodePath from "node:path";
import { describe, expect, it } from "vitest";
import {
  effectiveCwdForPolicy,
  isInsideFolder,
  resolveRequestedCwd,
  type CwdFacts,
} from "./terminalCwd";

/** A small tree: folders (true) and a link that leads out of the workspace. */
function facts(
  flavor: "posix" | "win32",
  tree: Record<string, true | { link: string }>,
  roots: string[],
): CwdFacts {
  const path = flavor === "win32" ? nodePath.win32 : nodePath.posix;
  const norm = (p: string) =>
    flavor === "win32" ? path.normalize(p).toLowerCase() : path.normalize(p);
  const table = new Map(Object.entries(tree).map(([k, v]) => [norm(k), v]));
  const realpath = (p: string): string => {
    let cur = path.normalize(p);
    for (let i = 0; i < 8; i++) {
      const entry = table.get(norm(cur));
      if (!entry) throw new Error("ENOENT");
      if (entry === true) return cur;
      cur = entry.link;
    }
    throw new Error("loop");
  };
  return {
    defaultCwd: roots[0],
    workspaceRoots: roots,
    realpath,
    isDirectory: (p) => table.get(norm(p)) === true,
    path,
  };
}

const POSIX = facts(
  "posix",
  {
    "/work/app": true,
    "/work/app/core": true,
    "/work/app/core/tools": true,
    "/work/app/gui": true,
    "/work/other": true,
    "/work/app/escape": { link: "/etc" },
    "/work/app/inside": { link: "/work/app/gui" },
    "/etc": true,
    "/work/app/file.txt": { link: "/work/app/file.txt" },
  },
  ["/work/app"],
);

describe("resolveRequestedCwd", () => {
  it("no cwd means where the call runs by default", () => {
    for (const none of [undefined, null, "", "   "]) {
      expect(resolveRequestedCwd(none, POSIX)).toEqual({
        ok: true,
        cwd: "/work/app",
        requested: false,
      });
    }
  });

  it("a sub-folder, relative to the workspace folder", () => {
    expect(resolveRequestedCwd("core", POSIX)).toEqual({
      ok: true,
      cwd: "/work/app/core",
      requested: true,
    });
    expect(resolveRequestedCwd("core/tools", POSIX)).toMatchObject({
      ok: true,
      cwd: "/work/app/core/tools",
    });
    expect(resolveRequestedCwd("./gui/", POSIX)).toMatchObject({
      ok: true,
      cwd: "/work/app/gui",
    });
  });

  it("an absolute path inside the workspace", () => {
    expect(resolveRequestedCwd("/work/app/gui", POSIX)).toMatchObject({
      ok: true,
      cwd: "/work/app/gui",
    });
  });

  it("the workspace folder itself", () => {
    expect(resolveRequestedCwd(".", POSIX)).toMatchObject({
      ok: true,
      cwd: "/work/app",
      requested: true,
    });
  });

  it("refuses a folder outside the workspace, by .. or by absolute path", () => {
    for (const bad of [
      "..",
      "../other",
      "/work/other",
      "/etc",
      "core/../../other",
    ]) {
      const r = resolveRequestedCwd(bad, POSIX);
      expect(r.ok, bad).toBe(false);
      if (!r.ok)
        expect(r.error).toMatch(/outside the workspace|does not exist/);
    }
  });

  it("refuses a link that leads out of the workspace", () => {
    const r = resolveRequestedCwd("escape", POSIX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("outside the workspace");
  });

  it("follows a link that stays inside, and reports the real folder", () => {
    expect(resolveRequestedCwd("inside", POSIX)).toMatchObject({
      ok: true,
      cwd: "/work/app/gui",
    });
  });

  it("refuses a folder that does not exist and a path that is not a folder", () => {
    const missing = resolveRequestedCwd("nope", POSIX);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("does not exist");
    const file = resolveRequestedCwd("file.txt", POSIX);
    expect(file.ok).toBe(false);
  });

  it("refuses a non-string and a path with a NUL", () => {
    expect(resolveRequestedCwd(42, POSIX).ok).toBe(false);
    expect(resolveRequestedCwd({}, POSIX).ok).toBe(false);
    expect(resolveRequestedCwd("core\0x", POSIX).ok).toBe(false);
  });

  it("a sibling that shares the workspace folder's name prefix is outside", () => {
    const f = facts("posix", { "/work/app": true, "/work/app-two": true }, [
      "/work/app",
    ]);
    const r = resolveRequestedCwd("/work/app-two", f);
    expect(r.ok).toBe(false);
  });

  it("works with several workspace folders", () => {
    const f = facts(
      "posix",
      { "/a": true, "/a/x": true, "/b": true, "/b/y": true, "/c": true },
      ["/a", "/b"],
    );
    expect(resolveRequestedCwd("/b/y", f)).toMatchObject({
      ok: true,
      cwd: "/b/y",
    });
    expect(resolveRequestedCwd("x", f)).toMatchObject({
      ok: true,
      cwd: "/a/x",
    });
    expect(resolveRequestedCwd("/c", f).ok).toBe(false);
  });
});

describe("resolveRequestedCwd with Windows paths", () => {
  const WIN = facts(
    "win32",
    {
      "C:\\work\\app": true,
      "C:\\work\\app\\core": true,
      "C:\\work\\app\\gui": true,
      "C:\\work\\other": true,
      "D:\\work\\app": true,
    },
    ["C:\\work\\app"],
  );

  it("resolves relative paths with either slash", () => {
    expect(resolveRequestedCwd("core", WIN)).toMatchObject({ ok: true });
    expect(resolveRequestedCwd("core\\", WIN)).toMatchObject({ ok: true });
    expect(resolveRequestedCwd("./gui", WIN)).toMatchObject({ ok: true });
  });

  it("is not case sensitive, as the file system is not", () => {
    expect(resolveRequestedCwd("C:\\WORK\\APP\\core", WIN)).toMatchObject({
      ok: true,
    });
    expect(resolveRequestedCwd("CORE", WIN)).toMatchObject({ ok: true });
  });

  it("refuses another folder, another drive, and .. out of the workspace", () => {
    for (const bad of ["..", "..\\other", "C:\\work\\other", "D:\\work\\app"]) {
      expect(resolveRequestedCwd(bad, WIN).ok, bad).toBe(false);
    }
  });
});

describe("isInsideFolder", () => {
  it("is true for the folder itself and anything below it", () => {
    expect(isInsideFolder("/a", "/a")).toBe(true);
    expect(isInsideFolder("/a", "/a/b/c")).toBe(true);
  });
  it("is false for a sibling, a parent, and a longer name with the same start", () => {
    expect(isInsideFolder("/a", "/b")).toBe(false);
    expect(isInsideFolder("/a/b", "/a")).toBe(false);
    expect(isInsideFolder("/a", "/ab")).toBe(false);
  });
});

describe("effectiveCwdForPolicy", () => {
  it("is the requested folder when valid, and the default otherwise, never throwing", () => {
    expect(effectiveCwdForPolicy("core", POSIX)).toBe("/work/app/core");
    expect(effectiveCwdForPolicy(undefined, POSIX)).toBe("/work/app");
    expect(effectiveCwdForPolicy("../other", POSIX)).toBe("/work/app");
    expect(effectiveCwdForPolicy(7, POSIX)).toBe("/work/app");
    expect(effectiveCwdForPolicy("escape", POSIX)).toBe("/work/app");
  });
});
