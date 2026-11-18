import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const esbuild = require("esbuild");

const {
  esbuildOptionsFromFlags,
  minifyBundleInPlace,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
} = require("./esbuild-flags.js");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const packageJson = require("../package.json");

describe("esbuildOptionsFromFlags", () => {
  it("leaves a plain build unminified and without a source map", () => {
    expect(esbuildOptionsFromFlags([])).toEqual({
      bundle: { sourcemap: false },
      minifyPass: null,
    });
  });

  it("asks for a minify pass that keeps function names for --minify", () => {
    expect(esbuildOptionsFromFlags(["--minify"])).toEqual({
      bundle: { sourcemap: false },
      minifyPass: { minify: true, keepNames: true, sourcemap: false },
    });
  });

  it("keeps the development build readable: --sourcemap does not minify", () => {
    expect(esbuildOptionsFromFlags(["--sourcemap", "--watch"])).toEqual({
      bundle: { sourcemap: true },
      minifyPass: null,
    });
  });

  it("carries the source map through a minified build", () => {
    expect(esbuildOptionsFromFlags(["--minify", "--sourcemap"])).toEqual({
      bundle: { sourcemap: true },
      minifyPass: { minify: true, keepNames: true, sourcemap: true },
    });
  });

  it("never minifies while bundling, which would load no faster", () => {
    expect(esbuildOptionsFromFlags(["--minify"]).bundle).not.toHaveProperty(
      "minify",
    );
  });

  it("is what the packaging script asks for", () => {
    // vsce runs vscode:prepublish. If the flag is renamed there, the package
    // silently ships unminified again.
    const flags = packageJson.scripts["vscode:prepublish"].split(" ");
    expect(esbuildOptionsFromFlags(flags).minifyPass).not.toBeNull();
    const devFlags = packageJson.scripts["esbuild"].split(" ");
    expect(esbuildOptionsFromFlags(devFlags).minifyPass).toBeNull();
  });
});

describe("minifyBundleInPlace", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const source = [
    "// a comment that minification removes",
    "class WellNamedError extends Error {}",
    "function describeThing(someLongParameterName) {",
    "  return someLongParameterName + 1;",
    "}",
    "module.exports = {",
    "  activate: () => describeThing(41),",
    "  errorName: new WellNamedError().constructor.name,",
    "};",
    "",
  ].join("\n");

  it("shrinks the file and keeps its exports and class names", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "esbuild-flags-"));
    dirs.push(dir);
    const file = path.join(dir, "extension.js");
    fs.writeFileSync(file, source);

    await minifyBundleInPlace(
      esbuild,
      file,
      esbuildOptionsFromFlags(["--minify"]).minifyPass,
    );

    const minified = fs.readFileSync(file, "utf8");
    expect(minified.length).toBeLessThan(source.length);
    expect(minified).not.toContain("someLongParameterName");
    expect(fs.existsSync(`${file}.map`)).toBe(false);

    const loaded = { exports: {} as Record<string, any> };
    new Function("module", "exports", minified)(loaded, loaded.exports);
    expect(loaded.exports.activate()).toBe(42);
    expect(loaded.exports.errorName).toBe("WellNamedError");
  });

  it("writes a source map only when asked", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "esbuild-flags-"));
    dirs.push(dir);
    const file = path.join(dir, "extension.js");
    fs.writeFileSync(file, source);

    await minifyBundleInPlace(
      esbuild,
      file,
      esbuildOptionsFromFlags(["--minify", "--sourcemap"]).minifyPass,
    );

    expect(fs.existsSync(`${file}.map`)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toContain("sourceMappingURL");
  });
});
