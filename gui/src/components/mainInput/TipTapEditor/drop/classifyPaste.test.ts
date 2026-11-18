import { describe, expect, it } from "vitest";
import { ClipboardDataLike, classifyPaste, FileLike } from "./classifyDrop";
import { fakeFile } from "./dropFixtures";

/** A clipboard as Chromium hands it to a paste event. */
function clipboard(
  data: Record<string, string>,
  files: FileLike[] = [],
  options: { itemsOnly?: boolean; filesOnly?: boolean } = {},
): ClipboardDataLike {
  return {
    types: [...Object.keys(data), ...(files.length ? ["Files"] : [])],
    getData: (format) => data[format] ?? "",
    items: options.filesOnly
      ? []
      : files.map((f) => ({
          kind: "file",
          type: f.type,
          getAsFile: () => f,
        })),
    files: options.itemsOnly ? [] : files,
  };
}

describe("classifyPaste", () => {
  it("takes a pasted screenshot as an image", () => {
    const shot = fakeFile("image.png", "image/png", 4000);
    const items = classifyPaste(clipboard({}, [shot]));
    expect(items).toEqual([
      expect.objectContaining({ kind: "image", name: "image.png", file: shot }),
    ]);
  });

  it("takes an image copied from a browser, ignoring its <img> HTML", () => {
    const img = fakeFile("image.png", "image/png");
    const items = classifyPaste(
      clipboard({ "text/html": '<img src="https://x/y.png">' }, [img]),
    );
    expect(items.map((i) => i.kind)).toEqual(["image"]);
  });

  it("keeps several images in the order they were pasted", () => {
    const a = fakeFile("a.png", "image/png");
    const b = fakeFile("b.jpg", "image/jpeg");
    const items = classifyPaste(clipboard({}, [a, b]));
    expect(items.map((i) => i.name)).toEqual(["a.png", "b.jpg"]);
  });

  it("does not count a file twice when it is under items and files", () => {
    const shot = fakeFile("image.png", "image/png");
    expect(classifyPaste(clipboard({}, [shot]))).toHaveLength(1);
  });

  it("reads files when the clipboard lists none under items", () => {
    const shot = fakeFile("image.png", "image/png");
    const items = classifyPaste(clipboard({}, [shot], { filesOnly: true }));
    expect(items.map((i) => i.kind)).toEqual(["image"]);
  });

  it("leaves a plain text paste to the editor", () => {
    expect(classifyPaste(clipboard({ "text/plain": "hello" }))).toEqual([]);
  });

  it("leaves text with a picture of it (Office) to the editor", () => {
    const picture = fakeFile("image.png", "image/png");
    expect(
      classifyPaste(
        clipboard(
          { "text/plain": "Q3 revenue", "text/html": "<table>…</table>" },
          [picture],
        ),
      ),
    ).toEqual([]);
  });

  it("still takes the image when the text is only whitespace", () => {
    const shot = fakeFile("image.png", "image/png");
    expect(
      classifyPaste(clipboard({ "text/plain": "  \n" }, [shot])).map(
        (i) => i.kind,
      ),
    ).toEqual(["image"]);
  });

  it("marks a pasted SVG and a non-image file as unsupported, with reasons", () => {
    const items = classifyPaste(
      clipboard({}, [
        fakeFile("logo.svg", "image/svg+xml"),
        fakeFile("notes.txt", "text/plain"),
      ]),
    );
    expect(items).toEqual([
      expect.objectContaining({ kind: "unsupported", reason: "svg-image" }),
      expect.objectContaining({ kind: "unsupported", reason: "no-location" }),
    ]);
  });

  it("returns nothing for an empty clipboard", () => {
    expect(classifyPaste(clipboard({}))).toEqual([]);
  });

  it("skips string items and items that yield no file", () => {
    const cb: ClipboardDataLike = {
      getData: () => "",
      items: [
        { kind: "string", type: "text/plain", getAsFile: () => null },
        { kind: "file", type: "image/png", getAsFile: () => null },
      ],
      files: [],
    };
    expect(classifyPaste(cb)).toEqual([]);
  });

  it("treats a clipboard whose text cannot be read as having none", () => {
    const shot = fakeFile("image.png", "image/png");
    const cb: ClipboardDataLike = {
      getData: () => {
        throw new Error("denied");
      },
      items: [{ kind: "file", type: "image/png", getAsFile: () => shot }],
    };
    expect(classifyPaste(cb).map((i) => i.kind)).toEqual(["image"]);
  });
});
