import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  asPredicate,
  formatBrokenConfigRefusal,
  noticeBrokenConfig,
  readPolicyFile,
  resetBrokenConfigNotices,
  resetWarnOnce,
  warnOnce,
} from "./readPolicyFile.js";

const CANARY = "sk-canary-secret-value";

describe("readPolicyFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-file-"));
    resetBrokenConfigNotices();
    resetWarnOnce();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("is absent when the file does not exist", () => {
    expect(readPolicyFile(path.join(dir, "nope.json"), "json")).toEqual({
      status: "absent",
    });
  });

  it("parses a valid JSON and a valid YAML file", () => {
    const j = path.join(dir, "a.json");
    fs.writeFileSync(j, '{"hooks":{}}');
    expect(readPolicyFile(j, "json")).toEqual({
      status: "ok",
      value: { hooks: {} },
    });
    const y = path.join(dir, "a.yaml");
    fs.writeFileSync(y, "allow:\n  - Read\n");
    expect(readPolicyFile(y, "yaml")).toEqual({
      status: "ok",
      value: { allow: ["Read"] },
    });
  });

  it("reports broken JSON with a line and column and no file content", () => {
    const f = path.join(dir, "s.json");
    fs.writeFileSync(f, `{\n  "apiKey": "${CANARY}",\n  "hooks": {},\n}\n`);
    const r = readPolicyFile(f, "json");
    expect(r.status).toBe("broken");
    if (r.status !== "broken") return;
    expect(r.path).toBe(f);
    expect(r.error).toMatch(/^not valid JSON at line \d+, column \d+/);
    expect(r.error).not.toContain(CANARY);
  });

  it("reports broken YAML with a position and no file content", () => {
    const f = path.join(dir, "p.yaml");
    fs.writeFileSync(f, `token: ${CANARY}\nallow: [Read\nask: x\n`);
    const r = readPolicyFile(f, "yaml");
    expect(r.status).toBe("broken");
    if (r.status !== "broken") return;
    expect(r.error).toMatch(/^not valid YAML/);
    expect(r.error).toMatch(/line \d+, column \d+/);
    expect(r.error).not.toContain(CANARY);
  });

  it("treats an empty JSON file as broken", () => {
    const f = path.join(dir, "e.json");
    fs.writeFileSync(f, "");
    expect(readPolicyFile(f, "json").status).toBe("broken");
  });

  it("reports a validator reason as broken", () => {
    const f = path.join(dir, "v.json");
    fs.writeFileSync(f, "[]");
    const r = readPolicyFile(f, "json", () => "has the wrong structure");
    expect(r).toEqual({
      status: "broken",
      path: f,
      error: "has the wrong structure",
    });
  });

  it("formats a refusal naming each file and the override", () => {
    const text = formatBrokenConfigRefusal([
      { path: "/a/settings.json", error: "not valid JSON at line 3, column 1" },
      {
        path: "/b/permissions.yaml",
        error: "not valid YAML at line 2, column 5",
      },
    ]);
    expect(text).toContain(
      "/a/settings.json: not valid JSON at line 3, column 1",
    );
    expect(text).toContain(
      "/b/permissions.yaml: not valid YAML at line 2, column 5",
    );
    expect(text).toContain("--ignore-broken-config");
  });

  it("notices a broken file once per process", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const file = {
      path: "/x/settings.json",
      error: "not valid JSON at line 1, column 2",
    };
    noticeBrokenConfig(file);
    noticeBrokenConfig(file);
    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0][0])).toContain("/x/settings.json");
    expect(String(write.mock.calls[0][0])).toContain("do NOT apply");
  });

  it("warnOnce warns once per key", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    warnOnce("k", "careful");
    warnOnce("k", "careful");
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe("asPredicate", () => {
  it("reads after a file name for every kind of reason", () => {
    expect(asPredicate("not valid YAML (BAD_INDENT)")).toBe(
      "is not valid YAML (BAD_INDENT)",
    );
    expect(asPredicate("could not be read (EACCES)")).toBe(
      "could not be read (EACCES)",
    );
    expect(
      asPredicate('has the wrong structure ("allow" must be a list)'),
    ).toBe('has the wrong structure ("allow" must be a list)');
  });
});
