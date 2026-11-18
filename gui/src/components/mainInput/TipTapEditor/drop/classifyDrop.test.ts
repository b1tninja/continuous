import { describe, expect, it } from "vitest";
import {
  classifyDrop,
  isHandledDrag,
  parseUriList,
  stripFragment,
  uriBasename,
} from "./classifyDrop";
import {
  editorTabDrag,
  explorerDrag,
  fakeDataTransfer,
  fakeFile,
  osFileDrag,
  textDrag,
  WS,
} from "./dropFixtures";

describe("classifyDrop", () => {
  it("reads every file and folder of an Explorer drag, folders included", () => {
    const items = classifyDrop(
      explorerDrag([`${WS}/src/a.ts`, `${WS}/README.md`], [`${WS}/docs`]),
    );
    expect(items).toEqual([
      expect.objectContaining({
        kind: "folder",
        source: "explorer",
        name: "docs",
        uri: `${WS}/docs`,
        kindCertain: true,
      }),
      expect.objectContaining({
        kind: "file",
        source: "explorer",
        name: "a.ts",
        uri: `${WS}/src/a.ts`,
      }),
      expect.objectContaining({ kind: "file", name: "README.md" }),
    ]);
  });

  it("does not paste the Explorer's path labels as text", () => {
    const items = classifyDrop(explorerDrag([`${WS}/a.ts`]));
    expect(items.map((i) => i.kind)).toEqual(["file"]);
  });

  it("treats a folder-only Explorer drag as folders", () => {
    const items = classifyDrop(explorerDrag([], [`${WS}/src`]));
    expect(items).toEqual([
      expect.objectContaining({ kind: "folder", name: "src" }),
    ]);
  });

  it("reads an editor tab and drops the selection fragment", () => {
    const items = classifyDrop(editorTabDrag(`${WS}/src/a.ts#L3,5`));
    expect(items).toEqual([
      expect.objectContaining({
        kind: "file",
        source: "editor",
        name: "a.ts",
        uri: `${WS}/src/a.ts`,
      }),
    ]);
  });

  it("keeps remote URIs (vscode-remote) as resources", () => {
    const uri = "vscode-remote://wsl%2BUbuntu/home/u/proj/app.ts";
    const items = classifyDrop(
      fakeDataTransfer({
        ResourceURLs: JSON.stringify([uri]),
        "application/vnd.code.uri-list": uri,
        CodeEditors: JSON.stringify([{ resource: { external: uri } }]),
      }),
    );
    expect(items).toEqual([
      expect.objectContaining({ kind: "file", uri, name: "app.ts" }),
    ]);
  });

  it("falls back to text/uri-list when VS Code's list is missing", () => {
    const items = classifyDrop(
      fakeDataTransfer({ "text/uri-list": `# comment\r\n${WS}/a.ts` }),
    );
    expect(items).toEqual([
      expect.objectContaining({
        kind: "file",
        source: "os",
        uri: `${WS}/a.ts`,
      }),
    ]);
  });

  it("classifies an http link as a url", () => {
    const items = classifyDrop(
      fakeDataTransfer({
        "text/uri-list": "https://example.com/page",
        "text/plain": "https://example.com/page",
      }),
    );
    expect(items).toEqual([
      expect.objectContaining({ kind: "url", uri: "https://example.com/page" }),
    ]);
  });

  it("refuses an unsaved editor", () => {
    const items = classifyDrop(editorTabDrag("untitled:Untitled-1"));
    expect(items[0]).toEqual(
      expect.objectContaining({ kind: "unsupported", reason: "untitled" }),
    );
  });

  it("turns OS images into image items and other OS files into refusals", () => {
    const png = fakeFile("shot.png", "image/png");
    const svg = fakeFile("logo.svg", "image/svg+xml");
    const txt = fakeFile("notes.txt", "text/plain");
    const items = classifyDrop(osFileDrag(png, svg, txt));
    expect(items).toEqual([
      expect.objectContaining({ kind: "image", source: "os", file: png }),
      expect.objectContaining({ kind: "unsupported", reason: "svg-image" }),
      expect.objectContaining({ kind: "unsupported", reason: "no-location" }),
    ]);
  });

  it("prefers URIs over files when a file manager sends both", () => {
    const items = classifyDrop(
      fakeDataTransfer({ "text/uri-list": `${WS}/a.ts` }, [
        fakeFile("a.ts", "text/plain"),
      ]),
    );
    expect(items).toEqual([
      expect.objectContaining({ kind: "file", uri: `${WS}/a.ts` }),
    ]);
  });

  it("returns dropped text, unsanitised, from text/plain", () => {
    const items = classifyDrop(textDrag("hello world"));
    expect(items).toEqual([
      expect.objectContaining({ kind: "text", text: "hello world" }),
    ]);
  });

  it("returns nothing for an empty drag and survives a throwing getData", () => {
    expect(classifyDrop(fakeDataTransfer({}))).toEqual([]);
    const items = classifyDrop({
      types: ["text/plain"],
      getData: () => {
        throw new Error("denied");
      },
    });
    expect(items).toEqual([]);
  });

  it("ignores malformed JSON in VS Code's types", () => {
    const items = classifyDrop(
      fakeDataTransfer({ ResourceURLs: "{not json", CodeEditors: "[1,2" }),
    );
    expect(items).toEqual([]);
  });
});

describe("helpers", () => {
  it("parses a uri-list", () => {
    expect(parseUriList("# c\r\na\n\n b \n")).toEqual(["a", "b"]);
  });
  it("strips fragments and decodes basenames", () => {
    expect(stripFragment("file:///a/b.ts#L1")).toBe("file:///a/b.ts");
    expect(uriBasename("file:///a/my%20file.ts")).toBe("my file.ts");
    expect(uriBasename("file:///a/dir/")).toBe("dir");
  });
  it("knows which drags it handles", () => {
    expect(isHandledDrag(["Files"])).toBe(true);
    expect(isHandledDrag(["application/vnd.code.uri-list"])).toBe(true);
    expect(isHandledDrag(["resourceurls"])).toBe(true);
    expect(isHandledDrag(["application/x-moz-custom"])).toBe(false);
    expect(isHandledDrag(undefined)).toBe(false);
  });
});
