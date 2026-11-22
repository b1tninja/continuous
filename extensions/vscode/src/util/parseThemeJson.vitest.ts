import { describe, expect, it } from "vitest";

import { parseThemeJson, stripJsonComments } from "./parseThemeJson";

describe("parseThemeJson", () => {
  it("parses plain JSON", () => {
    expect(parseThemeJson('{"name":"x","colors":{"a":"#fff"}}')).toEqual({
      name: "x",
      colors: { a: "#fff" },
    });
  });

  it("returns an empty object for a missing file", () => {
    expect(parseThemeJson(undefined)).toEqual({});
  });

  it("accepts a trailing comma before a closing brace or bracket", () => {
    const text =
      '{\n  "colors": {\n    "a": "#fff",\n  },\n  "tokenColors": [1, 2,],\n}';
    expect(parseThemeJson(text)).toEqual({
      colors: { a: "#fff" },
      tokenColors: [1, 2],
    });
  });

  it("accepts a trailing comma followed by a comment", () => {
    expect(parseThemeJson('{"a": 1, // last\n}')).toEqual({ a: 1 });
    expect(parseThemeJson('{"a": [1, /* last */ ]}')).toEqual({ a: [1] });
  });

  it("removes line and block comments", () => {
    const text =
      '// header\n{\n  /* block\n     comment */\n  "a": 1, // trailing\n  "b": 2\n}';
    expect(parseThemeJson(text)).toEqual({ a: 1, b: 2 });
  });

  it("leaves comment markers and commas inside strings alone", () => {
    const text =
      '{"url": "http://example.com/*x*/", "s": "a,}", "q": "say \\"hi\\" // no"}';
    expect(parseThemeJson(text)).toEqual({
      url: "http://example.com/*x*/",
      s: "a,}",
      q: 'say "hi" // no',
    });
  });

  it("accepts a byte-order mark", () => {
    expect(parseThemeJson('﻿{"a": 1}')).toEqual({ a: 1 });
  });

  it("keeps line numbers when it removes a block comment", () => {
    expect(stripJsonComments("a/*\n\n*/b").split("\n")).toHaveLength(3);
  });

  it("still rejects text that is not JSON", () => {
    expect(() => parseThemeJson("{a: 1}")).toThrow();
  });
});
