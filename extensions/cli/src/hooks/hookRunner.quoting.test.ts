import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runHooks } from "./hookRunner.js";
import type { HooksConfig, PreToolUseInput } from "./types.js";

// Cross-platform: the hook command is built from node itself so it needs no
// shell builtins, but the script path contains characters that force quoting.
const input: PreToolUseInput = {
  session_id: "s",
  transcript_path: "",
  cwd: process.cwd(),
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "ls" },
  tool_use_id: "id",
};

async function runCommand(command: string) {
  const config: HooksConfig = {
    PreToolUse: [{ hooks: [{ type: "command", command }] }],
  };
  const result = await runHooks(config, input);
  return result.results[0];
}

describe("hookRunner - quoted command paths", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hook-quote-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  // `&` and `%` are legal in Windows file names. A single quote is legal on
  // POSIX only here, and is literal inside a double-quoted sh word. A double
  // quote in a name would need escaping, which this test does not do. Non-ASCII exercises the console code page path.
  const dirNames = [
    "with space",
    "amp & amp",
    "100%done",
    "café 日本",
    ...(process.platform === "win32" ? [] : ["it's"]),
  ];

  for (const dirName of dirNames) {
    it(`runs a quoted script path in "${dirName}"`, async () => {
      const dir = path.join(root, dirName);
      fs.mkdirSync(dir, { recursive: true });
      const script = path.join(dir, "hook.js");
      fs.writeFileSync(
        script,
        "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }));",
      );

      const res = await runCommand(
        `"${process.execPath}" "${script}" "two words" plain`,
      );
      expect(res.stderr).toBe("");
      expect(res.exitCode).toBe(0);
      expect(JSON.parse(res.stdout)).toEqual({
        argv: ["two words", "plain"],
      });
    });
  }

  it("treats metacharacters inside quotes as data, not a second command", async () => {
    const script = path.join(root, "hook.js");
    fs.writeFileSync(script, "process.stdout.write(process.argv[2]);");
    const payload = "a & echo pwned | echo pwned2 ; echo pwned3";
    const res = await runCommand(
      `"${process.execPath}" "${script}" "${payload}"`,
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe(payload);
  });
});
