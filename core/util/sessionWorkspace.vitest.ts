import { describe, expect, it } from "vitest";

import {
  flattenSessionGroups,
  groupSessionsByWorkspace,
  isCaseInsensitivePlatform,
  newestSessionInWorkspace,
  normalizeWorkspacePath,
  sessionMatchesWorkspace,
  shortWorkspaceLabel,
  workspaceDisplayPath,
} from "./sessionWorkspace";

interface S {
  id: string;
  dir: string;
  t: number;
}

const accessors = {
  getDirectory: (s: S) => s.dir,
  getTime: (s: S) => s.t,
};

describe("normalizeWorkspacePath", () => {
  it("makes slashes, trailing separators and dot segments agree", () => {
    expect(normalizeWorkspacePath("C:\\Repo\\proj\\")).toBe("c:/Repo/proj");
    expect(normalizeWorkspacePath("c:/Repo//proj/./src/..")).toBe(
      "c:/Repo/proj",
    );
    expect(normalizeWorkspacePath("/home/me/proj/")).toBe("/home/me/proj");
    expect(normalizeWorkspacePath("/")).toBe("/");
    expect(normalizeWorkspacePath("C:\\")).toBe("c:/");
  });

  it("ignores case only when asked", () => {
    expect(normalizeWorkspacePath("C:\\Repo\\Proj", true)).toBe("c:/repo/proj");
    expect(normalizeWorkspacePath("/Users/Me/Proj", false)).toBe(
      "/Users/Me/Proj",
    );
  });

  it("turns the IDE's file URIs into the CLI's paths", () => {
    expect(normalizeWorkspacePath("file:///c%3A/Repo/proj", true)).toBe(
      normalizeWorkspacePath("C:\\Repo\\proj", true),
    );
    expect(normalizeWorkspacePath("file:///home/me/proj")).toBe(
      "/home/me/proj",
    );
    expect(normalizeWorkspacePath("file://server/share/proj")).toBe(
      "//server/share/proj",
    );
  });

  it("keeps the scheme and host of other URIs", () => {
    expect(
      normalizeWorkspacePath("vscode-remote://ssh-remote+box/home/me/proj/"),
    ).toBe("vscode-remote://ssh-remote+box/home/me/proj");
  });

  it("knows which platforms ignore case", () => {
    expect(isCaseInsensitivePlatform("win32")).toBe(true);
    expect(isCaseInsensitivePlatform("darwin")).toBe(true);
    expect(isCaseInsensitivePlatform("linux")).toBe(false);
  });
});

describe("sessionMatchesWorkspace", () => {
  it("matches the same folder written differently", () => {
    expect(
      sessionMatchesWorkspace("C:\\Repo\\Proj\\", ["file:///c%3A/repo/proj"], {
        caseInsensitive: true,
      }),
    ).toBe(true);
    expect(
      sessionMatchesWorkspace("/home/me/Proj", ["/home/me/proj"], {
        caseInsensitive: false,
      }),
    ).toBe(false);
  });

  it("matches a subfolder either way", () => {
    expect(
      sessionMatchesWorkspace("/home/me/code/proj", ["/home/me/code/proj/src"]),
    ).toBe(true);
    expect(
      sessionMatchesWorkspace("/home/me/code/proj/src", ["/home/me/code/proj"]),
    ).toBe(true);
    // A sibling that only shares a prefix is not inside
    expect(
      sessionMatchesWorkspace("/home/me/code/proj-old", ["/home/me/code/proj"]),
    ).toBe(false);
  });

  it("does not let the home folder or a shallow folder contain everything", () => {
    expect(sessionMatchesWorkspace("/home/me", ["/home/me/code/proj"])).toBe(
      false,
    );
    expect(sessionMatchesWorkspace("/", ["/home/me/code/proj"])).toBe(false);
    expect(
      sessionMatchesWorkspace("/srv/a/b", ["/srv/a/b/c"], {
        homeDir: "/srv/a/b",
      }),
    ).toBe(false);
    // ...but the same folder still matches
    expect(sessionMatchesWorkspace("/home/me", ["/home/me/"])).toBe(true);
  });

  it("matches folders of the same git repository", () => {
    const gitRootOf = (dir: string) =>
      dir.replace(/\\/g, "/").startsWith("/w/repo") ? "/w/repo" : undefined;
    expect(
      sessionMatchesWorkspace("/w/repo/packages/a", ["/w/repo/packages/b"], {
        gitRootOf,
      }),
    ).toBe(true);
    expect(
      sessionMatchesWorkspace("/w/other", ["/w/repo/packages/b"], {
        gitRootOf,
      }),
    ).toBe(false);
  });

  it("matches any folder of a multi-root workspace", () => {
    expect(
      sessionMatchesWorkspace("file:///home/me/code/two", [
        "file:///home/me/code/one",
        "file:///home/me/code/two",
      ]),
    ).toBe(true);
  });

  it("never matches a session without a folder", () => {
    expect(sessionMatchesWorkspace("", ["/home/me/code/proj"])).toBe(false);
    expect(sessionMatchesWorkspace(undefined, ["/home/me/code/proj"])).toBe(
      false,
    );
  });
});

