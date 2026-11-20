import { describe, expect, it } from "vitest";
import { deputyPathHit, type PathFlavor } from "./deputyPaths";

const WIN_HOME = "C:\\Users\\me";
const WIN_WS = "C:\\Users\\me\\proj";
const POSIX_HOME = "/home/me";
const POSIX_WS = "/home/me/proj";

function why(
  raw: string,
  flavor: PathFlavor,
  extra: { resolved?: string; within?: boolean } = {},
) {
  const win = flavor === "win32";
  return deputyPathHit({
    raw,
    flavor,
    home: win ? WIN_HOME : POSIX_HOME,
    cwd: win ? WIN_WS : POSIX_WS,
    resolved: extra.resolved,
    withinWorkspace: extra.within,
    globalDirs: ["~/.continuous", "~/.continue"],
  })?.why;
}

describe("deputyPathHit on Windows paths", () => {
  it.each([
    ["\\\\evil\\share\\a.txt", "network"],
    ["//evil/share/a.txt", "network"],
    ["\\\\?\\C:\\Users\\me\\proj\\a.txt", "network"],
    ["\\\\.\\pipe\\x", "network"],
    ["\\\\?\\UNC\\evil\\share\\a", "network"],
    ["file://evil/share/a.txt", "network"],
    ["NUL", "device"],
    ["src\\con.txt", "device"],
    ["COM1", "device"],
    ["lpt3.log", "device"],
    ["CONIN$", "device"],
    ["notes.txt:hidden", "alias"],
    ["C:\\Users\\me\\proj\\notes.txt::$DATA", "alias"],
    ["readme.md.", "alias"],
    ["src\\a.ts ", "alias"],
    ["src/dir./a.ts", "alias"],
    ["PROGRA~1\\x\\a.txt", "alias"],
    ["~root\\notes", "other-account"],
    ["D:\\elsewhere\\a.txt", "outside-workspace"],
    ["..\\other\\a.txt", "outside-workspace"],
    ["src\\..\\..\\other\\a.txt", "outside-workspace"],
    ["C:\\Users\\me\\projects-other\\a.txt", "outside-workspace"],
    ["C:\\Users\\me\\.continue\\config.yaml", "own-config"],
    ["~\\.continuous\\permissions.yaml", "own-config"],
    ["~/.CONTINUE/rules/x.md", "own-config"],
    ["file:///C:/Users/me/.continue/config.yaml", "own-config"],
  ] as const)("%s is %s", (raw, expected) => {
    expect(why(raw, "win32")).toBe(expected);
  });

  it.each([
    "src\\a.ts",
    "src/a.ts",
    "./a.ts",
    "C:\\Users\\me\\proj\\src\\a.ts",
    // Case differs, and Windows says it is the same folder.
    "c:\\users\\ME\\PROJ\\a.ts",
    "file:///C:/Users/me/proj/a.ts",
    "~/proj/a.ts",
    "HEAD~1",
    "a.b.c",
    ".env.local",
    "src\\..\\a.ts",
  ])("%s is inside and unremarkable", (raw) => {
    expect(why(raw, "win32")).toBeUndefined();
  });

  // Issue #954: VS Code stores the folder as file:///d%3A/..., which uriToPath
  // reads as /d:/... A write of that same folder with the other slash, a
  // capital drive letter, or a trailing separator is not outside it.
  it("a Windows path that differs only by slash, drive letter or a trailing separator is inside", () => {
    const cwd = "/d:/Qsync/VBNETProjects/Kuid Lister";
    const inside = [
      ".gitignore-python",
      "D:\\Qsync\\VBNETProjects\\Kuid Lister\\.gitignore-python",
      "D:/Qsync/VBNETProjects/Kuid Lister/.gitignore-python",
      "file:///D:/Qsync/VBNETProjects/Kuid%20Lister/.gitignore-python",
    ];
    for (const root of [
      cwd,
      `${cwd}/`,
      "d:\\Qsync\\VBNETProjects\\Kuid Lister\\",
    ]) {
      for (const raw of inside) {
        expect(
          deputyPathHit({
            raw,
            flavor: "win32",
            home: WIN_HOME,
            cwd: root,
            roots: [root],
            globalDirs: ["~/.continuous"],
          })?.why,
          `${raw} against ${root}`,
        ).toBeUndefined();
      }
    }
    expect(
      deputyPathHit({
        raw: "D:\\elsewhere\\secret.txt",
        flavor: "win32",
        home: WIN_HOME,
        cwd,
        roots: [cwd],
      })?.why,
    ).toBe("outside-workspace");
    expect(
      deputyPathHit({
        raw: "D:\\Qsync\\VBNETProjects\\Kuid Lister Evil\\x",
        flavor: "win32",
        home: WIN_HOME,
        cwd,
        roots: [cwd],
      })?.why,
    ).toBe("outside-workspace");
  });
});

