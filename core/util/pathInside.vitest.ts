import { describe, expect, it } from "vitest";
import {
  isAbsoluteAnyStyle,
  isPosixAbsolute,
  isWindowsAbsolute,
  posixPathInside,
  windowsPathInside,
} from "./pathInside";

describe("isPosixAbsolute", () => {
  it("is true for a path that starts with a slash", () => {
    expect(isPosixAbsolute("/")).toBe(true);
    expect(isPosixAbsolute("/home/u")).toBe(true);
    expect(isPosixAbsolute("//server/share")).toBe(true);
  });
  it("is false for anything else", () => {
    for (const p of ["", "a", "a/b", "./a", "../a", "C:/a", "C:\\a", "\\a"]) {
      expect(isPosixAbsolute(p), p).toBe(false);
    }
  });
});

describe("isWindowsAbsolute", () => {
  it("is true for a drive path in either slash direction, in either case", () => {
    for (const p of ["C:\\a", "c:/a", "D:\\", "z:/", "C:", "C:a"]) {
      expect(isWindowsAbsolute(p), p).toBe(true);
    }
  });
  it("is true for a UNC or rooted path", () => {
    for (const p of ["\\\\server\\share", "//server/share", "\\a", "/a"]) {
      expect(isWindowsAbsolute(p), p).toBe(true);
    }
  });
  it("is false for a relative path", () => {
    for (const p of ["", "a", "a\\b", "a/b", ".\\a", "..\\a", "1:a"]) {
      expect(isWindowsAbsolute(p), p).toBe(false);
    }
  });
});

describe("isAbsoluteAnyStyle", () => {
  it("is true if either style says so", () => {
    expect(isAbsoluteAnyStyle("/a")).toBe(true);
    expect(isAbsoluteAnyStyle("C:\\a")).toBe(true);
    expect(isAbsoluteAnyStyle("\\\\s\\x")).toBe(true);
  });
  it("is false for a relative path", () => {
    expect(isAbsoluteAnyStyle("src/a.ts")).toBe(false);
    expect(isAbsoluteAnyStyle("")).toBe(false);
  });
});

describe("windowsPathInside", () => {
  const P = "D:\\Qsync\\VBNETProjects\\Kuid Lister";

  it("a file in the folder, and the folder itself", () => {
    expect(windowsPathInside(P, `${P}\\a.txt`)).toBe(true);
    expect(windowsPathInside(P, `${P}\\sub\\deep\\a.txt`)).toBe(true);
    expect(windowsPathInside(P, P)).toBe(true);
  });

  it("slash direction, drive-letter case, name case and a trailing separator make no difference", () => {
    expect(
      windowsPathInside(P, "d:/qsync/vbnetprojects/kuid lister/a.txt"),
    ).toBe(true);
    expect(windowsPathInside(`${P}\\`, `${P}\\a.txt`)).toBe(true);
    expect(windowsPathInside(P, `${P}\\\\a.txt`)).toBe(true);
    expect(windowsPathInside("d:/Qsync", "D:\\QSYNC\\x")).toBe(true);
  });

  it("resolves . and .. before comparing", () => {
    expect(windowsPathInside(P, `${P}\\sub\\..\\a.txt`)).toBe(true);
    expect(windowsPathInside(P, `${P}\\.\\a.txt`)).toBe(true);
    expect(windowsPathInside(P, `${P}\\..\\secret.txt`)).toBe(false);
    expect(windowsPathInside(P, `${P}\\sub\\..\\..\\secret.txt`)).toBe(false);
  });

  it("a sibling that only shares a prefix is outside", () => {
    expect(
      windowsPathInside(P, "D:\\Qsync\\VBNETProjects\\Kuid Lister Evil\\a"),
    ).toBe(false);
    expect(windowsPathInside("C:\\a\\b", "C:\\a\\bc")).toBe(false);
  });

  it("a parent is not inside its child", () => {
    expect(windowsPathInside(`${P}\\sub`, P)).toBe(false);
    expect(windowsPathInside(`${P}\\sub`, "D:\\")).toBe(false);
  });

  it("a different drive is outside", () => {
    expect(
      windowsPathInside(P, "C:\\Qsync\\VBNETProjects\\Kuid Lister\\a"),
    ).toBe(false);
  });

  it("a drive root contains everything on that drive and nothing on another", () => {
    expect(windowsPathInside("C:\\", "C:\\Windows\\a")).toBe(true);
    expect(windowsPathInside("C:/", "c:\\x")).toBe(true);
    expect(windowsPathInside("C:\\", "D:\\x")).toBe(false);
  });

  it("UNC shares: inside the same share, outside another share or host", () => {
    const share = "\\\\server\\share\\proj";
    expect(windowsPathInside(share, `${share}\\a.txt`)).toBe(true);
    expect(windowsPathInside(share, "//SERVER/Share/proj/a.txt")).toBe(true);
    expect(windowsPathInside(share, "\\\\server\\other\\proj\\a.txt")).toBe(
      false,
    );
    expect(windowsPathInside(share, "\\\\other\\share\\proj\\a.txt")).toBe(
      false,
    );
    expect(windowsPathInside(share, "C:\\proj\\a.txt")).toBe(false);
  });

  it("climbing above the root stays at the root", () => {
    expect(windowsPathInside("C:\\", "C:\\..\\..\\x")).toBe(true);
    expect(windowsPathInside("C:\\a", "C:\\..\\x")).toBe(false);
  });

  it("empty and odd input does not throw", () => {
    expect(() => windowsPathInside("", "")).not.toThrow();
    expect(() => windowsPathInside("C:", "C:")).not.toThrow();
    expect(windowsPathInside("C:\\a", "")).toBe(false);
  });
});

