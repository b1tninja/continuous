import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetWarnOnce } from "../util/readPolicyFile.js";

import { getMatchingHookGroups, loadHooksConfig } from "./hookConfig.js";
import { setTrustProjectHooksForRun } from "./hookTrust.js";

describe("hook settings files that do not parse", () => {
  let root: string;
  let home: string;
  let cwd: string;

  const userHooks = {
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "guard" }] },
      ],
    },
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-broken-"));
    home = path.join(root, "home");
    cwd = path.join(root, "project");
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
    delete process.env.CONTINUOUS_GLOBAL_DIR;
    delete process.env.CONTINUE_GLOBAL_DIR;
    setTrustProjectHooksForRun(true);
    resetWarnOnce();
  });
  afterEach(() => {
    setTrustProjectHooksForRun(false);
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("an absent file is not broken", () => {
    const loaded = loadHooksConfig(cwd, home);
    expect(loaded.broken).toBeUndefined();
    expect(loaded.hooks).toEqual({});
  });

  it("a valid file loads and is not broken", () => {
    fs.writeFileSync(
      path.join(home, ".claude", "settings.json"),
      JSON.stringify(userHooks),
    );
    const loaded = loadHooksConfig(cwd, home);
    expect(loaded.broken).toBeUndefined();
    expect(loaded.hooks.PreToolUse).toHaveLength(1);
  });

  it("a broken user file is reported, with position and without contents", () => {
    const file = path.join(home, ".claude", "settings.json");
    fs.writeFileSync(file, '{ "token": "sk-canary",\n}');
    const loaded = loadHooksConfig(cwd, home);
    expect(loaded.hooks).toEqual({});
    expect(loaded.broken).toHaveLength(1);
    expect(loaded.broken![0].path).toBe(file);
    expect(loaded.broken![0].error).toMatch(/line 2, column 1/);
    expect(loaded.broken![0].error).not.toContain("sk-canary");
  });

  it("a broken project file is reported and does not drop the user's hooks", () => {
    fs.writeFileSync(
      path.join(home, ".claude", "settings.json"),
      JSON.stringify(userHooks),
    );
    const projectFile = path.join(cwd, ".claude", "settings.json");
    fs.writeFileSync(projectFile, "{ nope");
    const loaded = loadHooksConfig(cwd, home);
    expect(loaded.hooks.PreToolUse).toHaveLength(1);
    expect(loaded.broken?.map((b) => b.path)).toEqual([projectFile]);
  });

  it("a settings file that is not an object is broken", () => {
    const file = path.join(home, ".claude", "settings.json");
    fs.writeFileSync(file, "[]");
    expect(loadHooksConfig(cwd, home).broken?.[0].error).toContain(
      "wrong structure",
    );
  });
});

describe("a hook matcher that is not a valid regex", () => {
  beforeEach(() => resetWarnOnce());
  afterEach(() => vi.restoreAllMocks());

  const config = {
    PreToolUse: [
      {
        matcher: "[invalid",
        hooks: [{ type: "command" as const, command: "guard" }],
      },
    ],
  };

  it("runs the hook and warns once per session", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(getMatchingHookGroups(config, "PreToolUse", "Bash")).toHaveLength(1);
    expect(getMatchingHookGroups(config, "PreToolUse", "Read")).toHaveLength(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0][0])).toContain("[invalid");
  });
});
