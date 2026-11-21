import { describe, expect, it, vi } from "vitest";

// What the chat webview ships for Node's path, path/posix, fs and os: empty
// modules, so every property read from them is undefined.
const empty = vi.hoisted(
  () =>
    new Proxy(
      {},
      {
        get: (_t, k) => (k === "default" ? empty : undefined),
        has: () => true,
      },
    ),
);
vi.mock("node:path", () => empty);
vi.mock("path", () => empty);
vi.mock("node:path/posix", () => empty);
vi.mock("node:os", () => empty);

import type { IDE } from "..";
import { cleanPath } from "../tools/permissions/names";
import {
  defaultHome,
  normalizeProtectedPath,
  protectedPathHit,
} from "../tools/permissions/protected";
import { checkpointHoldsSecret, snapshotFile } from "./checkpoints";

/**
 * Regression: in the chat webview the checkpoint code threw on every file,
 * because protectedPathHit called os.homedir() and posix.* on empty modules.
 * snapshotFile caught the throw and recorded each file as "unreadable", so
 * "Restore to here" had nothing to restore for any file the agent edited. In 163
 * saved snapshots, 124 were "unreadable" and none held content. The secret check
 * must also still WORK there: a key must not be copied into the session file.
 */
function ide(files: Record<string, string>): IDE {
  return {
    fileExists: async (u: string) => u in files,
    readFile: async (u: string) => files[u],
    getFileStats: async (us: string[]) =>
      Object.fromEntries(us.map((u) => [u, { size: files[u]?.length ?? 0 }])),
  } as unknown as IDE;
}

describe("with no Node path or os, as in the chat webview", () => {
  it("the stand-ins really are empty (this test would not catch the bug otherwise)", async () => {
    const os = (await import("node:os")) as unknown as Record<string, unknown>;
    const posix = (await import("node:path/posix")) as unknown as Record<
      string,
      unknown
    >;
    expect(os.homedir).toBeUndefined();
    expect(posix.normalize).toBeUndefined();
  });

  it("there is no home folder to find, and asking does not throw", () => {
    expect(defaultHome()).toBe("");
  });

  describe("snapshotFile", () => {
    it("saves the content of an ordinary file", async () => {
      const uri = "file:///c%3A/github/proj/src/a.ts";
      const r = await snapshotFile(ide({ [uri]: "const a = 1;\n" }), uri);
      expect(r).toEqual({ uri, existed: true, content: "const a = 1;\n" });
    });

    it("records a file that does not exist yet as new", async () => {
      const uri = "file:///c%3A/github/proj/new.ts";
      expect(await snapshotFile(ide({}), uri)).toEqual({ uri, existed: false });
    });

    it("does not copy a secret file's content", async () => {
      for (const uri of [
        "file:///c%3A/github/proj/.env",
        "file:///c%3A/github/proj/server.pem",
        "file:///c%3A/Users/alice/.ssh/id_rsa",
        "file:///home/alice/.aws/credentials",
        "file:///c%3A/github/proj/id_ed25519",
      ]) {
        const r = await snapshotFile(ide({ [uri]: "SECRET" }), uri);
        expect(r.skipped, uri).toBe("secret");
        expect(r.content, uri).toBeUndefined();
      }
    });

    it("a file that is not a secret is not skipped as one", async () => {
      for (const uri of [
        "file:///c%3A/github/proj/README.md",
        "file:///c%3A/github/proj/.env.example",
        "file:///c%3A/github/proj/src/environment.ts",
      ]) {
        const r = await snapshotFile(ide({ [uri]: "x" }), uri);
        expect(r.skipped, uri).toBeUndefined();
        expect(r.content, uri).toBe("x");
      }
    });
  });

  describe("checkpointHoldsSecret", () => {
    it("is true for secrets and false for ordinary files", () => {
      expect(checkpointHoldsSecret("file:///c%3A/p/.env")).toBe(true);
      expect(checkpointHoldsSecret("file:///home/u/.ssh/id_rsa")).toBe(true);
      expect(checkpointHoldsSecret("file:///c%3A/p/src/a.ts")).toBe(false);
    });
  });

  describe("protectedPathHit", () => {
    it("finds a secret by its file name, extension, and home-relative shape", () => {
      const hit = (p: string) => protectedPathHit(p, ["secret"])?.kind;
      expect(hit("proj/.env")).toBe("secret");
      expect(hit("keys/server.pem")).toBe("secret");
      expect(hit("/home/alice/.ssh/id_rsa")).toBe("secret");
      expect(hit("C:/Users/alice/.aws/credentials")).toBe("secret");
      expect(hit("c:\\Users\\alice\\.gnupg\\key")).toBe("secret");
    });

    it("a path that climbs back into a secret folder is still found", () => {
      expect(
        protectedPathHit("/home/alice/proj/../.ssh/id_rsa", ["secret"])?.kind,
      ).toBe("secret");
    });

    it("an ordinary path is not a hit", () => {
      expect(protectedPathHit("src/a.ts", ["secret"])).toBeUndefined();
      expect(
        protectedPathHit("/home/alice/proj/a.ts", ["secret"]),
      ).toBeUndefined();
    });

    it("a relative path is resolved against the working folder", () => {
      expect(
        protectedPathHit("../.ssh/id_rsa", ["secret"], "", "/home/alice/proj")
          ?.kind,
      ).toBe("secret");
    });
  });

  describe("normalizeProtectedPath and cleanPath", () => {
    it("fold . and .. and slashes without Node", () => {
      expect(normalizeProtectedPath("/a/b/../c", "")).toBe("/a/c");
      expect(normalizeProtectedPath("C:\\a\\.\\b", "")).toBe("C:/a/b");
      expect(cleanPath("a/../b")).toBe("b");
      expect(cleanPath("./src//a.ts")).toBe("src/a.ts");
    });
  });
});
