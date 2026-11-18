import { readFileSync } from "fs";

import { describe, expect, it } from "vitest";

describe("package.json bin map", () => {
  it("exposes both `continuous` and the short alias `cn`", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(pkg.bin).toEqual({
      continuous: "dist/cn.js",
      cn: "dist/cn.js",
    });
  });
});
