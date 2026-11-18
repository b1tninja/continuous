import { describe, expect, it } from "vitest";
import { hasValidEditorContent } from "./editorConfig";

const IMAGE = { type: "image", attrs: { src: "data:image/png;base64,AA==" } };
const paragraph = (...content: object[]) => ({ type: "paragraph", content });

describe("hasValidEditorContent", () => {
  it("is false for an empty document", () => {
    expect(hasValidEditorContent({ type: "doc", content: [] })).toBe(false);
    expect(hasValidEditorContent({ type: "doc" })).toBe(false);
  });

  it("is false for whitespace only", () => {
    expect(
      hasValidEditorContent({
        type: "doc",
        content: [paragraph({ type: "text", text: "  \n " })],
      }),
    ).toBe(false);
  });

  it("is true for text", () => {
    expect(
      hasValidEditorContent({
        type: "doc",
        content: [paragraph({ type: "text", text: "hi" })],
      }),
    ).toBe(true);
  });

  it("is true for a mention", () => {
    expect(
      hasValidEditorContent({
        type: "doc",
        content: [paragraph({ type: "mention", attrs: { id: "x" } })],
      }),
    ).toBe(true);
  });

  it("is true for an image alone, as a block or inside a paragraph", () => {
    expect(hasValidEditorContent({ type: "doc", content: [IMAGE] })).toBe(true);
    expect(
      hasValidEditorContent({ type: "doc", content: [paragraph(IMAGE)] }),
    ).toBe(true);
  });

  it("is true for an image next to an empty paragraph", () => {
    expect(
      hasValidEditorContent({
        type: "doc",
        content: [paragraph(), IMAGE, paragraph()],
      }),
    ).toBe(true);
  });
});
