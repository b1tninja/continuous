import { describe, expect, it } from "vitest";
import { ContinueErrorReason } from "../../util/errors";
import { executeFindAndReplace } from "./performReplace";

describe("executeFindAndReplace", () => {
  describe("normal cases", () => {
    it("should replace single occurrence by default", () => {
      const content = "Hello world\nThis is a test file\nGoodbye";
      const result = executeFindAndReplace(content, "Hello", "Hi", false);

      expect(result).toBe("Hi world\nThis is a test file\nGoodbye");
    });

    it("should replace single occurrence when replaceAll is false", () => {
      const content = "Hello world\nHello again";
      const result = executeFindAndReplace(
        content,
        "Hello world",
        "Hi world",
        false,
      );

      expect(result).toBe("Hi world\nHello again");
    });

    it("should replace all occurrences when replaceAll is true", () => {
      const content = "Hello world\nHello again\nHello there";
      const result = executeFindAndReplace(content, "Hello", "Hi", true);

      expect(result).toBe("Hi world\nHi again\nHi there");
    });

    it("should handle empty new string (deletion)", () => {
      const content = "Hello world";
      const result = executeFindAndReplace(content, "Hello ", "", false);

      expect(result).toBe("world");
    });

    it("should handle empty old string replacement (insertion at start)", () => {
      const content = "";
      const result = executeFindAndReplace(content, "", "Hello world", false);

      expect(result).toBe("Hello world");
    });

    it("should preserve whitespace and indentation", () => {
      const content =
        "function test() {\n    const value = 'old';\n    return value;\n}";
      const result = executeFindAndReplace(
        content,
        "    const value = 'old';",
        "    const value = 'new';",
        false,
      );

      expect(result).toBe(
        "function test() {\n    const value = 'new';\n    return value;\n}",
      );
    });

    it("should handle multiline strings", () => {
      const content = "line1\nline2\nline3";
      const result = executeFindAndReplace(
        content,
        "line1\nline2",
        "newline1\nnewline2",
        false,
      );

      expect(result).toBe("newline1\nnewline2\nline3");
    });
  });

  describe("special character handling", () => {
    it("should handle regex special characters in old string", () => {
      const content = "const regex = /[a-z]+/g;";
      const result = executeFindAndReplace(
        content,
        "/[a-z]+/g",
        "/[A-Z]+/g",
        false,
      );

      expect(result).toBe("const regex = /[A-Z]+/g;");
    });

    it("should handle dollar signs in strings", () => {
      const content = 'const text = "Hello $world"';
      const result = executeFindAndReplace(
        content,
        '"Hello $world"',
        '"Hi $universe"',
        false,
      );

      expect(result).toBe('const text = "Hi $universe"');
    });

    it("should handle backslashes", () => {
      const content = 'const path = "C:\\Users\\test"';
      const result = executeFindAndReplace(
        content,
        "C:\\Users\\test",
        "D:\\Users\\test",
        false,
      );

      expect(result).toBe('const path = "D:\\Users\\test"');
    });

    it("should handle parentheses", () => {
      const content = "function test() { return 'old'; }";
      const result = executeFindAndReplace(
        content,
        "() { return 'old'; }",
        "() { return 'new'; }",
        false,
      );

      expect(result).toBe("function test() { return 'new'; }");
    });

    it("should handle square brackets", () => {
      const content = "const arr = [1, 2, 3];";
      const result = executeFindAndReplace(
        content,
        "[1, 2, 3]",
        "[4, 5, 6]",
        false,
      );

      expect(result).toBe("const arr = [4, 5, 6];");
    });
  });

  describe("replaceAll behavior", () => {
    it("should replace all occurrences including partial matches", () => {
      const content = "test testing tested test";
      const result = executeFindAndReplace(content, "test", "exam", true);

      expect(result).toBe("exam examing examed exam");
    });

    it("should replace all occurrences with empty string", () => {
      const content = "remove this remove that remove everything";
      const result = executeFindAndReplace(content, "remove ", "", true);

      expect(result).toBe("this that everything");
    });

    it("should handle overlapping patterns correctly", () => {
      const content = "aaaa";
      const result = executeFindAndReplace(content, "aa", "b", true);

      expect(result).toBe("bb");
    });
  });

  describe("error cases", () => {
    it("should throw error when string not found", () => {
      const content = "Hello world";

      expect(() => {
        executeFindAndReplace(content, "xyz", "abc", false);
      }).toThrowError(
        expect.objectContaining({
          reason: ContinueErrorReason.FindAndReplaceOldStringNotFound,
        }),
      );
    });

    it("should throw error with edit context when string not found", () => {
      const content = "Hello world";

      expect(() => {
        executeFindAndReplace(content, "xyz", "abc", false, 2);
      }).toThrowError(
        expect.objectContaining({
          reason: ContinueErrorReason.FindAndReplaceOldStringNotFound,
        }),
      );
    });

    it("should throw error when multiple occurrences exist and replaceAll is false", () => {
      const content = "Hello world\nHello again\nHello there";

      expect(() => {
        executeFindAndReplace(content, "Hello", "Hi", false);
      }).toThrowError(
        expect.objectContaining({
          reason: ContinueErrorReason.FindAndReplaceMultipleOccurrences,
        }),
      );
    });

    it("should throw error with edit context for multiple occurrences", () => {
      const content = "test test test";

      expect(() => {
        executeFindAndReplace(content, "test", "exam", false, 1);
      }).toThrowError(
        expect.objectContaining({
          reason: ContinueErrorReason.FindAndReplaceMultipleOccurrences,
        }),
      );
    });
  });

  describe("indentation adjustment", () => {
    it("should adjust indentation when trimmedMatch finds unindented old_string in indented file", () => {
      const fileContent =
        "def foo():\n    x = 1\n    y = 2\n    return x + y\n";
      // LLM sends unindented old_string that matches via trimmedMatch
      const oldString = "x = 1\ny = 2";
      const newString = "x = 10\ny = 20";
      const result = executeFindAndReplace(
        fileContent,
        oldString,
        newString,
        false,
      );
      expect(result).toBe(
        "def foo():\n    x = 10\n    y = 20\n    return x + y\n",
      );
    });

    it("should preserve relative inner indentation in multi-line replacement", () => {
      const fileContent =
        "class Foo:\n    def bar(self):\n        if True:\n            x = 1\n";
      const oldString = "if True:\n    x = 1";
      const newString = "if True:\n    x = 1\n    y = 2";
      const result = executeFindAndReplace(
        fileContent,
        oldString,
        newString,
        false,
      );
      expect(result).toBe(
        "class Foo:\n    def bar(self):\n        if True:\n            x = 1\n            y = 2\n",
      );
    });

    it("should handle tab vs space mismatch", () => {
      const fileContent = "function foo() {\n\tconst x = 1;\n}\n";
      // LLM sends with leading spaces (not tabs), triggering trimmedMatch
      const oldString = "  const x = 1;";
      const newString = "  const x = 2;\n  const y = 3;";
      const result = executeFindAndReplace(
        fileContent,
        oldString,
        newString,
        false,
      );
      expect(result).toBe(
        "function foo() {\n\tconst x = 2;\n\tconst y = 3;\n}\n",
      );
    });

    it("should not adjust indentation for exactMatch", () => {
      const fileContent = "    x = 1\n";
      const oldString = "    x = 1";
      const newString = "    x = 2";
      const result = executeFindAndReplace(
        fileContent,
        oldString,
        newString,
        false,
      );
      expect(result).toBe("    x = 2\n");
    });

    it("should handle whitespaceIgnoredMatch with different internal whitespace", () => {
      const fileContent = "def outer():\n    if  True:\n        return  42\n";
      // Different internal whitespace triggers whitespaceIgnoredMatch
      const oldString = "if True:\n    return 42";
      const newString = "if True:\n    return 99";
      const result = executeFindAndReplace(
        fileContent,
        oldString,
        newString,
        false,
      );
      expect(result).toBe("def outer():\n    if True:\n        return 99\n");
    });
  });

  describe("edge cases", () => {
    it("should handle single character replacement", () => {
      const content = "a b c";
      const result = executeFindAndReplace(content, "b", "x", false);

      expect(result).toBe("a x c");
    });

    it("should handle very long strings", () => {
      const longString = "a".repeat(10000);
      const content = `start${longString}end`;
      const result = executeFindAndReplace(content, longString, "short", false);

      expect(result).toBe("startshortend");
    });

    it("should handle strings at beginning of content", () => {
      const content = "start middle end";
      const result = executeFindAndReplace(content, "start", "begin", false);

      expect(result).toBe("begin middle end");
    });

    it("should handle strings at end of content", () => {
      const content = "start middle end";
      const result = executeFindAndReplace(content, "end", "finish", false);

      expect(result).toBe("start middle finish");
    });

    it("should handle entire content replacement", () => {
      const content = "replace everything";
      const result = executeFindAndReplace(
        content,
        "replace everything",
        "new content",
        false,
      );

      expect(result).toBe("new content");
    });
  });
});

