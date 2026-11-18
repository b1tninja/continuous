import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  backupFolderName,
  chosenScopes,
  formatBytes,
  planReset,
  refuseRoot,
  RESET_BACKUP_DIR,
  resetCommand,
} from "./reset.js";

let home: string;
let root: string;
let out: string[];
let err: string[];
const io = {
  out: (l: string) => out.push(l),
  err: (l: string) => err.push(l),
};
const NOW = new Date("2026-11-12T20:15:03.123Z");

function put(relative: string, text = "x"): string {
  const file = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function exists(relative: string): boolean {
  return fs.existsSync(path.join(root, ...relative.split("/")));
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cn-reset-"));
  root = path.join(home, ".continuous");
  fs.mkdirSync(root);
  out = [];
  err = [];
  put("sessions/a.json", "{}");
  put("sessions/b.json", "{}");
  put("input_history.json", "[]");
  put("trusted-project.json", "{}");
  put("trusted-hooks.json", "{}");
  put("permissions.yaml", "levels:\n  tools: permissive\n");
  put("index/globalContext.json", "{}");
  put("index/lancedb/x.bin", "0123456789");
  put("bedrock-catalog/k.json", "{}");
  // What no scope may touch
  put("config.yaml", "name: mine\n");
  put(".env", "KEY=value\n");
  put("providers.yaml", "providers: []\n");
  put("settings.json", "{}");
  put("audit/s.jsonl", "{}\n");
  fs.mkdirSync(path.join(home, ".continue", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(home, ".continue", "sessions", "old.json"), "{}");
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("planning", () => {
  it("chooses scopes from the flags", () => {
    expect(chosenScopes({})).toEqual([]);
    expect(chosenScopes({ trust: true, sessions: true })).toEqual([
      "sessions",
      "trust",
    ]);
    expect(chosenScopes({ all: true })).toEqual([
      "sessions",
      "trust",
      "permissions",
      "caches",
    ]);
  });

  it("lists each path with its size, and keeps globalContext.json", () => {
    const plan = planReset(root, ["sessions", "caches"], home);
    expect(plan.refused).toBeUndefined();
    expect(plan.items.map((i) => [i.scope, i.relative, i.kind])).toEqual([
      ["sessions", "sessions", "folder"],
      ["sessions", "input_history.json", "file"],
      ["caches", "index/lancedb", "folder"],
      ["caches", "bedrock-catalog", "folder"],
    ]);
    expect(plan.items[0]).toMatchObject({ files: 2, bytes: 4 });
    expect(plan.items[2]).toMatchObject({ files: 1, bytes: 10 });
  });

  it("skips what is not there", () => {
    fs.rmSync(path.join(root, "trusted-hooks.json"));
    const plan = planReset(root, ["trust"], home);
    expect(plan.items.map((i) => i.relative)).toEqual(["trusted-project.json"]);
  });

  it("refuses ~/.continue, a folder inside it, the home folder and a drive root", () => {
    const legacy = path.join(home, ".continue");
    expect(refuseRoot(legacy, home)).toMatch(/another product/);
    expect(refuseRoot(path.join(legacy, "sub"), home)).toMatch(
      /another product/,
    );
    expect(refuseRoot(home, home)).toMatch(/home folder or a drive root/);
    expect(refuseRoot(path.parse(home).root, home)).toMatch(/drive root/);
    expect(refuseRoot(root, home)).toBeUndefined();
  });

  it("names a backup folder that sorts and is legal on Windows", () => {
    expect(backupFolderName(NOW)).toBe("2026-11-12T20-15-03-123Z");
  });

  it("formats sizes", () => {
    expect(formatBytes(10)).toBe("10 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3.5 * 1024 * 1024)).toBe("3.5 MB");
  });
});

describe("continuous reset", () => {
  it("shows the scopes and changes nothing without one", () => {
    expect(resetCommand({ root, homeDir: home }, io)).toBe(2);
    expect(err[0]).toBe("Usage: continuous reset <scope...> [--yes]");
    expect(exists("sessions/a.json")).toBe(true);
  });

  it("is a dry run without --yes", () => {
    expect(resetCommand({ all: true, root, homeDir: home }, io)).toBe(0);
    expect(out.join("\n")).toContain(
      "Would move to a backup folder (nothing is deleted):",
    );
    expect(out.join("\n")).toContain(path.join(root, "permissions.yaml"));
    expect(out.at(-1)).toMatch(/^Dry run: nothing was moved/);
    expect(exists("sessions/a.json")).toBe(true);
    expect(exists("permissions.yaml")).toBe(true);
    expect(exists(RESET_BACKUP_DIR)).toBe(false);
  });

  it("moves with --yes, to a backup at the same relative paths", () => {
    const code = resetCommand(
      { all: true, yes: true, root, homeDir: home, now: NOW },
      io,
    );
    expect(code).toBe(0);
    const backup = path.join(root, RESET_BACKUP_DIR, backupFolderName(NOW));
    for (const moved of [
      "sessions/a.json",
      "input_history.json",
      "trusted-project.json",
      "trusted-hooks.json",
      "permissions.yaml",
      "index/lancedb/x.bin",
      "bedrock-catalog/k.json",
    ]) {
      expect(exists(moved)).toBe(false);
      expect(fs.existsSync(path.join(backup, ...moved.split("/")))).toBe(true);
    }
    // Kept in place
    for (const kept of [
      "index/globalContext.json",
      "config.yaml",
      ".env",
      "providers.yaml",
      "settings.json",
      "audit/s.jsonl",
    ]) {
      expect(exists(kept)).toBe(true);
    }
    // Another product's folder is never touched
    expect(
      fs.existsSync(path.join(home, ".continue", "sessions", "old.json")),
    ).toBe(true);
    expect(out.join("\n")).toContain(`Moved 7 to ${backup}`);
  });

  it("does one scope only", () => {
    resetCommand({ trust: true, yes: true, root, homeDir: home }, io);
    expect(exists("trusted-project.json")).toBe(false);
    expect(exists("permissions.yaml")).toBe(true);
    expect(exists("sessions/a.json")).toBe(true);
  });

  it("refuses a global folder that is ~/.continue, and changes nothing", () => {
    const legacy = path.join(home, ".continue");
    expect(
      resetCommand({ all: true, yes: true, root: legacy, homeDir: home }, io),
    ).toBe(2);
    expect(err[0]).toMatch(/another product/);
    expect(fs.existsSync(path.join(legacy, "sessions", "old.json"))).toBe(true);
  });

  it("prints JSON", () => {
    resetCommand({ permissions: true, json: true, root, homeDir: home }, io);
    const parsed = JSON.parse(out[0]);
    expect(parsed).toMatchObject({
      root,
      scopes: ["permissions"],
      applied: false,
    });
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toMatchObject({
      scope: "permissions",
      relative: "permissions.yaml",
      kind: "file",
    });
  });

  it("says when there is nothing to reset", () => {
    fs.rmSync(path.join(root, "permissions.yaml"));
    expect(
      resetCommand({ permissions: true, yes: true, root, homeDir: home }, io),
    ).toBe(0);
    expect(out).toContain("Nothing to reset in the chosen scopes.");
    expect(exists(RESET_BACKUP_DIR)).toBe(false);
  });
});
