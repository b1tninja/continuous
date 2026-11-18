import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every command the agent asks for starts through `executor.spawn` (phase 0
 * of the OS sandbox plan), so an executor that wraps commands (a container, an
 * OS sandbox) wraps all of them. This fails on a new direct `spawn`, `exec` or
 * `execFile` in the files that start agent commands. The one start allowed is
 * `taskkill`, which ends a command's process tree on Windows.
 */
const repo = path.resolve(__dirname, "..", "..");
const SITES = [
  "core/tools/implementations/runTerminalCommand.ts",
  "extensions/cli/src/tools/runTerminalCommand.ts",
  "extensions/cli/src/services/BackgroundJobService.ts",
  "extensions/cli/src/loop/loopChecks.ts",
];

/** Process starts that do not go through an executor, with their first argument. */
export function directStarts(source: string): string[] {
  const found: string[] = [];
  // Comments may name `child_process.spawn()`; only code counts
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const call =
    /(^|[^\w.]|(?:childProcess|child_process|cp)\.)(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\(\s*([^,)]*)/g;
  for (const m of code.matchAll(call)) {
    const first = m[3].trim();
    if (first === '"taskkill"') continue;
    found.push(`${m[2]}(${first}`);
  }
  return found;
}

describe("agent commands start only through the executor", () => {
  it.each(SITES)("%s starts no process of its own", (file) => {
    const source = readFileSync(path.join(repo, file), "utf8");
    expect(directStarts(source)).toEqual([]);
  });

  it("the check sees a direct start, and lets executor.spawn and taskkill through", () => {
    expect(directStarts(`const c = spawn(shell, args, {});`)).toEqual([
      "spawn(shell",
    ]);
    expect(directStarts(`childProcess.spawn(\n  shell,\n  args)`)).toEqual([
      "spawn(shell",
    ]);
    expect(directStarts(`exec("npm test")`)).toEqual([`exec("npm test"`]);
    expect(directStarts(`await executor.spawn(command, {})`)).toEqual([]);
    expect(directStarts(`// childProcess.spawn() runs here`)).toEqual([]);
    expect(
      directStarts(`childProcess.spawn(\n  "taskkill",\n  ["/pid"])`),
    ).toEqual([]);
  });
});