describe("executeFindAndReplace line endings", () => {
  const bytes = (s: string) => Buffer.from(s, "utf8").toString("hex");
  const crlf = "alpha\r\nbeta\r\ngamma\r\ndelta";

  it("multi-line LF edit on a CRLF file writes CRLF (exact bytes)", () => {
    const result = executeFindAndReplace(
      crlf,
      "beta\ngamma",
      "BETA\nGAMMA",
      false,
    );
    expect(result).toBe("alpha\r\nBETA\r\nGAMMA\r\ndelta");
    expect(bytes(result)).toBe(bytes("alpha\r\nBETA\r\nGAMMA\r\ndelta"));
  });

  it("single-line edit on a CRLF file is unchanged", () => {
    expect(executeFindAndReplace(crlf, "beta", "BETA", false)).toBe(
      "alpha\r\nBETA\r\ngamma\r\ndelta",
    );
  });

  it("a single-line match gaining lines takes the file's CRLF", () => {
    expect(executeFindAndReplace(crlf, "beta", "b1\nb2", false)).toBe(
      "alpha\r\nb1\r\nb2\r\ngamma\r\ndelta",
    );
  });

  it("does not double the CR when new_string already uses CRLF", () => {
    expect(
      executeFindAndReplace(crlf, "beta\r\ngamma", "BETA\r\nGAMMA", false),
    ).toBe("alpha\r\nBETA\r\nGAMMA\r\ndelta");
  });

  it("replace_all converts every replacement", () => {
    const content = "a\r\nb\r\nx\r\na\r\nb\r\ny\r\n";
    expect(executeFindAndReplace(content, "a\nb", "1\n2\n3", true)).toBe(
      "1\r\n2\r\n3\r\nx\r\n1\r\n2\r\n3\r\ny\r\n",
    );
  });

  it("mixed endings keep each line's own ending when the region is mixed", () => {
    const content = "one\r\ntwo\nthree\r\nfour\n";
    expect(
      executeFindAndReplace(content, "one\ntwo\nthree", "A\nB\nC", false),
    ).toBe("A\r\nB\nC\r\nfour\n");
  });

  it("mixed file: an all-LF region stays LF, an all-CRLF region stays CRLF", () => {
    const content = "a\r\nb\r\nc\r\nx\ny\nz\n";
    expect(executeFindAndReplace(content, "x\ny", "X\nY", false)).toBe(
      "a\r\nb\r\nc\r\nX\nY\nz\n",
    );
    expect(executeFindAndReplace(content, "a\nb", "A\nB", false)).toBe(
      "A\r\nB\r\nc\r\nx\ny\nz\n",
    );
  });

  it("empty old_string inserts at the start of a CRLF file with CRLF", () => {
    expect(executeFindAndReplace("x\r\ny\r\n", "", "h1\nh2\n", false)).toBe(
      "h1\r\nh2\r\nx\r\ny\r\n",
    );
  });

  it("empty old_string on an empty file leaves new_string as written", () => {
    expect(executeFindAndReplace("", "", "a\nb\n", false)).toBe("a\nb\n");
  });

  it("preserves a missing trailing newline", () => {
    const content = "alpha\r\nbeta\r\ngamma";
    expect(executeFindAndReplace(content, "beta\ngamma", "B\nG", false)).toBe(
      "alpha\r\nB\r\nG",
    );
  });

  it("preserves a trailing CRLF", () => {
    expect(executeFindAndReplace("a\r\nb\r\n", "a\nb\n", "A\nB\n", false)).toBe(
      "A\r\nB\r\n",
    );
  });

  it("LF files are unchanged, and CRLF in new_string follows the LF region", () => {
    const content = "alpha\nbeta\ngamma\n";
    expect(executeFindAndReplace(content, "beta\ngamma", "B\nG", false)).toBe(
      "alpha\nB\nG\n",
    );
    expect(executeFindAndReplace(content, "beta\ngamma", "B\r\nG", false)).toBe(
      "alpha\nB\nG\n",
    );
  });
});
