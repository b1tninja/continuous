import { describe, expect, it } from "vitest";

import {
  documentChanged,
  editorMatchesFilepath,
  isWindowsDrivePath,
  windowsPathsEqual,
} from "./applyTarget";

describe("documentChanged", () => {
  const captured = { uri: "file:///ws/a.ts", version: 3 };

  it("is unchanged for the same document and version", () => {
    expect(documentChanged(captured, captured)).toBe(false);
  });

  it("treats a different open document as a different target", () => {
    expect(
      documentChanged(captured, { uri: "file:///ws/b.ts", version: 3 }),
    ).toBe(true);
    expect(documentChanged(captured, undefined)).toBe(true);
  });

  it("treats a newer version as an edit that must not be overwritten", () => {
    expect(
      documentChanged(captured, { uri: "file:///ws/a.ts", version: 4 }),
    ).toBe(true);
  });
});

describe("isWindowsDrivePath", () => {
  it("accepts drive paths with either slash", () => {
    expect(isWindowsDrivePath("C:\\a\\b")).toBe(true);
    expect(isWindowsDrivePath("d:/a/b")).toBe(true);
  });
  it("rejects URIs, POSIX paths, relative paths and a bare drive", () => {
    expect(isWindowsDrivePath("file:///c%3A/a")).toBe(false);
    expect(isWindowsDrivePath("/ws/a.ts")).toBe(false);
    expect(isWindowsDrivePath("a.ts")).toBe(false);
    expect(isWindowsDrivePath("C:")).toBe(false);
    expect(isWindowsDrivePath("")).toBe(false);
  });
});

describe("windowsPathsEqual", () => {
  it("ignores drive-letter case, slash direction and path case", () => {
    expect(windowsPathsEqual("c:\\A\\b.md", "C:/a/B.md")).toBe(true);
  });
  it("is false for different files or non-Windows paths", () => {
    expect(windowsPathsEqual("C:\\a\\b.md", "C:\\a\\c.md")).toBe(false);
    expect(windowsPathsEqual("/a/b", "/a/b")).toBe(false);
  });
});

describe("editorMatchesFilepath", () => {
  const editor = { uri: "file:///ws/src/a.ts", fsPath: "/ws/src/a.ts" };

  it("matches the URI and the filesystem path", () => {
    expect(editorMatchesFilepath(editor, "file:///ws/src/a.ts")).toBe(true);
    expect(editorMatchesFilepath(editor, "/ws/src/a.ts")).toBe(true);
  });

  it("matches a Windows path despite drive-letter case and slash direction", () => {
    const win = {
      uri: "file:///c%3A/github/x/a.md",
      fsPath: "c:\\github\\x\\a.md",
    };
    expect(editorMatchesFilepath(win, "C:\\github\\x\\a.md")).toBe(true);
    expect(editorMatchesFilepath(win, "C:/github/x/a.md")).toBe(true);
    expect(editorMatchesFilepath(win, "C:\\github\\x\\b.md")).toBe(false);
  });
  it("does not match a different file that merely ends with the same name", () => {
    expect(editorMatchesFilepath(editor, "file:///other/a.ts")).toBe(false);
    expect(editorMatchesFilepath(editor, "a.ts")).toBe(false);
  });
});
