import { describe, expect, it } from "vitest";
import type { IDE, ToolExtras } from "../../index.js";
import { multiEditImpl, singleFindAndReplaceImpl } from "./exactEdits.js";

const WORKTREE = "file:///tmp/worktree";

/** An IDE over one in-memory file tree. */
function fakeIde(files: Record<string, string>) {
  return {
    files,
    ide: {
      getWorkspaceDirs: async () => [WORKTREE],
      fileExists: async (uri: string) => uri in files,
      readFile: async (uri: string) => files[uri] ?? "",
      writeFile: async (uri: string, contents: string) => {
        files[uri] = contents;
      },
    } as unknown as IDE,
  };
}

function extrasFor(ide: IDE, workspaceDirs?: string[]): ToolExtras {
  return { ide, workspaceDirs } as unknown as ToolExtras;
}

describe("the exact edit tools in core", () => {
  it("single_find_and_replace rewrites the file in the given checkout", async () => {
    const { ide, files } = fakeIde({
      [`${WORKTREE}/src/a.ts`]: "a = 1;\nb = 1;\n",
    });
    const out = await singleFindAndReplaceImpl(
      { filepath: "src/a.ts", old_string: "a = 1", new_string: "a = 2" },
      extrasFor(ide, [WORKTREE]),
    );
    expect(files[`${WORKTREE}/src/a.ts`]).toBe("a = 2;\nb = 1;\n");
    expect(out[0].name).toBe("Edited a.ts");
  });

  it("multi_edit applies every edit, in order", async () => {
    const { ide, files } = fakeIde({
      [`${WORKTREE}/src/a.ts`]: "a = 1;\nb = 1;\n",
    });
    await multiEditImpl(
      {
        filepath: "src/a.ts",
        edits: [
          { old_string: "a = 1", new_string: "a = 2" },
          { old_string: "b = 1", new_string: "b = 3" },
        ],
      },
      extrasFor(ide, [WORKTREE]),
    );
    expect(files[`${WORKTREE}/src/a.ts`]).toBe("a = 2;\nb = 3;\n");
  });

  it("refuses a call without a working directory of its own: that edit is the client's", async () => {
    const { ide, files } = fakeIde({ [`${WORKTREE}/src/a.ts`]: "a = 1;\n" });
    await expect(
      singleFindAndReplaceImpl(
        { filepath: "src/a.ts", old_string: "a = 1", new_string: "a = 2" },
        extrasFor(ide),
      ),
    ).rejects.toThrow(/diff review/);
    expect(files[`${WORKTREE}/src/a.ts`]).toBe("a = 1;\n");
  });

  it("fails as the client would on text that is not there or not unique", async () => {
    const { ide } = fakeIde({ [`${WORKTREE}/src/a.ts`]: "x = 1;\nx = 1;\n" });
    await expect(
      singleFindAndReplaceImpl(
        { filepath: "src/a.ts", old_string: "x = 1", new_string: "x = 2" },
        extrasFor(ide, [WORKTREE]),
      ),
    ).rejects.toThrow();
    await expect(
      singleFindAndReplaceImpl(
        { filepath: "src/a.ts", old_string: "nope", new_string: "x" },
        extrasFor(ide, [WORKTREE]),
      ),
    ).rejects.toThrow();
  });

  it("both tools reject a whitespace-only old_string and leave the file alone", async () => {
    const uri = `${WORKTREE}/src/a.ts`;
    const { ide, files } = fakeIde({ [uri]: "a = 1;\n" });
    for (const ws of ["   ", "\n", "    "]) {
      await expect(
        singleFindAndReplaceImpl(
          { filepath: "src/a.ts", old_string: ws, new_string: "x" },
          extrasFor(ide, [WORKTREE]),
        ),
      ).rejects.toThrow(/only whitespace/);
      await expect(
        multiEditImpl(
          {
            filepath: "src/a.ts",
            edits: [{ old_string: ws, new_string: "x" }],
          },
          extrasFor(ide, [WORKTREE]),
        ),
      ).rejects.toThrow(/only whitespace/);
    }
    expect(files[uri]).toBe("a = 1;\n");
  });

  it("an empty old_string still inserts at the top through both tools", async () => {
    const uri = `${WORKTREE}/src/a.ts`;
    const { ide, files } = fakeIde({ [uri]: "a = 1;\n" });
    await singleFindAndReplaceImpl(
      { filepath: "src/a.ts", old_string: "", new_string: "// top\n" },
      extrasFor(ide, [WORKTREE]),
    );
    expect(files[uri]).toBe("// top\na = 1;\n");
    await multiEditImpl(
      {
        filepath: "src/a.ts",
        edits: [{ old_string: "", new_string: "// first\n" }],
      },
      extrasFor(ide, [WORKTREE]),
    );
    expect(files[uri]).toBe("// first\n// top\na = 1;\n");
  });
});

describe("the exact edit tools keep CRLF files CRLF", () => {
  const uri = `${WORKTREE}/src/c.txt`;

  it("single_find_and_replace writes CRLF for a multi-line LF edit", async () => {
    const { ide, files } = fakeIde({
      [uri]: "alpha\r\nbeta\r\ngamma\r\ndelta",
    });
    await singleFindAndReplaceImpl(
      {
        filepath: "src/c.txt",
        old_string: "beta\ngamma",
        new_string: "BETA\nGAMMA",
      },
      extrasFor(ide, [WORKTREE]),
    );
    expect(Buffer.from(files[uri]).toString("hex")).toBe(
      Buffer.from("alpha\r\nBETA\r\nGAMMA\r\ndelta").toString("hex"),
    );
  });

  it("multi_edit writes CRLF for every multi-line edit", async () => {
    const { ide, files } = fakeIde({ [uri]: "a\r\nb\r\nc\r\nd\r\n" });
    await multiEditImpl(
      {
        filepath: "src/c.txt",
        edits: [
          { old_string: "a\nb", new_string: "A\nB" },
          { old_string: "c\nd\n", new_string: "C\nD\nE\n" },
        ],
      },
      extrasFor(ide, [WORKTREE]),
    );
    expect(files[uri]).toBe("A\r\nB\r\nC\r\nD\r\nE\r\n");
  });
});
