import { describe, expect, it } from "vitest";

import { asInThePage, MISSING_GLOBALS, STUB_ID } from "./pagePlugin";

const SHADOW = `const ${MISSING_GLOBALS.map((n) => `${n} = undefined`).join(", ")}; `;

describe("asInThePage", () => {
  it("points every Node built-in at the empty module", () => {
    const out = asInThePage(
      [
        'import * as path from "node:path";',
        "import fs from 'fs';",
        'import { homedir } from "os";',
        'export { join } from "path";',
        'const cp = await import("node:child_process");',
        'const u = require("url");',
      ].join("\n"),
      "a.ts",
    );
    expect(out.match(new RegExp(STUB_ID, "g"))).toHaveLength(6);
    expect(out).not.toMatch(/node:|["'](fs|os|path|url)["']/);
  });

  it("leaves other imports alone", () => {
    const code =
      'import { z } from "zod";\nimport { a } from "./path";\nimport b from "core/util/os";';
    expect(asInThePage(code, "a.ts")).toBe(SHADOW + code);
  });

  it("replaces process.env as Vite's build does", () => {
    const out = asInThePage(
      "const a = process.env.NODE_ENV; const b = process.env.HOME; const c = globalThis.process.env;",
      "a.ts",
    );
    expect(out).toContain('const a = "production";');
    expect(out).toContain("const b = ({}).HOME;");
    expect(out).toContain("const c = ({});");
  });

  it("does not touch a property that is only named process", () => {
    const code = "x.process.env.A; child.process.env;";
    expect(asInThePage(code, "a.ts")).toBe(SHADOW + code);
  });

  it("hides the names a page lacks, on the first line so line numbers hold", () => {
    const out = asInThePage("a();\nb();", "a.ts");
    expect(out.split("\n")).toEqual([`${SHADOW}a();`, "b();"]);
    for (const name of ["process", "Buffer", "require", "__dirname"]) {
      expect(SHADOW).toContain(`${name} = undefined`);
    }
  });

  it("does not redeclare a name the file declares or imports", () => {
    const out = asInThePage(
      'import { Buffer } from "buffer";\nconst require = make();\nfunction setImmediate() {}',
      "a.ts",
    );
    const shadow = out.slice(0, out.indexOf(";"));
    expect(shadow).toContain("process = undefined");
    expect(shadow).not.toMatch(/\b(Buffer|require|setImmediate) = undefined/);
  });

  it("makes guarded code take the page's branch and unguarded code throw", () => {
    const run = (body: string) =>
      new Function(asInThePage(body, "a.ts").replace(/^const/, "var"));
    expect(
      run('return typeof process !== "undefined" && process.platform;')(),
    ).toBe(false);
    expect(run("return process.platform;")).toThrow(TypeError);
    expect(run('return Buffer.from("a");')).toThrow(TypeError);
  });

  it("refuses `process?.`, which passes here and throws in the page", () => {
    expect(() =>
      asInThePage("const a = 1;\nconst p = process?.platform;", "core/a.ts"),
    ).toThrow(/core\/a\.ts:2 reads `process\?\.`/);
    expect(() =>
      asInThePage("a.process?.x; b ? process.x : 1", "a.ts"),
    ).not.toThrow();
  });
});
