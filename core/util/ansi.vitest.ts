import { describe, expect, it } from "vitest";
import { hasAnsi, stripAnsi } from "./ansi";

const ESC = "\u001b";
const BEL = "\u0007";

describe("stripAnsi", () => {
  it("leaves plain text as it is", () => {
    for (const text of [
      "",
      "hello",
      "a\nb\tc",
      "100% done",
      "[31mnot an escape",
    ]) {
      expect(stripAnsi(text), JSON.stringify(text)).toBe(text);
    }
  });

  it("removes colours and styles", () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[0m`)).toBe("red");
    expect(stripAnsi(`${ESC}[1;32mbold green${ESC}[22;39m ok`)).toBe(
      "bold green ok",
    );
    expect(stripAnsi(`${ESC}[0m`)).toBe("");
  });

  it("removes 256-colour and true-colour sequences", () => {
    expect(stripAnsi(`${ESC}[38;5;208morange${ESC}[0m`)).toBe("orange");
    expect(stripAnsi(`${ESC}[38;2;255;100;0mfull${ESC}[0m`)).toBe("full");
  });

  it("removes cursor movement and erase sequences", () => {
    expect(stripAnsi(`a${ESC}[2K${ESC}[1Gb`)).toBe("ab");
    expect(stripAnsi(`${ESC}[2J${ESC}[Hscreen`)).toBe("screen");
    expect(stripAnsi(`${ESC}[?25l hidden cursor ${ESC}[?25h`)).toBe(
      " hidden cursor ",
    );
    expect(stripAnsi(`${ESC}[3A${ESC}[10;20Hx`)).toBe("x");
  });

  it("removes a window title, ended by BEL or by ESC backslash", () => {
    expect(stripAnsi(`${ESC}]0;my title${BEL}text`)).toBe("text");
    expect(stripAnsi(`${ESC}]2;my title${ESC}\\text`)).toBe("text");
  });

  it("removes a hyperlink wrapper and keeps the link text", () => {
    const link = `${ESC}]8;;https://example.com${ESC}\\click here${ESC}]8;;${ESC}\\`;
    expect(stripAnsi(link)).toBe("click here");
    const bel = `${ESC}]8;;https://example.com${BEL}click here${ESC}]8;;${BEL}`;
    expect(stripAnsi(bel)).toBe("click here");
  });

  it("removes other escapes: reset, save and restore, character sets", () => {
    expect(stripAnsi(`${ESC}c fresh`)).toBe(" fresh");
    expect(stripAnsi(`${ESC}7saved${ESC}8`)).toBe("saved");
    expect(stripAnsi(`${ESC}(Bline drawing${ESC}(0`)).toBe("line drawing");
  });

  it("removes the 8-bit forms", () => {
    expect(stripAnsi("\u009b31mred\u009b0m")).toBe("red");
    expect(stripAnsi(`\u009d0;title${BEL}x`)).toBe("x");
  });

  it("keeps newlines, tabs and carriage returns: a progress bar redraws with them", () => {
    const text = `${ESC}[32mone${ESC}[0m\r\n\ttwo\rthree`;
    expect(stripAnsi(text)).toBe("one\r\n\ttwo\rthree");
  });

  it("keeps text that sits between sequences, however many there are", () => {
    const text = Array.from(
      { length: 200 },
      (_, i) => `${ESC}[3${i % 8}m${i}${ESC}[0m`,
    ).join(",");
    expect(stripAnsi(text)).toBe(
      Array.from({ length: 200 }, (_, i) => String(i)).join(","),
    );
  });

  it("drops a sequence cut off at the end of the text", () => {
    expect(stripAnsi(`done${ESC}[3`)).toBe("done");
    expect(stripAnsi(`done${ESC}[`)).toBe("done");
    expect(stripAnsi(`done${ESC}`)).toBe("done");
    expect(stripAnsi(`done${ESC}]0;half a title`)).toBe("done");
    expect(stripAnsi(`done${ESC}[31;1`)).toBe("done");
  });

  it("does not eat the text after a complete sequence", () => {
    expect(stripAnsi(`${ESC}[31m[ERROR]${ESC}[0m disk full`)).toBe(
      "[ERROR] disk full",
    );
    expect(stripAnsi(`${ESC}[1mA${ESC}[0m[B]`)).toBe("A[B]");
  });

  it("does not eat the line after an unterminated title", () => {
    // A title with no terminator runs to the end of the text, as a terminal
    // would treat it, but only up to the next escape.
    expect(stripAnsi(`${ESC}]0;t${ESC}[31mred`)).toBe("red");
  });

  it("is idempotent", () => {
    const once = stripAnsi(`${ESC}[31mred${ESC}[0m ${ESC}]0;t${BEL}x`);
    expect(stripAnsi(once)).toBe(once);
  });

  it("is quick on a large output with no escapes, and on one with many", () => {
    const plain = "line of output\n".repeat(200_000);
    let t = performance.now();
    expect(stripAnsi(plain)).toBe(plain);
    expect(performance.now() - t).toBeLessThan(500);
    const coloured = `${ESC}[31mline of output${ESC}[0m\n`.repeat(100_000);
    t = performance.now();
    expect(stripAnsi(coloured)).toBe("line of output\n".repeat(100_000));
    expect(performance.now() - t).toBeLessThan(1500);
  });

  it("does not take a long time on text that only looks like the start of a sequence", () => {
    const hostile = `${ESC}[`.repeat(50_000) + "x";
    const t = performance.now();
    stripAnsi(hostile);
    expect(performance.now() - t).toBeLessThan(1000);
  });
});

describe("hasAnsi", () => {
  it("is true when there is a sequence, and false when there is none", () => {
    expect(hasAnsi(`${ESC}[31mx`)).toBe(true);
    expect(hasAnsi(`${ESC}]0;t${BEL}`)).toBe(true);
    expect(hasAnsi("plain")).toBe(false);
    expect(hasAnsi("")).toBe(false);
    expect(hasAnsi("[31mnot an escape")).toBe(false);
  });

  it("agrees with stripAnsi: true exactly when stripping changes the text", () => {
    for (const text of [
      "plain",
      `${ESC}[31mred${ESC}[0m`,
      `end${ESC}[3`,
      `${ESC}]8;;u${ESC}\\l${ESC}]8;;${ESC}\\`,
      "a\r\nb",
      "",
    ]) {
      expect(hasAnsi(text), JSON.stringify(text)).toBe(
        stripAnsi(text) !== text,
      );
    }
  });

  it("can be called repeatedly (no state left in the pattern)", () => {
    const text = `${ESC}[31mx`;
    expect([hasAnsi(text), hasAnsi(text), hasAnsi(text)]).toEqual([
      true,
      true,
      true,
    ]);
  });
});
