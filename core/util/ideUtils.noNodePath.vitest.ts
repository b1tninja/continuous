import { describe, expect, it, vi } from "vitest";

// What the chat webview's browser build ships for Node's `path`: an empty
// module, so every property read from it is undefined. `vi.mock` with a plain
// object makes vitest throw its own error for a missing export, so this uses a
// Proxy that answers `undefined`, as the bundle does.
const emptyPath = vi.hoisted(
  () =>
    new Proxy(
      {},
      {
        get: (_t, key) => (key === "default" ? emptyPath : undefined),
        has: () => true,
      },
    ),
);
vi.mock("node:path", () => emptyPath);
vi.mock("path", () => emptyPath);

import type { IDE } from "..";
import { validateSearchAndReplaceFilepath } from "../edit/searchAndReplace/validateArgs";
import { absoluteLocalUri, isOutsideDirs, staysInDir } from "./ideUtils";

/**
 * Regression: in the chat webview `path.win32` was undefined, so every
 * `multi_edit` on Windows failed with "Cannot read properties of undefined
 * (reading 'relative')". The tests run in Node, where `path` is real, and never
 * saw it. Here `path` is empty, as it is in the bundle.
 */
const WIN_WS = "file:///c%3A/github/proj";
const POSIX_WS = "file:///home/u/proj";

function ide(workspace: string, existing: string[]): IDE {
  return {
    getWorkspaceDirs: async () => [workspace],
    fileExists: async (uri: string) => existing.includes(uri),
    readFile: async () => "x",
    getIdeInfo: async () => ({ remoteName: "local" }),
  } as unknown as IDE;
}

describe("with no Node `path`, as in the chat webview", () => {
  it("the stand-in really is empty (this test would not catch the bug otherwise)", async () => {
    const path = await import("node:path");
    expect((path as Record<string, unknown>).win32).toBeUndefined();
    expect((path as Record<string, unknown>).relative).toBeUndefined();
    expect(() =>
      (path as unknown as { win32: { relative: () => void } }).win32.relative(),
    ).toThrow("Cannot read properties of undefined (reading 'relative')");
  });

  describe("staysInDir", () => {
    it("Windows file URIs", () => {
      expect(staysInDir(`${WIN_WS}/src/a.ts`, WIN_WS)).toBe(true);
      expect(staysInDir("file:///c%3A/other/a.ts", WIN_WS)).toBe(false);
    });
    it("plain Windows paths", () => {
      expect(staysInDir("c:\\github\\proj\\a.ts", "c:\\github\\proj")).toBe(
        true,
      );
      expect(staysInDir("c:\\github\\projx\\a.ts", "c:\\github\\proj")).toBe(
        false,
      );
    });
    it("POSIX file URIs", () => {
      expect(staysInDir(`${POSIX_WS}/a.ts`, POSIX_WS)).toBe(true);
    });
    it("plain POSIX paths", () => {
      expect(staysInDir("/home/u/proj/a.ts", "/home/u/proj")).toBe(true);
      expect(staysInDir("/home/u/other/a.ts", "/home/u/proj")).toBe(false);
    });
  });

  it("isOutsideDirs and absoluteLocalUri do not throw", () => {
    expect(isOutsideDirs(`${WIN_WS}/a.ts`, [WIN_WS])).toBe(false);
    expect(isOutsideDirs("file:///d%3A/x/a.ts", [WIN_WS])).toBe(true);
    expect(absoluteLocalUri("/home/u/proj/a.ts")).toBe(
      "file:///home/u/proj/a.ts",
    );
    expect(absoluteLocalUri("c:\\proj\\a.ts")).toBe("file:///c:/proj/a.ts");
    expect(absoluteLocalUri("src/a.ts")).toBeUndefined();
  });

  describe("the path check multi_edit runs", () => {
    const file = "file:///c%3A/github/proj/src/a.ts";

    it("a relative path in a Windows workspace", async () => {
      await expect(
        validateSearchAndReplaceFilepath("src/a.ts", ide(WIN_WS, [file])),
      ).resolves.toBe(file);
    });

    it("an absolute Windows path with backslashes", async () => {
      await expect(
        validateSearchAndReplaceFilepath(
          "c:\\github\\proj\\src\\a.ts",
          ide(WIN_WS, [file, "file:///c:/github/proj/src/a.ts"]),
        ),
      ).resolves.toMatch(/github\/proj\/src\/a\.ts$/);
    });

    it("an absolute file URI in a Windows workspace", async () => {
      await expect(
        validateSearchAndReplaceFilepath(file, ide(WIN_WS, [file])),
      ).resolves.toBe(file);
    });

    it("a relative path in a POSIX workspace", async () => {
      const f = "file:///home/u/proj/src/a.ts";
      await expect(
        validateSearchAndReplaceFilepath("src/a.ts", ide(POSIX_WS, [f])),
      ).resolves.toBe(f);
    });

    it("an absolute POSIX path", async () => {
      const f = "file:///home/u/proj/a.ts";
      await expect(
        validateSearchAndReplaceFilepath(
          "/home/u/proj/a.ts",
          ide(POSIX_WS, [f]),
        ),
      ).resolves.toBe(f);
    });

    it("a file that is missing still says so, and does not throw the path error", async () => {
      await expect(
        validateSearchAndReplaceFilepath("src/missing.ts", ide(WIN_WS, [])),
      ).rejects.toThrow(/does not exist|not exist/i);
    });
  });
});