describe("deputyPathHit on POSIX paths", () => {
  it.each([
    ["/etc/hosts", "outside-workspace"],
    ["../other/a.txt", "outside-workspace"],
    ["src/../../other/a.txt", "outside-workspace"],
    ["/home/me/projects-other/a.txt", "outside-workspace"],
    // A different case is a different folder here; asking is the safe side.
    ["/home/me/PROJ/a.txt", "outside-workspace"],
    ["/dev/stdin", "device"],
    ["/proc/self/environ", "device"],
    ["/sys/kernel/x", "device"],
    ["~root/.bashrc", "other-account"],
    ["~/.continue/config.yaml", "own-config"],
    ["/home/me/.continuous/permissions.yaml", "own-config"],
    ["file://evil/share/a", "network"],
  ] as const)("%s is %s", (raw, expected) => {
    expect(why(raw, "posix")).toBe(expected);
  });

  it.each([
    // Only a Windows host reads these as something other than a file name.
    "notes.txt:hidden",
    "NUL",
    "con.txt",
    "readme.md.",
    "PROGRA~1/a",
    "a\\b.txt",
    "src/a.ts",
    "/home/me/proj/src/a.ts",
    "~/proj/a.ts",
    "src/../a.ts",
  ])("%s is an ordinary file name", (raw) => {
    expect(why(raw, "posix")).toBeUndefined();
  });
});

describe("deputyPathHit with the tool's own answer", () => {
  it("a real path outside the workspace asks even when the written path looks inside", () => {
    // The jail-makes-a-symlink shape: `link/out.txt` is written, /etc/cron.d/out.txt is reached.
    expect(
      why("link/out.txt", "posix", {
        resolved: "/etc/cron.d/out.txt",
        within: false,
      }),
    ).toBe("outside-workspace");
    expect(
      why("link\\out.txt", "win32", {
        resolved: "D:\\real\\out.txt",
        within: false,
      }),
    ).toBe("outside-workspace");
  });

  it("the tool's answer wins over a lexical guess in a multi-root workspace", () => {
    expect(
      why("/home/me/other-root/a.txt", "posix", { within: true }),
    ).toBeUndefined();
  });

  it("a real path inside the global folder asks even from a link elsewhere", () => {
    expect(
      why("link/config.yaml", "posix", {
        resolved: "/home/me/.continue/config.yaml",
        within: true,
      }),
    ).toBe("own-config");
  });

  it("says nothing without a workspace to compare to", () => {
    expect(
      deputyPathHit({ raw: "a.txt", flavor: "posix", home: POSIX_HOME }),
    ).toBeUndefined();
  });

  it("judges the same text the same on both flavors where they agree", () => {
    for (const raw of ["/etc/passwd", "../x"]) {
      expect(why(raw, "posix")).toBe("outside-workspace");
    }
  });

  it("a workspace inside the global folder is the person's choice", () => {
    expect(
      deputyPathHit({
        raw: "/home/me/.continue/worktree/a.ts",
        flavor: "posix",
        home: POSIX_HOME,
        cwd: "/home/me/.continue/worktree",
        globalDirs: ["~/.continue"],
      }),
    ).toBeUndefined();
  });
});
