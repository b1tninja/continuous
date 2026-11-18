import { describe, expect, it } from "vitest";
import { ContinueErrorReason } from "../../util/errors";
import { executeFindAndReplace } from "./performReplace";

/**
 * vLLM v0.24.0 to v0.25.1 and main strip leading and trailing whitespace from
 * every string argument of the Qwen3 and Qwen3-Coder tool parser (vLLM issue
 * 48753). old_string and new_string both arrive stripped, so the edit tools
 * must still land the edit the model meant, or refuse; never edit the wrong
 * place.
 */
const strip = (s: string) => s.trim();

/** The edit the model meant, then the same edit as a stripping server delivers it. */
function bothWays(file: string, oldString: string, newString: string) {
  return {
    meant: executeFindAndReplace(file, oldString, newString, false),
    received: executeFindAndReplace(
      file,
      strip(oldString),
      strip(newString),
      false,
    ),
  };
}

describe("edits whose old_string and new_string lost their edge whitespace", () => {
  it("leading indentation of the first line: the stripped edit equals the meant edit", () => {
    const file = "class A:\n    def f(self):\n        return 1\n\nx = 1\n";
    const r = bothWays(
      file,
      "    def f(self):\n        return 1\n",
      "    def g(self):\n        return 2\n",
    );
    expect(r.received).toBe(r.meant);
    expect(r.received).toBe(
      "class A:\n    def g(self):\n        return 2\n\nx = 1\n",
    );
  });

  it("a trailing newline: the line break stays in the file", () => {
    const file = "a = 1\nb = 2\nc = 3\n";
    const r = bothWays(file, "b = 2\n", "b = 20\n");
    expect(r.received).toBe(r.meant);
    expect(r.received).toBe("a = 1\nb = 20\nc = 3\n");
  });

  it("a leading newline and trailing blank lines", () => {
    const file = "head\nfoo()\n\n\ntail\n";
    const r = bothWays(file, "\nfoo()\n\n", "\nbar()\n\n");
    expect(r.received).toBe(r.meant);
  });

  it("CRLF files: the last CRLF of the block is left alone", () => {
    const file = "a = 1\r\nb = 2\r\nc = 3\r\n";
    const out = executeFindAndReplace(
      file,
      "a = 1\r\nb = 2",
      "a = 1\r\nb = 5",
      false,
    );
    expect(out).toBe("a = 1\r\nb = 5\r\nc = 3\r\n");
  });

  it("a trailing-newline loss never turns an ambiguous line into a silent edit", () => {
    // meant: the line `x = 1` (with its newline). Stripped, `x = 1` also
    // matches inside `x = 10`, so there are two places and the tool refuses.
    const file = "x = 10\ny = 2\nx = 1\nz = 3\n";
    let error: unknown;
    try {
      executeFindAndReplace(file, "x = 1", "x = 7", false);
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({
      reason: ContinueErrorReason.FindAndReplaceMultipleOccurrences,
    });
  });

  it("a trailing-newline loss with one real place edits that place only", () => {
    const file = "x = 10\ny = 2\nx = 1\nz = 3\n";
    // include the next line so the string is unique, as the tool tells the model to
    const out = executeFindAndReplace(
      file,
      "x = 1\nz = 3",
      "x = 7\nz = 3",
      false,
    );
    expect(out).toBe("x = 10\ny = 2\nx = 7\nz = 3\n");
  });

  it("first-line indentation lost and the block sits deeper in the file: later lines shift by the real difference", () => {
    // meant: old_string copied at indentation 4 ("    if x:\n        y()\n"),
    // while the file holds the block at indentation 8.
    const file =
      "def f():\n    if a:\n        if x:\n            y()\n        z()\n";
    const out = executeFindAndReplace(
      file,
      strip("    if x:\n        y()\n"),
      strip("    if w:\n        v()\n"),
      false,
    );
    expect(out).toBe(
      "def f():\n    if a:\n        if w:\n            v()\n        z()\n",
    );
  });

  it("first-line indentation lost and the block is at the same depth: nothing is added", () => {
    const file = "if a:\n    if x:\n        y()\n";
    const out = executeFindAndReplace(
      file,
      strip("    if x:\n        y()\n"),
      strip("    if w:\n        v()\n"),
      false,
    );
    expect(out).toBe("if a:\n    if w:\n        v()\n");
  });
});
