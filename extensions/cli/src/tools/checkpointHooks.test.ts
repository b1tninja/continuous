import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkpointStoreFor } from "../checkpoints/sessionCheckpoints.js";
import { getCurrentSession, updateSessionHistory } from "../session.js";

import { editTool } from "./edit.js";
import { multiEditTool } from "./multiEdit.js";
import { writeFileTool } from "./writeFile.js";

vi.mock("../telemetry/telemetryService.js");

// The three file tools snapshot their target before writing, so /rewind can
// put it back. Real file system, in a temp folder; the checkpoint store lives
// in this worker's temp global folder (vitest.global-dir-setup.ts).
describe("file tools take a checkpoint before they write", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "cn-ckpt-hooks-")),
    );
    updateSessionHistory([
      { message: { role: "user", content: "rename foo" }, contextItems: [] },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CONTINUOUS_CHECKPOINTS;
    checkpointStoreFor(getCurrentSession().sessionId).deleteAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const store = () => checkpointStoreFor(getCurrentSession().sessionId);

  it("Edit, MultiEdit and Write are all captured in the prompt's turn", async () => {
    const a = path.join(dir, "a.txt");
    const b = path.join(dir, "b.txt");
    const c = path.join(dir, "c.txt");
    fs.writeFileSync(a, "foo\n");
    fs.writeFileSync(b, "foo foo\n");

    await editTool.run({
      resolvedPath: a,
      newContent: "bar\n",
      oldContent: "foo\n",
    });
    await multiEditTool.run({
      file_path: b,
      newContent: "bar bar\n",
      originalContent: "foo foo\n",
      editCount: 2,
    });
    await writeFileTool.run({ filepath: c, content: "new\n" });

    const turns = store().turns();
    expect(turns).toHaveLength(1);
    expect(turns[0].label).toBe("rename foo");
    expect(turns[0].files.map((f) => [f.uri, f.existed])).toEqual([
      [a, true],
      [b, true],
      [c, false],
    ]);

    // And the rewind puts every one back
    const result = store().rewind(turns[0].turnId);
    expect(result.refused).toEqual([]);
    expect(fs.readFileSync(a, "utf8")).toBe("foo\n");
    expect(fs.readFileSync(b, "utf8")).toBe("foo foo\n");
    expect(fs.existsSync(c)).toBe(false);
  });

  it("a write after the agent's own write is not flagged as an outside change", async () => {
    const a = path.join(dir, "a.txt");
    fs.writeFileSync(a, "1");
    await writeFileTool.run({ filepath: a, content: "2" });
    await writeFileTool.run({ filepath: a, content: "3" });
    const [item] = store().planRewind(store().turns()[0].turnId);
    expect(item).toMatchObject({ action: "restore", changedOutside: false });
  });

  it("a checkpoint failure never blocks the write", async () => {
    const a = path.join(dir, "a.txt");
    fs.writeFileSync(a, "1");
    const s = store();
    vi.spyOn(s, "snapshotBefore").mockImplementation(() => {
      throw new Error("disk full");
    });
    await writeFileTool.run({ filepath: a, content: "2" });
    expect(fs.readFileSync(a, "utf8")).toBe("2");
  });

  it("CONTINUOUS_CHECKPOINTS=off turns snapshots off", async () => {
    process.env.CONTINUOUS_CHECKPOINTS = "off";
    const a = path.join(dir, "a.txt");
    await writeFileTool.run({ filepath: a, content: "x" });
    expect(store().turns()).toEqual([]);
  });

  it("nothing is written into the workspace", async () => {
    const a = path.join(dir, "a.txt");
    fs.writeFileSync(a, "1");
    await writeFileTool.run({ filepath: a, content: "2" });
    expect(fs.readdirSync(dir)).toEqual(["a.txt"]);
  });
});
