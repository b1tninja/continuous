/**
 * `continuous hooks test`. Canary commands in a temp directory only: each
 * script records that it ran and what it was sent.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hooksCommand } from "../commands/hooks.js";

import { buildSampleInput } from "./hooksTest.js";
import { setTrustProjectHooksForRun } from "./hookTrust.js";

let root: string;
let home: string;
let project: string;
let out: string;
let err: string;
let saved: Record<string, string | undefined>;

/** A node script that logs its stdin to `<name>.seen` and then runs `body`. */
function canary(name: string, body = ""): string {
  const script = path.join(root, `${name}.cjs`);
  const seen = path.join(root, `${name}.seen`);
  fs.writeFileSync(
    script,
    `let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{require("fs").writeFileSync(${JSON.stringify(seen)},d);${body}})`,
  );
  return `node ${JSON.stringify(script)}`;
}
const seen = (name: string): any | undefined => {
  const file = path.join(root, `${name}.seen`);
  return fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf-8"))
    : undefined;
};

function userHooks(hooks: unknown) {
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".claude", "settings.json"),
    JSON.stringify({ hooks }),
  );
}
function projectHooks(hooks: unknown) {
  fs.mkdirSync(path.join(project, ".continue"), { recursive: true });
  fs.writeFileSync(
    path.join(project, ".continue", "settings.json"),
    JSON.stringify({ hooks }),
  );
}
const cmd = (command: string) => ({ type: "command", command });
const test = (
  event: string | undefined,
  options: Record<string, string> = {},
) => hooksCommand("test", { event, ...options }, project);

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "cn-hooktest-")),
  );
  home = path.join(root, "home");
  project = path.join(root, "project");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  saved = {
    CONTINUE_GLOBAL_DIR: process.env.CONTINUE_GLOBAL_DIR,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  };
  process.env.CONTINUE_GLOBAL_DIR = path.join(home, ".continue");
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  setTrustProjectHooksForRun(false);
  out = "";
  err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  setTrustProjectHooksForRun(false);
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("continuous hooks test", () => {
  it("runs a matching hook on a sample input and shows exit code and decision", async () => {
    userHooks({
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            cmd(canary("guard", `console.error("no way");process.exit(2)`)),
          ],
        },
      ],
    });
    expect(await test("PreToolUse")).toBe(0);
    expect(out).toContain('matcher "Bash": matches');
    expect(out).toContain("(your own)");
    expect(out).toContain("exit 2");
    expect(out).toContain("stderr: no way");
    expect(out).toContain("decision: block (no way)");
    expect(seen("guard")).toMatchObject({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
      session_id: "hooks-test",
    });
  });

  it("does not run a hook whose matcher does not match, and says so", async () => {
    userHooks({
      PreToolUse: [{ matcher: "^Read$", hooks: [cmd(canary("reader"))] }],
    });
    await test("PreToolUse", { tool: "Bash" });
    expect(out).toContain('matcher "^Read$": does not match');
    expect(out).toContain("No hook matched");
    expect(seen("reader")).toBeUndefined();
  });

  it("--tool picks the tool and --input is merged over the sample", async () => {
    userHooks({ PreToolUse: [{ hooks: [cmd(canary("any"))] }] });
    await test("PreToolUse", {
      tool: "Write",
      input: '{"tool_input":{"file_path":"x"}}',
    });
    expect(seen("any")).toMatchObject({
      tool_name: "Write",
      tool_input: { file_path: "x" },
      hook_event_name: "PreToolUse",
    });
  });

  it("--input cannot change the event name", async () => {
    userHooks({ PreToolUse: [{ hooks: [cmd(canary("any"))] }] });
    await test("PreToolUse", { input: '{"hook_event_name":"Stop"}' });
    expect(seen("any").hook_event_name).toBe("PreToolUse");
  });

  it("--server lets a mcp__ matcher match, and tests it like a session does", async () => {
    userHooks({
      PreToolUse: [
        { matcher: "mcp__github__search", hooks: [cmd(canary("gh"))] },
        { matcher: "mcp__gitlab__search", hooks: [cmd(canary("gl"))] },
      ],
    });
    await test("PreToolUse", { tool: "search", server: "github" });
    expect(seen("gh")).toMatchObject({ tool_name: "search", server: "github" });
    expect(seen("gl")).toBeUndefined();
  });

  it("an untrusted project hook does not run, and the output says so", async () => {
    projectHooks({ PreToolUse: [{ hooks: [cmd(canary("proj"))] }] });
    await test("PreToolUse");
    expect(out).toContain("1 project hook is not trusted and did not run");
    expect(out).toContain("No hook is configured");
    expect(seen("proj")).toBeUndefined();
  });

  it("a trusted project hook runs, is marked as a project hook, and its allow is ignored", async () => {
    const allow = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    });
    projectHooks({
      PreToolUse: [
        {
          hooks: [cmd(canary("proj", `console.log(${JSON.stringify(allow)})`))],
        },
      ],
    });
    setTrustProjectHooksForRun(true);
    await test("PreToolUse");
    expect(out).toContain("(project)");
    expect(out).toContain('its "allow" is ignored');
    expect(seen("proj")).toBeDefined();
  });

  it("a hook that fails on a blocking event is reported as failed and blocking", async () => {
    userHooks({
      PreToolUse: [{ hooks: [cmd(canary("boom", "process.exit(7)"))] }],
    });
    await test("PreToolUse");
    expect(out).toContain("exit 7");
    expect(out).toContain("failed: exited with code 7");
    expect(out).toContain("decision: block");
  });

  it("garbage on stdout with exit 0 is no decision (current behaviour)", async () => {
    userHooks({
      PreToolUse: [
        { hooks: [cmd(canary("junk", `console.log("not json {")`))] },
      ],
    });
    await test("PreToolUse");
    expect(out).toContain("exit 0");
    expect(out).toContain("decision: none");
  });

  it("works for an event without a tool", async () => {
    userHooks({ SessionStart: [{ hooks: [cmd(canary("start"))] }] });
    await test("SessionStart");
    expect(seen("start")).toMatchObject({ source: "startup" });
  });

  it("refuses an unknown event, bad JSON and --tool on a non-tool event", async () => {
    expect(await test("PreToolUsee")).toBe(1);
    expect(err).toContain("Events:");
    expect(await test(undefined)).toBe(1);
    expect(await test("PreToolUse", { input: "{nope" })).toBe(1);
    expect(err).toContain("not valid JSON");
    expect(await test("PreToolUse", { input: "[]" })).toBe(1);
    expect(await test("Stop", { tool: "Bash" })).toBe(1);
  });

  it("says when nothing is configured", async () => {
    await test("Stop");
    expect(out).toContain("No hook is configured for Stop");
  });
});

describe("buildSampleInput", () => {
  it("has the common fields for every event", () => {
    const input = buildSampleInput("Stop", "/work", {});
    expect(input).toMatchObject({
      session_id: "hooks-test",
      transcript_path: "",
      cwd: "/work",
      hook_event_name: "Stop",
    });
  });
});
