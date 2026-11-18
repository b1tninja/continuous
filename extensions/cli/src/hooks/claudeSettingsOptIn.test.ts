/**
 * D-023: hooks in `~/.claude/settings.json` run only with
 * `hooks.readClaudeSettings: true` in the user's Continuous settings, and a
 * one-time notice says so to someone who has some. Temp homes only.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadHooksConfig } from "./hookConfig.js";
import {
  noticeSkippedClaudeHooks,
  resetClaudeNoticeForTests,
} from "./hookListing.js";

let root: string;
let home: string;
let project: string;
let saved: Record<string, string | undefined>;

const writeJson = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};
const claudeFile = () => path.join(home, ".claude", "settings.json");
const ownFile = () => path.join(home, ".continuous", "settings.json");
const claudeHooks = {
  hooks: {
    PreToolUse: [{ hooks: [{ type: "command", command: "claude-guard" }] }],
    Stop: [{ hooks: [{ type: "command", command: "claude-stop" }] }],
  },
};

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "claude-optin-")),
  );
  home = path.join(root, "home");
  project = path.join(root, "project");
  fs.mkdirSync(project, { recursive: true });
  saved = {
    CONTINUE_GLOBAL_DIR: process.env.CONTINUE_GLOBAL_DIR,
    CONTINUOUS_GLOBAL_DIR: process.env.CONTINUOUS_GLOBAL_DIR,
  };
  delete process.env.CONTINUE_GLOBAL_DIR;
  delete process.env.CONTINUOUS_GLOBAL_DIR;
  resetClaudeNoticeForTests();
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

/** Loads, then shows the notice as the hook service would; returns what it printed. */
function start(): string {
  let printed = "";
  const loaded = loadHooksConfig(project, home);
  noticeSkippedClaudeHooks(loaded.skippedClaudeHooks, project, home, (t) => {
    printed += t;
  });
  return printed;
}

describe("~/.claude hooks are opt-in", () => {
  it("are not loaded by default, and the notice names the file, the count and the setting", () => {
    writeJson(claudeFile(), claudeHooks);
    expect(loadHooksConfig(project, home).hooks).toEqual({});
    const printed = start();
    expect(printed).toContain(claudeFile());
    expect(printed).toContain("2 hooks");
    expect(printed).toContain('"readClaudeSettings": true');
    expect(printed).toContain(ownFile());
  });

  it("the notice is shown once, across runs", () => {
    writeJson(claudeFile(), claudeHooks);
    expect(start()).not.toBe("");
    resetClaudeNoticeForTests(); // a new process
    expect(start()).toBe("");
    expect(
      fs.existsSync(path.join(home, ".continuous", "hook-notices.json")),
    ).toBe(true);
  });

  it("no notice when ~/.claude has no hooks", () => {
    writeJson(claudeFile(), { permissions: { allow: [] } });
    expect(start()).toBe("");
  });

  it("no notice when the setting is false: that is a decision already", () => {
    writeJson(claudeFile(), claudeHooks);
    writeJson(ownFile(), { hooks: { readClaudeSettings: false } });
    expect(start()).toBe("");
    expect(loadHooksConfig(project, home).hooks).toEqual({});
  });

  it("load with the setting, and then there is no notice", () => {
    writeJson(claudeFile(), claudeHooks);
    writeJson(ownFile(), { hooks: { readClaudeSettings: true } });
    const loaded = loadHooksConfig(project, home);
    expect(Object.keys(loaded.hooks).sort()).toEqual(["PreToolUse", "Stop"]);
    expect(start()).toBe("");
  });

  it("only true opts in", () => {
    writeJson(claudeFile(), claudeHooks);
    writeJson(ownFile(), { hooks: { readClaudeSettings: "yes" } });
    expect(loadHooksConfig(project, home).hooks).toEqual({});
  });

  it("managedHooksOnly in ~/.claude still narrows what runs", () => {
    writeJson(claudeFile(), { managedHooksOnly: true });
    writeJson(path.join(project, ".continue", "settings.json"), {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }] },
    });
    expect(loadHooksConfig(project, home).managedOnly).toBe(true);
  });
});
