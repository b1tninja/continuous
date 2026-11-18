import { describe, expect, it } from "vitest";
import { hiddenNote, revealHidden } from "./hiddenCharacters";

describe("revealHidden: an approval shows the characters that draw as nothing", () => {
  it("leaves ordinary text, tabs, line feeds and CRLF line ends alone", () => {
    const text = "npm test\n\tgit status\r\necho done — café 日本語";
    expect(revealHidden(text)).toEqual({ text, count: 0 });
  });

  it("writes out a right-to-left override, which reorders what is drawn", () => {
    // drawn, the text after U+202E runs backwards
    const r = revealHidden("rm notes\u202Etxt.sh");
    expect(r.text).toBe("rm notes⟦U+202E⟧txt.sh");
    expect(r.count).toBe(1);
  });

  it("writes out zero-width spaces, isolates, the BOM and a soft hyphen", () => {
    const r = revealHidden("a\u200Bb\u2066c\u2069d\uFEFFe\u00ADf");
    expect(r.text).toBe("a⟦U+200B⟧b⟦U+2066⟧c⟦U+2069⟧d⟦U+FEFF⟧e⟦U+00AD⟧f");
    expect(r.count).toBe(5);
  });

  it("writes out a bare carriage return, an escape and a NUL", () => {
    const r = revealHidden("echo a\rrm x \u001B[2K\u0000");
    expect(r.text).toBe("echo a⟦U+000D⟧rm x ⟦U+001B⟧[2K⟦U+0000⟧");
    expect(r.count).toBe(3);
  });

  it("writes out Unicode tag characters by their full code point", () => {
    const r = revealHidden("ok\u{E0041}\u{E007F}");
    expect(r.text).toBe("ok⟦U+E0041⟧⟦U+E007F⟧");
    expect(r.count).toBe(2);
  });

  it("keeps the joiners an emoji and some scripts need", () => {
    const family = "👩\u200D👩\u200D👧";
    expect(revealHidden(family)).toEqual({ text: family, count: 0 });
    expect(revealHidden("می\u200Cخواهم").count).toBe(0);
  });

  it("has a sentence for one, for several, and none for zero", () => {
    expect(hiddenNote(0)).toBeUndefined();
    expect(hiddenNote(1)).toContain("1 hidden character is in this call");
    expect(hiddenNote(3)).toContain("3 hidden characters are in this call");
  });
});
