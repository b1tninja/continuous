import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isGitAiOptedIn, resolveGitAiBinary } from "./gitAiBinary.js";

let root: string;
let workspace: string;
let bin: string;

function fakeBinary(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(
    dir,
    process.platform === "win32" ? "git-ai.exe" : "git-ai",
  );
  fs.writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
  return file;
}

const platform = process.platform;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gitai-"));
  workspace = path.join(root, "workspace");
  bin = path.join(root, "bin");
  fs.mkdirSync(workspace);
});

afterEach(() => {
  delete process.env.CONTINUOUS_GLOBAL_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("resolveGitAiBinary", () => {
  it("finds git-ai in an absolute PATH entry outside the workspace", () => {
    const file = fakeBinary(bin);
    expect(resolveGitAiBinary(workspace, bin, platform)).toBe(
      fs.realpathSync(file),
    );
  });

  it("never returns a git-ai inside the workspace", () => {
    fakeBinary(path.join(workspace, "tools"));
    expect(
      resolveGitAiBinary(workspace, path.join(workspace, "tools"), platform),
    ).toBeNull();
  });

  it("skips relative, empty and dot PATH entries", () => {
    fakeBinary(path.join(workspace, "tools"));
    const prev = process.cwd();
    process.chdir(workspace);
    try {
      expect(
        resolveGitAiBinary(
          workspace,
          [".", "", "tools", "./tools"].join(path.delimiter),
          platform,
        ),
      ).toBe(null);
    } finally {
      process.chdir(prev);
    }
  });

  it("skips a PATH-outside symlink that points into the workspace", () => {
    const target = fakeBinary(path.join(workspace, "tools"));
    fs.mkdirSync(bin);
    try {
      fs.symlinkSync(target, path.join(bin, "git-ai"));
    } catch {
      return;
    }
    expect(resolveGitAiBinary(workspace, bin, platform)).toBeNull();
  });
});

describe("isGitAiOptedIn", () => {
  it("is false by default and true only for gitAiIntegration: true", () => {
    const globalDir = path.join(root, "global");
    fs.mkdirSync(globalDir);
    process.env.CONTINUOUS_GLOBAL_DIR = globalDir;
    expect(isGitAiOptedIn(workspace)).toBe(false);
    fs.writeFileSync(
      path.join(globalDir, "settings.json"),
      JSON.stringify({ gitAiIntegration: "yes" }),
    );
    expect(isGitAiOptedIn(workspace)).toBe(false);
    fs.writeFileSync(
      path.join(globalDir, "settings.json"),
      JSON.stringify({ gitAiIntegration: true }),
    );
    expect(isGitAiOptedIn(workspace)).toBe(true);
  });

  it("ignores a settings.json in the project", () => {
    process.env.CONTINUOUS_GLOBAL_DIR = path.join(root, "empty-global");
    fs.mkdirSync(path.join(workspace, ".continuous"));
    fs.writeFileSync(
      path.join(workspace, ".continuous", "settings.json"),
      JSON.stringify({ gitAiIntegration: true }),
    );
    expect(isGitAiOptedIn(workspace)).toBe(false);
  });
});
