import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  answerVersionFast,
  compileCacheDirectory,
  enableCliCompileCache,
  isVersionOnlyInvocation,
  readPackageVersion,
} from "./fastStart.js";
import { getVersion } from "./version.js";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A folder laid out like an installed CLI: package.json and dist/cn.js. */
function installedCli(packageJson: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "cn-fast-start-"));
  scratch.push(root);
  mkdirSync(join(root, "dist"));
  if (packageJson !== null) {
    writeFileSync(join(root, "package.json"), packageJson);
  }
  return pathToFileURL(join(root, "dist", "cn.js")).href;
}

describe("isVersionOnlyInvocation", () => {
  it.each([[["--version"]], [["-v"]]])("accepts %j", (args) => {
    expect(isVersionOnlyInvocation(args)).toBe(true);
  });

  it.each([
    [[]],
    [["--help"]],
    [["-V"]],
    [["--version", "--verbose"]],
    [["-p", "--version"]],
    [["serve", "--version"]],
    [["--version", "hello"]],
    [["version"]],
    [["--version=1"]],
  ])("leaves %j to the bundle", (args) => {
    expect(isVersionOnlyInvocation(args)).toBe(false);
  });
});

describe("readPackageVersion", () => {
  it("reads the version beside dist/", () => {
    const entry = installedCli(JSON.stringify({ version: "2.18.0" }));
    expect(readPackageVersion(entry)).toBe("2.18.0");
  });

  it("agrees with getVersion() for this package", () => {
    // src/fastStart.ts and src/version.ts both sit one level under the
    // package root, as dist/cn.js and dist/index.js do
    const entry = new URL("./cn.ts", import.meta.url).href;
    expect(readPackageVersion(entry)).toBe(getVersion());
  });

  it.each([
    ["a missing file", null],
    ["invalid JSON", "{"],
    ["no version field", "{}"],
    ["a version that is not a string", JSON.stringify({ version: 2 })],
    ["an empty version", JSON.stringify({ version: "" })],
  ])("is null for %s", (_name, packageJson) => {
    expect(readPackageVersion(installedCli(packageJson))).toBeNull();
  });
});

describe("answerVersionFast", () => {
  it("prints the version and a newline, as commander does", () => {
    const entry = installedCli(JSON.stringify({ version: "1.2.3" }));
    const write = vi.fn();
    expect(answerVersionFast(["--version"], entry, write)).toBe(true);
    expect(write.mock.calls).toEqual([["1.2.3\n"]]);
  });

  it("prints nothing for other arguments", () => {
    const entry = installedCli(JSON.stringify({ version: "1.2.3" }));
    const write = vi.fn();
    expect(answerVersionFast(["--help"], entry, write)).toBe(false);
    expect(answerVersionFast([], entry, write)).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("falls back to the bundle when the version cannot be read", () => {
    const write = vi.fn();
    expect(answerVersionFast(["-v"], installedCli(null), write)).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("compileCacheDirectory", () => {
  const home = resolve("/home/someone");
  const always = () => true;

  it("is cache/compile under ~/.continuous", () => {
    expect(compileCacheDirectory({}, home, always)).toBe(
      join(home, ".continuous", "cache", "compile"),
    );
  });

  it("follows CONTINUOUS_GLOBAL_DIR, then CONTINUE_GLOBAL_DIR", () => {
    const first = resolve("/data/first");
    const second = resolve("/data/second");
    expect(
      compileCacheDirectory(
        { CONTINUOUS_GLOBAL_DIR: first, CONTINUE_GLOBAL_DIR: second },
        home,
        always,
      ),
    ).toBe(join(first, "cache", "compile"));
    expect(
      compileCacheDirectory({ CONTINUE_GLOBAL_DIR: second }, home, always),
    ).toBe(join(second, "cache", "compile"));
  });

  it("resolves a relative global folder against the working directory", () => {
    expect(
      compileCacheDirectory({ CONTINUOUS_GLOBAL_DIR: "rel" }, home, always),
    ).toBe(join(resolve("rel"), "cache", "compile"));
  });

  it("is null while the global folder does not exist, and never creates it", () => {
    const exists = vi.fn(() => false);
    expect(compileCacheDirectory({}, home, exists)).toBeNull();
    expect(exists).toHaveBeenCalledWith(join(home, ".continuous"));
  });
});

describe("enableCliCompileCache", () => {
  const home = resolve("/home/someone");
  const expected = join(home, ".continuous", "cache", "compile");
  const always = () => true;

  it("enables the cache in the global folder", () => {
    const enable = vi.fn();
    expect(enableCliCompileCache({}, home, enable, always)).toBe(expected);
    expect(enable.mock.calls).toEqual([[expected]]);
  });

  it("does nothing on a Node without module.enableCompileCache", () => {
    expect(enableCliCompileCache({}, home, null, always)).toBeNull();
  });

  it("leaves a cache the person set up with NODE_COMPILE_CACHE alone", () => {
    const enable = vi.fn();
    expect(
      enableCliCompileCache(
        { NODE_COMPILE_CACHE: "/elsewhere" },
        home,
        enable,
        always,
      ),
    ).toBeNull();
    expect(enable).not.toHaveBeenCalled();
  });

  it("does nothing before the global folder exists", () => {
    const enable = vi.fn();
    expect(enableCliCompileCache({}, home, enable, () => false)).toBeNull();
    expect(enable).not.toHaveBeenCalled();
  });

  it("does not let a failing cache stop start-up", () => {
    const enable = vi.fn(() => {
      throw new Error("read-only disk");
    });
    expect(enableCliCompileCache({}, home, enable, always)).toBeNull();
  });
});
