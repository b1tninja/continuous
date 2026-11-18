import { canarySecrets } from "core/util/secretScan/canary";
import { describe, expect, it } from "vitest";
import {
  fakeDirEntry,
  fakeFileEntry,
  FolderSpec,
  textFile,
} from "./dropFixtures";
import {
  decodeText,
  displayName,
  isSecretName,
  isSnapshotItem,
  MAX_FOLDER_ENTRIES,
  MAX_SNAPSHOT_FILE_BYTES,
  MAX_SNAPSHOT_FILES,
  MAX_SNAPSHOT_MESSAGE_BYTES,
  readSnapshot,
  SNAPSHOT_DESCRIPTION,
  SNAPSHOT_PROVIDER,
  snapshotContextItem,
  walkFolder,
} from "./osSnapshot";

const utf8 = (s: string) => new TextEncoder().encode(s);

function utf16(s: string, bigEndian: boolean): Uint8Array {
  const out = new Uint8Array(2 + s.length * 2);
  out[0] = bigEndian ? 0xfe : 0xff;
  out[1] = bigEndian ? 0xff : 0xfe;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const hi = c >> 8;
    const lo = c & 0xff;
    out[2 + i * 2] = bigEndian ? hi : lo;
    out[3 + i * 2] = bigEndian ? lo : hi;
  }
  return out;
}

describe("the caps", () => {
  it("are the numbers the UI and the docs state", () => {
    expect(MAX_SNAPSHOT_FILE_BYTES).toBe(200 * 1024);
    expect(MAX_SNAPSHOT_MESSAGE_BYTES).toBe(1024 * 1024);
    expect(MAX_SNAPSHOT_FILES).toBe(20);
    expect(MAX_FOLDER_ENTRIES).toBe(200);
  });
});

describe("decodeText", () => {
  it("decodes UTF-8 and drops a UTF-8 byte order mark", () => {
    expect(decodeText(utf8("héllo ✓"))).toEqual({
      ok: true,
      text: "héllo ✓",
      encoding: "utf-8",
    });
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("a")]);
    expect(decodeText(bom)).toEqual({ ok: true, text: "a", encoding: "utf-8" });
  });

  it("decodes UTF-16 with either byte order mark", () => {
    expect(decodeText(utf16("héllo\nwörld", false))).toEqual({
      ok: true,
      text: "héllo\nwörld",
      encoding: "utf-16le",
    });
    expect(decodeText(utf16("héllo\nwörld", true))).toEqual({
      ok: true,
      text: "héllo\nwörld",
      encoding: "utf-16be",
    });
  });

  it("calls a file with a NUL byte binary", () => {
    expect(decodeText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1]))).toEqual({
      ok: false,
    });
    expect(
      decodeText(new Uint8Array([...utf8("text"), 0, ...utf8("x")])),
    ).toEqual({ ok: false });
  });

  it("calls UTF-16 with a NUL character binary", () => {
    expect(decodeText(utf16("a\u0000b", false))).toEqual({ ok: false });
  });

  it("tolerates one invalid UTF-8 sequence but not many", () => {
    const one = new Uint8Array([...utf8("a".repeat(50)), 0xff, ...utf8("b")]);
    expect(decodeText(one).ok).toBe(true);
    const many = new Uint8Array(200).map((_, i) => (i % 2 ? 0xff : 0x41));
    expect(decodeText(many)).toEqual({ ok: false });
  });
});

describe("isSecretName", () => {
  it.each([
    ".env",
    ".env.local",
    "server.pem",
    "prod.key",
    "id_rsa",
    "id_ed25519",
    "notes/.ssh/config",
    "proj/.aws/credentials",
  ])("refuses %s", (name) => {
    expect(isSecretName(name)).toBe(true);
  });

  it.each(["notes.txt", "main.py", "docs/README.md"])("accepts %s", (name) => {
    expect(isSecretName(name)).toBe(false);
  });
});