describe("posixPathInside", () => {
  it("a file in the folder, and the folder itself", () => {
    expect(posixPathInside("/home/u/proj", "/home/u/proj/a.ts")).toBe(true);
    expect(posixPathInside("/home/u/proj", "/home/u/proj/x/y/a.ts")).toBe(true);
    expect(posixPathInside("/home/u/proj", "/home/u/proj")).toBe(true);
  });

  it("a trailing slash, repeated slashes and . make no difference", () => {
    expect(posixPathInside("/home/u/proj/", "/home/u/proj/a.ts")).toBe(true);
    expect(posixPathInside("/home/u/proj", "/home/u//proj/./a.ts")).toBe(true);
  });

  it("resolves .. before comparing", () => {
    expect(posixPathInside("/home/u/proj", "/home/u/proj/x/../a.ts")).toBe(
      true,
    );
    expect(posixPathInside("/home/u/proj", "/home/u/proj/../secret")).toBe(
      false,
    );
    expect(posixPathInside("/home/u/proj", "/home/u/proj/x/../../secret")).toBe(
      false,
    );
  });

  it("is case-sensitive: POSIX names that differ by case are different", () => {
    expect(posixPathInside("/home/u/proj", "/home/u/Proj/a.ts")).toBe(false);
  });

  it("a sibling that only shares a prefix is outside", () => {
    expect(posixPathInside("/home/u/proj", "/home/u/project/a.ts")).toBe(false);
  });

  it("a parent is not inside its child", () => {
    expect(posixPathInside("/home/u/proj/sub", "/home/u/proj")).toBe(false);
  });

  it("the root contains every absolute path", () => {
    expect(posixPathInside("/", "/etc/passwd")).toBe(true);
    expect(posixPathInside("/", "/")).toBe(true);
  });

  it("climbing above the root stays at the root", () => {
    expect(posixPathInside("/", "/../../etc")).toBe(true);
    expect(posixPathInside("/a", "/../b")).toBe(false);
  });

  it("an absolute path is never inside a relative one, or the other way round", () => {
    expect(posixPathInside("proj", "/proj/a")).toBe(false);
    expect(posixPathInside("/proj", "proj/a")).toBe(false);
  });

  it("relative paths: a leading .. is kept, so ../x is not x", () => {
    expect(posixPathInside("proj", "proj/a.ts")).toBe(true);
    expect(posixPathInside("proj", "../proj/a.ts")).toBe(false);
    expect(posixPathInside("../proj", "../proj/a.ts")).toBe(true);
    expect(posixPathInside("proj", "other/../proj/a.ts")).toBe(true);
    expect(posixPathInside("proj", "proj/../../x")).toBe(false);
  });

  it("empty input does not throw", () => {
    expect(() => posixPathInside("", "")).not.toThrow();
    expect(posixPathInside("", "")).toBe(true);
  });
});
