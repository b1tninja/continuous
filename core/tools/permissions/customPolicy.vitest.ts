import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addToList,
  changedAreas,
  moveToList,
  ownRuleLists,
  planRuleChanges,
  removeFromList,
  ruleMatchesSample,
  type RuleLists,
} from "./customPolicy";
import { listEffectiveRules } from "./effectiveRules";
import { readUserConfigFile } from "./readRuleSources";
import { CONFIRM_PHRASE } from "./ruleAnalysis";
import { clearUndoForTests, editToolRule, type EditDeps } from "./ruleEditor";
import { resolveToolPermissions } from "./ruleTrust";
import { POLICY_PRESETS } from "./policy";

const HOME = process.platform === "win32" ? "C:/Users/dev" : "/home/dev";

const SAMPLE = `name: test
version: 1.0.0
# my rules
toolPermissions:
  deny:
    - runTerminalCommand(terraform apply*) # never
  ask:
    - runTerminalCommand(git push*)
  allow:
    - runTerminalCommand(npm test*)
`;

let dir: string;
let file: string;
let deps: EditDeps;

beforeEach(() => {
  clearUndoForTests();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "custom-policy-"));
  file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, SAMPLE);
  deps = {
    file,
    sources: () => ({ user: readUserConfigFile(file).permissions }),
    home: HOME,
  };
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Save a plan the way the wizard does: one checked edit at a time, with the confirmation. */
function save(before: RuleLists, after: RuleLists): string[] {
  const results: string[] = [];
  for (const change of planRuleChanges(before, after)) {
    const res = editToolRule(
      {
        ...change,
        source: "permissions-page",
        confirm: CONFIRM_PHRASE,
        baseHash: readUserConfigFile(file).hash,
      },
      deps,
    );
    results.push(res.result);
  }
  return results;
}

/** The lists as the page reads them; the report's order is its own, so sorted */
const listsNow = (): RuleLists => {
  const lists = ownRuleLists(
    listEffectiveRules({ user: readUserConfigFile(file).permissions }).rules,
  );
  return {
    allow: [...lists.allow].sort(),
    ask: [...lists.ask].sort(),
    deny: [...lists.deny].sort(),
  };
};
const sorted = (l: RuleLists): RuleLists => ({
  allow: [...l.allow].sort(),
  ask: [...l.ask].sort(),
  deny: [...l.deny].sort(),
});

describe("the wizard's rule lists", () => {
  it("start from the person's own rules", () => {
    expect(listsNow()).toEqual({
      deny: ["runTerminalCommand(terraform apply*)"],
      ask: ["runTerminalCommand(git push*)"],
      allow: ["runTerminalCommand(npm test*)"],
    });
  });

  it("add, remove and move round-trip to config.yaml text exactly, comments kept", () => {
    const before = listsNow();
    let after = before;
    const added = addToList(after, "deny", "runTerminalCommand(rm -rf /*)");
    expect(added.ok).toBe(true);
    after = added.ok ? added.lists : after;
    after = moveToList(after, "ask", "deny", "runTerminalCommand(git push*)");
    after = removeFromList(after, "allow", "runTerminalCommand(npm test*)");
    expect(planRuleChanges(before, after)).toEqual([
      {
        op: "remove",
        decision: "allow",
        rule: "runTerminalCommand(npm test*)",
      },
      {
        op: "update",
        decision: "ask",
        rule: "runTerminalCommand(git push*)",
        newDecision: "deny",
        newRule: "runTerminalCommand(git push*)",
      },
      { op: "add", decision: "deny", rule: "runTerminalCommand(rm -rf /*)" },
    ]);
    expect(save(before, after)).toEqual(["removed", "updated", "added"]);
    expect(fs.readFileSync(file, "utf8")).toBe(`name: test
version: 1.0.0
# my rules
toolPermissions:
  deny:
    - runTerminalCommand(terraform apply*) # never
    - runTerminalCommand(git push*)
    - runTerminalCommand(rm -rf /*)
`);
    expect(listsNow()).toEqual(sorted(after));

    // And back: the reverse plan gives the lists as they were
    expect(save(after, before)).toEqual(["removed", "updated", "added"]);
    expect(listsNow()).toEqual({
      deny: ["runTerminalCommand(terraform apply*)"],
      ask: ["runTerminalCommand(git push*)"],
      allow: ["runTerminalCommand(npm test*)"],
    });
  });

  it("no change plans nothing", () => {
    const lists = listsNow();
    expect(planRuleChanges(lists, lists)).toEqual([]);
  });

  it("an invalid pattern is refused with the editor's own sentence", () => {
    const empty = addToList(listsNow(), "allow", "runTerminalCommand()");
    expect(empty).toEqual({
      ok: false,
      error:
        "Write a rule as toolName(pattern), or just toolName. A pattern in brackets cannot be empty.",
    });
    const blank = addToList(listsNow(), "deny", "   ");
    expect(blank.ok).toBe(false);
    const hidden = addToList(listsNow(), "deny", "readFile(a\u202eb)");
    expect(hidden).toEqual({
      ok: false,
      error: "A rule cannot hold control or invisible characters.",
    });
    const twice = addToList(
      listsNow(),
      "allow",
      "runTerminalCommand(git push*)",
    );
    expect(twice).toEqual({
      ok: false,
      error: "That rule is already in the Ask list. Move it instead.",
    });
  });

  it("a workspace's Always rule is not copied in, so saving cannot widen", () => {
    const report = listEffectiveRules({
      user: readUserConfigFile(file).permissions,
      folder: [
        {
          file: "/proj/.continue/config.yaml",
          permissions: { allow: ["runTerminalCommand(curl*)"] },
        },
      ],
    });
    expect(
      report.rules.some((r) => r.raw === "runTerminalCommand(curl*)"),
    ).toBe(true);
    const lists = ownRuleLists(report.rules);
    expect(lists.allow).toEqual(["runTerminalCommand(npm test*)"]);
    // And the loader still drops an allow nobody owns, whatever the wizard saved
    const merged = {
      allow: ["runTerminalCommand(npm test*)", "runTerminalCommand(curl*)"],
    };
    expect(
      resolveToolPermissions({ allow: lists.allow }, merged).permissions?.allow,
    ).toEqual(["runTerminalCommand(npm test*)"]);
  });
});