describe("readSnapshot", () => {
  it("reads a text file, removing hidden characters", async () => {
    const file = textFile("notes.md", "# Notes\nrun‮ this​\n");
    const result = await readSnapshot(file);
    expect(result).toEqual({
      ok: true,
      snapshot: {
        name: "notes.md",
        text: "# Notes\nrun this\n",
        bytes: 17,
        hiddenRemoved: 2,
      },
    });
  });

  it("refuses a credential file by name without reading it", async () => {
    for (const name of [".env", "id_rsa", "cert.pem", "api.key"]) {
      const file = textFile(name, "harmless");
      expect(await readSnapshot(file)).toEqual({ ok: false, reason: "secret" });
      expect(file.reads).toBe(0);
    }
  });

  it("refuses a file over the size cap without reading it, and takes one at the cap", async () => {
    const big = textFile("big.txt", "a".repeat(MAX_SNAPSHOT_FILE_BYTES + 1));
    expect(await readSnapshot(big)).toEqual({
      ok: false,
      reason: "snapshot-too-large",
    });
    expect(big.reads).toBe(0);
    const atCap = textFile("cap.txt", "a".repeat(MAX_SNAPSHOT_FILE_BYTES));
    expect((await readSnapshot(atCap)).ok).toBe(true);
  });

  it("refuses binary, empty and unreadable files", async () => {
    const png = textFile(
      "picture.bin",
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]),
    );
    expect(await readSnapshot(png)).toEqual({ ok: false, reason: "binary" });
    expect(await readSnapshot(textFile("empty.txt", ""))).toEqual({
      ok: false,
      reason: "empty",
    });
    expect(await readSnapshot(textFile("blank.txt", " \n​\n"))).toEqual({
      ok: false,
      reason: "empty",
    });
    const broken = {
      name: "gone.txt",
      type: "text/plain",
      size: 4,
      arrayBuffer: () => Promise.reject(new Error("NotReadableError")),
    };
    expect(await readSnapshot(broken)).toEqual({
      ok: false,
      reason: "unreadable",
    });
  });

  it("refuses every canary secret by content, naming the kind and never the value", async () => {
    const canaries = canarySecrets();
    for (const secret of canaries.all) {
      const file = textFile("settings.txt", `line one\ntoken: ${secret}\n`);
      const result = await readSnapshot(file);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe("secret-content");
      expect(result.detail).toBeTruthy();
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  it("finds a secret that a hidden character was splitting", async () => {
    const { anthropicKey } = canarySecrets();
    const split = `${anthropicKey.slice(0, 12)}​${anthropicKey.slice(12)}`;
    const result = await readSnapshot(textFile("a.txt", `key ${split}\n`));
    expect(result).toEqual(
      expect.objectContaining({ ok: false, reason: "secret-content" }),
    );
  });

  it("refuses a private key block by content", async () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MaJEjsb4lmgNWX5b",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const result = await readSnapshot(textFile("notes.txt", pem));
    expect(result).toEqual(
      expect.objectContaining({ ok: false, reason: "secret-content" }),
    );
  });

  it("does not call ordinary code a secret", async () => {
    const code = [
      "import os",
      "API_URL = 'https://example.com/v1'",
      "def main(token: str) -> None:",
      "    print(os.environ.get('HOME'))",
      "sha = 'da39a3ee5e6b4b0d3255bfef95601890afd80709'",
    ].join("\n");
    expect((await readSnapshot(textFile("main.py", code))).ok).toBe(true);
  });

  it("makes the label one clean line", () => {
    expect(displayName("a‮`b`\nc.txt")).toBe("a b c.txt");
  });
});

describe("snapshotContextItem", () => {
  it("is an inline context item with the name, the marker and no URI", () => {
    const item = snapshotContextItem({
      name: "notes.md",
      text: "hi",
      bytes: 2,
      hiddenRemoved: 0,
    });
    expect(item).toEqual({
      id: { providerTitle: SNAPSHOT_PROVIDER, itemId: expect.any(String) },
      name: "notes.md",
      description: SNAPSHOT_DESCRIPTION,
      content: "hi",
    });
    expect(item.uri).toBeUndefined();
    expect(isSnapshotItem(item)).toBe(true);
    expect(
      isSnapshotItem({ ...item, id: { providerTitle: "code", itemId: "x" } }),
    ).toBe(false);
  });
});

describe("walkFolder", () => {
  it("lists files two levels down, skipping heavy, secret and deeper folders", async () => {
    const spec: FolderSpec = {
      "README.md": "top",
      ".env": "SECRET=1",
      src: {
        "a.ts": "a",
        deep: { "too-deep.ts": "x" },
      },
      node_modules: { "x.js": "x" },
      ".git": { HEAD: "ref" },
      dist: { "out.js": "x" },
      ".ssh": { config: "Host x" },
    };
    const walk = await walkFolder(fakeDirEntry("proj", spec));
    expect(walk.files.map((f) => f.path)).toEqual([
      "proj/README.md",
      "proj/src/a.ts",
    ]);
    expect(walk.secretNames).toBe(1);
    expect(walk.skippedFolders).toBe(4);
    expect(walk.tooDeep).toBe(true);
    expect(walk.truncated).toBe(false);
  });

  it("reads every batch of a large folder and stops at the entry cap", async () => {
    const entries = Array.from({ length: 250 }, (_, i) =>
      fakeFileEntry(
        `f${String(i).padStart(3, "0")}.txt`,
        textFile(`f${i}.txt`, "x"),
      ),
    );
    const walk = await walkFolder(fakeDirEntry("big", entries));
    expect(walk.files).toHaveLength(MAX_FOLDER_ENTRIES);
    expect(walk.truncated).toBe(true);
  });
});
