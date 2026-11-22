import os from "node:os";

import { describe, expect, it } from "vitest";

import { encode, joinPaths, readPlatform, seenByBundledCode } from "./canary";

// Runs in the page project only (vitest.page.config.ts). If the plugin stops
// changing bundled files, every other suite passes for the wrong reason, and
// this one fails.
describe("the page project", () => {
  it("gives a bundled file what the built page has", () => {
    expect(seenByBundledCode()).toEqual({
      namedImport: "undefined",
      defaultImport: {},
      namespace: ["default"],
      process: "undefined",
      Buffer: "undefined",
      global: "undefined",
      require: "undefined",
      dirname: "undefined",
      setImmediate: "undefined",
      nodeEnv: "production",
      env: {},
    });
  });

  it("throws where the page throws", () => {
    expect(joinPaths).toThrow(/join is not a function/);
    expect(readPlatform).toThrow(TypeError);
    expect(encode).toThrow(TypeError);
  });

  it("leaves the test file its Node", () => {
    expect(typeof os.homedir()).toBe("string");
    expect(typeof process.platform).toBe("string");
    expect(typeof Buffer.from).toBe("function");
    expect(process.env.NODE_ENV).not.toBe("production");
  });
});
