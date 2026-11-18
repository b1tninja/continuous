import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writePlanText } from "../plans/planStore.js";

import { editTool } from "./edit.js";
import { multiEditTool } from "./multiEdit.js";
import { writeFileTool } from "./writeFile.js";

vi.mock("../telemetry/telemetryService.js");

// The file tools and the plan file write through the shared temp-file-and-
// rename helper. These tests use the real file system in a temp folder.
describe("file tools write by temp file and rename", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-atomic-tools-"));
    file = path.join(dir, "target.txt");
    fs.writeFileSync(file, "one\r\ntwo\r\n");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function failTheWrite() {
    // The disk fills while the new contents are being written.
    const realWrite = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((target, data) => {
      if (typeof target === "number") {
        const error: NodeJS.ErrnoException = new Error(
          "ENOSPC: no space left on device, write",
        );
        error.code = "ENOSPC";
        throw error;
      }
      realWrite(target, data as string);
    });
  }

  const NEW = "one\r\nTWO\r\n";
  const OLD = "one\r\ntwo\r\n";
  const writers: [string, (target: string) => Promise<unknown>][] = [
    [
      "Edit",
      (target) =>
        editTool.run({
          resolvedPath: target,
          newContent: NEW,
          oldContent: OLD,
        }),
    ],
    [
      "MultiEdit",
      (target) =>
        multiEditTool.run({
          file_path: target,
          newContent: NEW,
          originalContent: OLD,
          editCount: 1,
        }),
    ],
    [
      "Write",
      (target) => writeFileTool.run({ filepath: target, content: NEW }),
    ],
  ];

  it.each(writers)(
    "%s replaces the file, keeps its line endings and leaves no temp file",
    async (_name, run) => {
      await run(file);
      expect(fs.readFileSync(file, "utf8")).toBe("one\r\nTWO\r\n");
      expect(fs.readdirSync(dir)).toEqual(["target.txt"]);
    },
  );

  it.each(writers)(
    "%s leaves the original complete when the write fails part way",
    async (_name, run) => {
      failTheWrite();
      await expect(run(file)).rejects.toThrow(/ENOSPC/);
      vi.restoreAllMocks();
      expect(fs.readFileSync(file, "utf8")).toBe("one\r\ntwo\r\n");
      expect(fs.readdirSync(dir)).toEqual(["target.txt"]);
    },
  );

  it("the plan file is replaced the same way", () => {
    const plan = path.join(dir, "plan.md");
    fs.writeFileSync(plan, "- [ ] first\n");
    writePlanText(plan, "- [x] first\n");
    expect(fs.readFileSync(plan, "utf8")).toBe("- [x] first\n");

    failTheWrite();
    expect(() => writePlanText(plan, "- [ ] broken\n")).toThrow(/ENOSPC/);
    vi.restoreAllMocks();
    expect(fs.readFileSync(plan, "utf8")).toBe("- [x] first\n");
    expect(fs.readdirSync(dir).sort()).toEqual(["plan.md", "target.txt"]);
  });
});
