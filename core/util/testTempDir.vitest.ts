import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasWindowsShortName } from "../tools/permissions/protectedPaths";
import { removeTestTempDir, testTempDir } from "./testTempDir";

describe("testTempDir", () => {
  const cwd = process.cwd();
  afterEach(() => process.chdir(cwd));

  it("gives a folder under its resolved name, with no short name in it", () => {
    const dir = testTempDir("temp-dir-");
    try {
      expect(fs.statSync(dir).isDirectory()).toBe(true);
      expect(dir).toBe(fs.realpathSync.native(dir));
      expect(hasWindowsShortName(dir.split(path.sep).join("/"))).toBe(false);
    } finally {
      removeTestTempDir(dir);
    }
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("removes a folder the process is still inside", () => {
    const dir = testTempDir("temp-dir-");
    const inner = path.join(dir, "inner");
    fs.mkdirSync(inner);
    process.chdir(inner);
    removeTestTempDir(dir);
    expect(fs.existsSync(dir)).toBe(false);
  });
});
