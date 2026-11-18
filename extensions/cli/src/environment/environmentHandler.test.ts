import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  decideFromFiles,
  readScopeFilesFromDisk,
  setProjectConfigTrustedForRun,
  trustProjectScopes,
} from "core/config/projectTrust.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runEnvironmentInstall } from "./environmentHandler.js";

let root: string;
let project: string;
let globalDir: string;
let stderr: ReturnType<typeof vi.spyOn>;

function canary(): string {
  return `node -e "require('fs').writeFileSync('canary.txt','ran')"`;
}

function write(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "env-install-"));
  project = path.join(root, "project");
  globalDir = path.join(root, "global");
  fs.mkdirSync(project);
  fs.mkdirSync(globalDir);
  process.env.CONTINUOUS_GLOBAL_DIR = globalDir;
  setProjectConfigTrustedForRun(false);
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  delete process.env.CONTINUOUS_GLOBAL_DIR;
  setProjectConfigTrustedForRun(false);
  stderr.mockRestore();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("environment.json install", () => {
  it("does not run in an untrusted project, and says why once", async () => {
    write(path.join(project, ".continuous", "environment.json"), {
      install: canary(),
    });
    await runEnvironmentInstall(project);
    expect(fs.existsSync(path.join(project, "canary.txt"))).toBe(false);
    const text = stderr.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(text).toContain(".continuous/environment.json");
    expect(text).toContain("continuous project trust");
    expect(stderr).toHaveBeenCalledTimes(1);
  });

  it("does not run from the legacy .continue folder either", async () => {
    write(path.join(project, ".continue", "environment.json"), {
      install: canary(),
    });
    await runEnvironmentInstall(project);
    expect(fs.existsSync(path.join(project, "canary.txt"))).toBe(false);
  });

  it("runs with --trust-project-config", async () => {
    write(path.join(project, ".continuous", "environment.json"), {
      install: canary(),
    });
    setProjectConfigTrustedForRun(true);
    await runEnvironmentInstall(project);
    expect(fs.readFileSync(path.join(project, "canary.txt"), "utf-8")).toBe(
      "ran",
    );
  });

  it("runs once the project is trusted, and asks again after an edit", async () => {
    const file = path.join(project, ".continuous", "environment.json");
    write(file, { install: canary() });
    const files = readScopeFilesFromDisk(project, "environment");
    const { fingerprint } = decideFromFiles(
      project,
      "environment",
      files,
      globalDir,
    );
    trustProjectScopes(project, { environment: fingerprint }, globalDir);

    await runEnvironmentInstall(project, globalDir);
    expect(fs.existsSync(path.join(project, "canary.txt"))).toBe(true);

    fs.rmSync(path.join(project, "canary.txt"));
    write(file, { install: canary() + " && echo changed" });
    await runEnvironmentInstall(project, globalDir);
    expect(fs.existsSync(path.join(project, "canary.txt"))).toBe(false);
  });

  it("does not run when the user switched it off, even when trusted", async () => {
    write(path.join(project, ".continuous", "environment.json"), {
      install: canary(),
    });
    write(path.join(globalDir, "settings.json"), { environmentInstall: false });
    setProjectConfigTrustedForRun(true);
    await runEnvironmentInstall(project);
    expect(fs.existsSync(path.join(project, "canary.txt"))).toBe(false);
  });
});
