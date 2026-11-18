import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  permissionsCommand,
  type PermissionsCommandOptions,
} from "./permissions.js";

let dir: string;
let options: PermissionsCommandOptions;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-permissions-"));
  fs.writeFileSync(
    path.join(dir, "config.yaml"),
    [
      "name: t",
      "toolPermissions:",
      "  deny:",
      "    - runTerminalCommand(terraform apply*)",
      "  ask:",
      "    - runTerminalCommand(git push*)",
      "  allow:",
      "    - runTerminalCommand(npm test*)",
      "    - readFile(docs/**)",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "permissions.yaml"),
    [
      "levels:",
      "  tools: permissive",
      "floor:",
      "  - runTerminalCommand(rm -rf /*)",
      "allow:",
      "  - Bash(ls)",
      "exclude:",
      "  - Write(.git/**)",
      "",
    ].join("\n"),
  );
  options = {
    configFile: path.join(dir, "config.yaml"),
    permissionsFile: path.join(dir, "permissions.yaml"),
    cwd: dir,
  };
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function run(
  action: string | undefined,
  args: string[] = [],
  extra: PermissionsCommandOptions = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = permissionsCommand(
    action,
    args,
    { ...options, ...extra },
    { out: (l) => out.push(l), err: (l) => err.push(l) },
  );
  return { code, text: out.join("\n"), err: err.join("\n") };
}

describe("continuous permissions list", () => {
  it("lists every area with its level and each rule with source and flags", () => {
    const { code, text } = run("list");
    expect(code).toBe(0);
    expect(text).toContain("Tool use: Permissive");
    expect(text).toContain("DENY  runTerminalCommand(terraform apply*)");
    expect(text).toContain("[user-config]");
    expect(text).toContain("runTerminalCommand(rm -rf /*)");
    expect(text).toContain("[floor, locked]");
    expect(text).toContain("Bash(ls) = runTerminalCommand(ls)");
    expect(text).toContain("[permissions-yaml]");
    expect(text).toContain("(a level and a few settings, not rules)");
    expect(text).toMatch(/does not matter/);
  });

  it("defaults to list, and filters by area", () => {
    const { text } = run(undefined, [], { area: "context" });
    expect(text).toContain("Context use: Permissive");
    expect(text).toContain("readFile(docs/**)");
    expect(text).not.toContain("terraform apply");
  });

  it("prints the same data as JSON", () => {
    const { text } = run("list", [], { json: true });
    const report = JSON.parse(text);
    expect(report.areas.tools.level).toBe("permissive");
    expect(
      report.rules.some(
        (r: any) => r.source === "floor" && r.locked && r.decision === "deny",
      ),
    ).toBe(true);
    const one = JSON.parse(run("list", [], { json: true, area: "edits" }).text);
    expect(one.area.rules.map((r: any) => r.raw)).toEqual(["Write(.git/**)"]);
  });

  it("rejects an unknown area and an unknown action", () => {
    expect(run("list", [], { area: "nope" }).code).toBe(1);
    expect(run("frobnicate").code).toBe(1);
  });

  it("writes nothing", () => {
    const before = fs
      .readdirSync(dir)
      .map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]);
    run("list");
    run("test", ["bash", "npm", "test"]);
    const after = fs
      .readdirSync(dir)
      .map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]);
    expect(after).toEqual(before);
  });
});

describe("continuous permissions test", () => {
  it("joins the words into a command and runs the real evaluator", () => {
    const allow = run("test", ["runTerminalCommand", "npm", "test", "--watch"]);
    expect(allow.code).toBe(0);
    expect(allow.text).toContain("ALLOW (allow-rule)");
    expect(allow.text).toContain(
      "Matches: allow runTerminalCommand(npm test*)",
    );
    const ask = run("test", ["Bash", "git", "push", "origin", "main"]);
    expect(ask.text).toContain("ASK (ask-rule)");
    expect(ask.text).toContain("<- decided");
    const deny = run("test", ["Bash", "terraform", "apply"]);
    expect(deny.text).toContain("DENY (deny-rule)");
    expect(deny.text).toContain("toolPermissions.deny in your config.yaml");
  });

  it("applies the floor and protected paths", () => {
    expect(run("test", ["Bash", "rm", "-rf", "/tmp/x"]).text).toMatch(/DENY/);
    const floor = run("test", ["Bash", "rm", "-rf", "/build"], {
      level: ["tools=idgaf"],
    });
    // IDGAF runs it, and says what the floor would have done
    expect(floor.text).toContain("ALLOW (idgaf)");
    expect(floor.text).toContain("would have been refused");
    const env = run("test", ["readFile", ".env"]);
    expect(env.text).toContain("ASK (protected-path)");
  });

  it("takes levels and mode, and prints JSON", () => {
    const { text } = run("test", ["Bash", "make", "build"], {
      json: true,
      level: ["tools=automatic"],
    });
    const r = JSON.parse(text);
    expect(r.wouldAskReviewer).toBe(true);
    expect(r.decision).toBe("ask");
    expect(run("test", ["Bash", "ls"], { mode: "chat" }).text).toContain(
      "Chat mode offers no tools",
    );
  });

  it("tests an MCP tool by name alone and says what is missing", () => {
    expect(run("test", ["mcp__github__create_issue"]).text).toMatch(
      /ASK|ALLOW/,
    );
    expect(run("test", ["Bash"]).code).toBe(1);
    expect(run("test", []).code).toBe(1);
    expect(run("test", ["Bash", "ls"], { level: ["tools=bogus"] }).code).toBe(
      1,
    );
  });
});