describe("the live preview uses the engine's matchers", () => {
  it("commands", () => {
    const rule = "runTerminalCommand(git push*)";
    expect(
      ruleMatchesSample(rule, "deny", {
        tool: "runTerminalCommand",
        value: "git push origin main",
      }),
    ).toBe(true);
    expect(
      ruleMatchesSample(rule, "deny", {
        tool: "runTerminalCommand",
        value: "git status",
      }),
    ).toBe(false);
    // Deny reads every part of a chain; allow needs every part covered
    expect(
      ruleMatchesSample(rule, "deny", {
        tool: "runTerminalCommand",
        value: "echo hi && git push",
      }),
    ).toBe(true);
    expect(
      ruleMatchesSample(rule, "allow", {
        tool: "runTerminalCommand",
        value: "echo hi && git push",
      }),
    ).toBe(false);
  });

  it("paths and MCP names, and an unreadable rule", () => {
    expect(
      ruleMatchesSample("writeFile(.github/**)", "deny", {
        tool: "edit_existing_file",
        value: ".github/workflows/ci.yml",
      }),
    ).toBe(true);
    expect(
      ruleMatchesSample("mcp__github__*", "ask", {
        tool: "mcp__github__create_issue",
      }),
    ).toBe(true);
    expect(
      ruleMatchesSample("runTerminalCommand()", "deny", {
        tool: "runTerminalCommand",
        value: "ls",
      }),
    ).toBeUndefined();
  });
});

describe("levels", () => {
  it("names the areas that differ from the base", () => {
    expect(
      changedAreas(POLICY_PRESETS.careful.levels, {
        ...POLICY_PRESETS.careful.levels,
        edits: "permissive",
      }),
    ).toEqual(["edits"]);
  });
});

describe("samples from the audit list", () => {
  it("reads a command, a path from the masked arguments and an MCP name", async () => {
    const { sampleFromCall, ruleForSample } = await import("./customPolicy");
    expect(
      sampleFromCall({ tool: "run_terminal_command", summary: "git push" }),
    ).toEqual({ tool: "runTerminalCommand", value: "git push" });
    expect(
      sampleFromCall({
        tool: "read_file",
        summary: '{"filepath":"src/a.ts"}',
      }),
    ).toEqual({ tool: "readFile", value: "src/a.ts" });
    expect(
      sampleFromCall({ tool: "mcp__github__create_issue", summary: "{}" }),
    ).toEqual({ tool: "mcp__github__create_issue" });
    // A clipped summary is not a sample
    expect(
      sampleFromCall({ tool: "run_terminal_command", summary: "git push …" }),
    ).toBeUndefined();
    expect(
      ruleForSample({ tool: "runTerminalCommand", value: "git push" }),
    ).toBe("runTerminalCommand(git push)");
    expect(ruleForSample({ tool: "mcp__github__create_issue" })).toBe(
      "mcp__github__create_issue",
    );
  });
});
