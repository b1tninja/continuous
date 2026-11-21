import { describe, expect, test, vi } from "vitest";
import { createNewFileImpl } from "./createNewFile";

vi.mock("../../util/ideUtils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../util/ideUtils")>()),
  inferResolvedUriFromRelativePath: async (path: string) => `file:///w/${path}`,
}));

function extrasWith(
  files: Record<string, string>,
  opened: Array<[string, unknown]> = [],
  saved: string[] = [],
) {
  const ide = {
    fileExists: async (uri: string) => uri in files,
    readFile: async (uri: string) => files[uri],
    writeFile: async (uri: string, contents: string) => {
      files[uri] = contents;
    },
    openFile: async (uri: string, options?: unknown) => {
      opened.push([uri, options]);
    },
    saveFile: async (uri: string) => {
      saved.push(uri);
    },
  };
  return { ide } as any;
}

const URI = "file:///w/report.md";

describe("create_new_file", () => {
  test("creates a file", async () => {
    const files: Record<string, string> = {};
    await createNewFileImpl(
      { filepath: "report.md", contents: "one\n" },
      extrasWith(files),
    );
    expect(files[URI]).toBe("one\n");
  });

  test("writes contents sent as a JSON value indented", async () => {
    const files: Record<string, string> = {};
    await createNewFileImpl(
      { filepath: "report.md", contents: { name: "x", list: [1, 2] } },
      extrasWith(files),
    );
    expect(files[URI]).toBe(
      '{\n  "name": "x",\n  "list": [\n    1,\n    2\n  ]\n}',
    );
  });

  test("shows the new file without taking the keyboard, then saves it", async () => {
    const files: Record<string, string> = {};
    const opened: Array<[string, unknown]> = [];
    const saved: string[] = [];
    await createNewFileImpl(
      { filepath: "report.md", contents: "one\n" },
      extrasWith(files, opened, saved),
    );
    expect(opened).toEqual([[URI, { preserveFocus: true }]]);
    expect(saved).toEqual([URI]);
  });

  test("an appended-to file is shown without focus too", async () => {
    const files = { [URI]: "one\n" };
    const opened: Array<[string, unknown]> = [];
    await createNewFileImpl(
      { filepath: "report.md", contents: "two\n", append: true },
      extrasWith(files, opened),
    );
    expect(opened).toEqual([[URI, { preserveFocus: true }]]);
  });

  test("never asks for focus", async () => {
    const files: Record<string, string> = {};
    const opened: Array<[string, { preserveFocus?: boolean } | undefined]> = [];
    await createNewFileImpl(
      { filepath: "report.md", contents: "x" },
      extrasWith(files, opened as any),
    );
    for (const [, options] of opened) expect(options?.preserveFocus).toBe(true);
  });

  test("refuses a file that exists, without append", async () => {
    const files = { [URI]: "kept" };
    await expect(
      createNewFileImpl(
        { filepath: "report.md", contents: "x" },
        extrasWith(files),
      ),
    ).rejects.toThrow("already exists");
    expect(files[URI]).toBe("kept");
  });

  test("append adds to the end of the file", async () => {
    const files = { [URI]: "one\n" };
    const result = await createNewFileImpl(
      { filepath: "report.md", contents: "two\n", append: true },
      extrasWith(files),
    );
    expect(files[URI]).toBe("one\ntwo\n");
    expect(result[0].content).toBe("Added to the file");
  });

  test("append needs the file to exist", async () => {
    const files: Record<string, string> = {};
    await expect(
      createNewFileImpl(
        { filepath: "report.md", contents: "x", append: true },
        extrasWith(files),
      ),
    ).rejects.toThrow("does not exist yet");
    expect(files[URI]).toBeUndefined();
  });
});
