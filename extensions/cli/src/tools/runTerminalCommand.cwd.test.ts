import * as fs from "node:fs";
import * as path from "node:path";

import { removeTestTempDir, testTempDir } from "core/util/testTempDir.js";

import { runTerminalCommandTool } from "./runTerminalCommand.js";

/**
 * The `cwd` argument of Bash: a command starts in the folder it was asked to,
 * and only in the folder the CLI was started in or one below it.
 */
describe("Bash cwd", () => {
  const home = process.cwd();
  let root: string;
  let sub: string;

  beforeAll(() => {
    root = testTempDir("cli-bash-cwd-");
    sub = path.join(root, "pkg");
    fs.mkdirSync(sub);
    process.chdir(root);
  });

  afterAll(() => {
    process.chdir(home);
    removeTestTempDir(root);
  });

  const printCwd = `node -e "console.log('CWD=' + process.cwd())"`;
  const cwdOf = (out: string) => /CWD=(.+)/.exec(out)?.[1]?.trim();

  it("runs where the CLI was started when no cwd is given", async () => {
    const out = await runTerminalCommandTool.run({ command: printCwd });
    expect(cwdOf(out)).toBe(root);
  });

  it("runs in the folder asked for, relative to the working directory", async () => {
    const out = await runTerminalCommandTool.run({
      command: printCwd,
      cwd: "pkg",
    });
    expect(cwdOf(out)).toBe(sub);
  });

  it("does not run a command whose cwd leaves the working directory", async () => {
    for (const bad of ["..", path.dirname(root)]) {
      const out = await runTerminalCommandTool.run({
        command: printCwd,
        cwd: bad,
      });
      expect(out, bad).toContain("outside the workspace");
      expect(cwdOf(out), bad).toBeUndefined();
    }
  });

  it("does not run a command whose cwd does not exist", async () => {
    const out = await runTerminalCommandTool.run({
      command: printCwd,
      cwd: "missing",
    });
    expect(out).toContain("does not exist");
  });

  it("is an optional string parameter, appended after timeout", () => {
    const params = runTerminalCommandTool.parameters as {
      required: string[];
      properties: Record<string, { type: string }>;
    };
    expect(params.required).toEqual(["command"]);
    expect(Object.keys(params.properties)).toEqual([
      "command",
      "timeout",
      "cwd",
    ]);
    expect(params.properties.cwd.type).toBe("string");
  });

  it("the description no longer says to avoid choosing a folder", () => {
    expect(runTerminalCommandTool.description).toContain("pass cwd");
    expect(runTerminalCommandTool.description).not.toContain(
      "no need to change directories",
    );
  });
});
