import { canarySecrets } from "core/util/secretScan/canary";
import { describe, expect, it } from "vitest";
import { classifyDrop } from "./classifyDrop";
import {
  fakeDirEntry,
  fakeFile,
  osEntryDrag,
  osFileDrag,
  textFile,
} from "./dropFixtures";
import {
  MAX_SNAPSHOT_FILES,
  MAX_SNAPSHOT_MESSAGE_BYTES,
  SNAPSHOT_PROVIDER,
  snapshotContextItem,
} from "./osSnapshot";
import { describeDropOutcome, DropOutcome } from "./resolveDrop";
import { snapshotBudgetOf, snapshotDrop } from "./snapshotDrop";

const none = { files: 0, bytes: 0 };

function outcomeOf(
  result: Awaited<ReturnType<typeof snapshotDrop>>,
): DropOutcome {
  return {
    files: 0,
    folders: [],
    images: 0,
    text: false,
    links: 0,
    hiddenRemoved: result.hiddenRemoved,
    refusals: result.refusals,
    snapshots: result.fromFiles,
    snapshotFolders: result.folders,
  };
}

describe("snapshotDrop", () => {
  it("adds text files and refuses the rest, saying why", async () => {
    const { awsAccessKey } = canarySecrets();
    const items = classifyDrop(
      osFileDrag(
        textFile("notes.md", "hello"),
        textFile(".env.local", "A=1"),
        textFile("blob.dat", new Uint8Array([1, 0, 2, 0])),
        textFile("leak.txt", `aws ${awsAccessKey}`),
        textFile("big.log", "x".repeat(300 * 1024)),
      ),
    );
    const result = await snapshotDrop(items, none);
    expect(result.snapshots.map((s) => s.name)).toEqual(["notes.md"]);
    expect(result.refusals).toEqual([
      { name: ".env.local", reason: "secret", detail: undefined },
      { name: "blob.dat", reason: "binary", detail: undefined },
      {
        name: "leak.txt",
        reason: "secret-content",
        detail: expect.stringContaining("aws"),
      },
      { name: "big.log", reason: "snapshot-too-large", detail: undefined },
    ]);
    const text = describeDropOutcome(outcomeOf(result));
    expect(text).toBe(
      "Added 1 file from outside the editor as a snapshot (not kept in sync). " +
        "Not added: .env.local looks like it holds secrets or keys; " +
        "blob.dat looks like a binary file, not UTF-8 or UTF-16 text; " +
        `leak.txt contains what looks like a secret (${result.refusals[2].detail}), so none of it was attached; ` +
        "big.log is larger than 200 KB.",
    );
    expect(text).not.toContain(awsAccessKey);
  });

  it("counts snapshots already in the message against the file cap, reading nothing past it", async () => {
    const extra = textFile("one-more.txt", "x");
    const items = classifyDrop(osFileDrag(textFile("ok.txt", "x"), extra));
    const result = await snapshotDrop(items, {
      files: MAX_SNAPSHOT_FILES - 1,
      bytes: 0,
    });
    expect(result.snapshots.map((s) => s.name)).toEqual(["ok.txt"]);
    expect(result.refusals).toEqual([
      { name: "one-more.txt", reason: "snapshot-limit" },
    ]);
    expect(extra.reads).toBe(0);
    expect(describeDropOutcome(outcomeOf(result))).toContain(
      "a message can hold at most 20 dropped files",
    );
  });

  it("refuses a file that would take the message past 1 MB", async () => {
    const items = classifyDrop(osFileDrag(textFile("b.txt", "x".repeat(100))));
    const result = await snapshotDrop(items, {
      files: 1,
      bytes: MAX_SNAPSHOT_MESSAGE_BYTES - 50,
    });
    expect(result.refusals).toEqual([
      { name: "b.txt", reason: "snapshot-total" },
    ]);
    expect(describeDropOutcome(outcomeOf(result))).toContain(
      "can add up to at most 1 MB",
    );
  });

  it("adds a folder's text files and summarises what it left out", async () => {
    const folder = fakeDirEntry("notes", {
      "a.md": "alpha",
      "b.md": "beta",
      "pic.bin": new Uint8Array([0, 1, 2]),
      id_rsa: "x",
      node_modules: { "x.js": "x" },
      sub: { "c.txt": "gamma", deeper: { "d.txt": "delta" } },
    });
    const items = classifyDrop(
      osEntryDrag([[fakeFile("notes", "", 0), folder]]),
    );
    const result = await snapshotDrop(items, none);
    expect(result.snapshots.map((s) => s.name)).toEqual([
      "notes/a.md",
      "notes/b.md",
      "notes/sub/c.txt",
    ]);
    expect(result.folders).toEqual([
      {
        name: "notes",
        added: 3,
        skipped: { binary: 1, secret: 1, "ignored-folder": 1 },
        tooDeep: true,
        truncated: false,
      },
    ]);
    expect(result.refusals).toEqual([]);
    expect(describeDropOutcome(outcomeOf(result))).toBe(
      "Added 3 files from folder notes as snapshots (not kept in sync). " +
        "From notes, left out 1 binary file, 1 file that may hold secrets (by name or content), " +
        "1 folder not opened (node_modules, .git, dist or a secrets folder), " +
        "folders more than 2 levels down.",
    );
  });

  it("stops a folder at the file cap", async () => {
    const spec: Record<string, string> = {};
    for (let i = 0; i < 25; i++)
      spec[`f${String(i).padStart(2, "0")}.txt`] = "x";
    const items = classifyDrop(
      osEntryDrag([[fakeFile("many", "", 0), fakeDirEntry("many", spec)]]),
    );
    const result = await snapshotDrop(items, none);
    expect(result.snapshots).toHaveLength(MAX_SNAPSHOT_FILES);
    expect(result.folders[0].skipped).toEqual({ limit: 5 });
  });

  it("refuses a folder with nothing to add, and one it cannot list", async () => {
    const empty = fakeDirEntry("bin", { "a.exe": new Uint8Array([0, 0]) });
    const unlistable = {
      name: "opaque",
      isFile: false,
      isDirectory: true,
    };
    const items = classifyDrop(
      osEntryDrag([
        [fakeFile("bin", "", 0), empty],
        [fakeFile("opaque", "", 0), unlistable],
      ]),
    );
    const result = await snapshotDrop(items, none);
    expect(result.snapshots).toEqual([]);
    expect(result.refusals).toEqual([
      { name: "bin", reason: "folder-empty" },
      { name: "opaque", reason: "folder-unavailable" },
    ]);
    const text = describeDropOutcome(outcomeOf(result));
    expect(text).toContain("folder bin has no text files that could be added");
    expect(text).toContain(
      'opaque is a folder, and this editor cannot list a dropped folder\'s files (use "Select Files as Context"',
    );
  });
});

describe("snapshotBudgetOf", () => {
  it("counts snapshot chips and their bytes, and nothing else", () => {
    const item = snapshotContextItem({
      name: "a.txt",
      text: "héllo",
      bytes: 6,
      hiddenRemoved: 0,
    });
    expect(item.id.providerTitle).toBe(SNAPSHOT_PROVIDER);
    const doc = {
      type: "doc",
      content: [
        { type: "code-block", attrs: { item } },
        {
          type: "code-block",
          attrs: {
            item: { ...item, id: { providerTitle: "code", itemId: "c" } },
          },
        },
        { type: "paragraph", content: [{ type: "text", text: "hi" }] },
      ],
    };
    expect(snapshotBudgetOf(doc)).toEqual({ files: 1, bytes: 6 });
  });
});