describe("shortWorkspaceLabel", () => {
  it("uses ~ below the home folder and the last two names elsewhere", () => {
    expect(shortWorkspaceLabel("/home/me/code/proj", "/home/me")).toBe(
      "~/code/proj",
    );
    expect(shortWorkspaceLabel("C:\\Users\\Me\\proj", "c:\\users\\me")).toBe(
      "~/proj",
    );
    expect(shortWorkspaceLabel("/srv/www/site/app")).toBe("…/site/app");
    expect(shortWorkspaceLabel("file:///c%3A/code/proj")).toBe("…/code/proj");
    expect(workspaceDisplayPath("file:///c%3A/code/proj")).toBe("c:/code/proj");
  });
});

describe("groupSessionsByWorkspace", () => {
  const sessions: S[] = [
    { id: "other-new", dir: "/home/me/code/other", t: 50 },
    { id: "here-old", dir: "/home/me/code/proj", t: 10 },
    { id: "nofolder", dir: "", t: 99 },
    { id: "third", dir: "/home/me/code/third", t: 30 },
    { id: "here-new", dir: "/home/me/code/proj/src", t: 40 },
    { id: "other-old", dir: "/home/me/code/other/", t: 5 },
  ];

  it("puts this workspace first, newest at the very top, others by their newest, no folder last", () => {
    const groups = groupSessionsByWorkspace(sessions, {
      ...accessors,
      workspaceDirs: ["/home/me/code/proj"],
      homeDir: "/home/me",
    });
    expect(groups.map((g) => [g.label, g.isCurrent])).toEqual([
      ["~/code/proj", true],
      ["~/code/other", false],
      ["~/code/third", false],
      ["No folder", false],
    ]);
    expect(flattenSessionGroups(groups).map((s) => s.id)).toEqual([
      "here-new",
      "here-old",
      "other-new",
      "other-old",
      "third",
      "nofolder",
    ]);
    expect(groups[1].path).toBe("/home/me/code/other");
  });

  it("has no current group when nothing matches, and orders by newest", () => {
    const groups = groupSessionsByWorkspace(sessions, {
      ...accessors,
      workspaceDirs: ["/elsewhere/a/b"],
    });
    expect(groups.every((g) => !g.isCurrent)).toBe(true);
    expect(groups[0].sessions[0].id).toBe("other-new");
    expect(groups.at(-1)?.label).toBe("No folder");
    expect(
      newestSessionInWorkspace(sessions, {
        ...accessors,
        workspaceDirs: ["/elsewhere/a/b"],
      }),
    ).toBeUndefined();
  });

  it("groups case and slash variants together on case-insensitive systems", () => {
    const mixed: S[] = [
      { id: "a", dir: "C:\\Code\\Proj", t: 1 },
      { id: "b", dir: "file:///c%3A/code/proj", t: 2 },
      { id: "c", dir: "c:/code/other", t: 3 },
    ];
    const groups = groupSessionsByWorkspace(mixed, {
      ...accessors,
      workspaceDirs: ["c:/CODE/proj/"],
      caseInsensitive: true,
    });
    expect(groups[0].isCurrent).toBe(true);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["b", "a"]);
    expect(groups[1].sessions.map((s) => s.id)).toEqual(["c"]);
    expect(
      newestSessionInWorkspace(mixed, {
        ...accessors,
        workspaceDirs: ["c:/CODE/proj/"],
        caseInsensitive: true,
      })?.id,
    ).toBe("b");
  });
});
