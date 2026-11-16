import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shellQuote } from "./audit/suggestRules";
import { AuditTrail } from "./audit/trail";
import type { RuleSourcesInput } from "./effectiveRules";
import { readUserConfigFile } from "./readRuleSources";
import {
  clearUndoForTests,
  editToolRule,
  undoToolRuleChange,
  type EditDeps,
  type ToolRuleEdit,
} from "./ruleEditor";
import { confirmInIde, looseningText } from "./ruleEditorHandlers";
import { refusalFor } from "./ruleRefusal";
import { parseWrittenRule, writtenRuleCommand } from "./writtenRule";

const HOME = process.platform === "win32" ? "C:/Users/dev" : "/home/dev";
const SAMPLE = `name: test
version: 1.0.0
# my rules
toolPermissions:
  ask:
    - runTerminalCommand(git push*)
    - runTerminalCommand(git pull*)
    - runTerminalCommand(git fetch*)
  allow:
    - runTerminalCommand(npm test*)
`;

let dir: string;
let file: string;
let sources: RuleSourcesInput;
let deps: EditDeps;

const edit = (over: Partial<ToolRuleEdit>): ToolRuleEdit => ({
  op: "add",
  decision: "ask",
  rule: "runTerminalCommand(git push*)",
  source: "permissions-page",
  ...over,
});

beforeEach(() => {
  clearUndoForTests();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rule-host-"));
  file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, SAMPLE);
  sources = {};
  deps = {
    file,
    sources: () => ({
      ...sources,
      user: readUserConfigFile(file).permissions,
    }),
    audit: new AuditTrail({ dir: path.join(dir, "audit"), enabled: true }),
    home: HOME,
  };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the written dialect", () => {
  it("writes the command the CLI accepts, quoting a quote", () => {
    expect(writtenRuleCommand("allow", "runTerminalCommand(npm test*)")).toBe(
      "continuous permissions add always 'runTerminalCommand(npm test*)'",
    );
    expect(writtenRuleCommand("deny", "runTerminalCommand(echo 'x'*)")).toBe(
      "continuous permissions add never 'runTerminalCommand(echo '\\''x'\\''*)'",
    );
  });

  it("reads back exactly what `continuous audit suggest` prints as apply", () => {
    for (const rule of [
      "runTerminalCommand(npm test*)",
      "readFile(src/**)",
      "runTerminalCommand(echo 'it's'*)",
    ]) {
      const apply = `continuous permissions add always ${shellQuote(rule)}`;
      expect(parseWrittenRule(apply)).toEqual({
        ok: true,
        decision: "allow",
        rule,
      });
      expect(writtenRuleCommand("allow", rule)).toBe(apply);
    }
  });

  it("reads a labelled line, a bare rule and refuses what it cannot read", () => {
    expect(parseWrittenRule("NEVER  runTerminalCommand(rm -rf*)")).toEqual({
      ok: true,
      decision: "deny",
      rule: "runTerminalCommand(rm -rf*)",
    });
    expect(parseWrittenRule("  readFile(src/**) ")).toEqual({
      ok: true,
      rule: "readFile(src/**)",
    });
    expect(parseWrittenRule("")).toMatchObject({ ok: false });
    expect(parseWrittenRule("a\nb")).toMatchObject({ ok: false });
    expect(
      parseWrittenRule("continuous permissions add maybe 'readFile(x)'"),
    ).toMatchObject({ ok: false });
    expect(
      parseWrittenRule(
        "continuous permissions add always 'readFile(x)' --yes-allow-everything",
      ),
    ).toMatchObject({ ok: false });
  });
});

describe("refusal in the page's words", () => {
  it("refuses an Always rule that a locked rule already refuses", () => {
    const msg = refusalFor({
      decision: "allow",
      rule: "runTerminalCommand(rm -rf build*)",
      peers: [
        {
          decision: "deny",
          raw: "runTerminalCommand(rm -rf*)",
          owner: "a floor rule",
        },
      ],
    });
    expect(msg).toMatch(/a locked rule/);
    expect(msg).toMatch(/Never/);
    expect(msg).toMatch(/Nothing was changed/);
  });

  it("refuses an Always rule inside a built-in ask rule", () => {
    const msg = refusalFor({
      decision: "allow",
      rule: "runTerminalCommand(git push --force*)",
      peers: [
        {
          decision: "ask",
          raw: "runTerminalCommand(git push*)",
          owner: "a built-in rule",
        },
      ],
    });
    expect(msg).toMatch(/built-in rule/);
  });

  it("refuses when the rule's own sample call is held by a protected path or a built-in rule", () => {
    expect(
      refusalFor({
        decision: "allow",
        rule: "readFile(.env)",
        peers: [],
        after: { decision: "ask", source: "protected-path" },
      }),
    ).toMatch(/protected path/);
    expect(
      refusalFor({
        decision: "allow",
        rule: "x",
        peers: [],
        after: { decision: "ask", source: "ask-rule", ruleSource: "builtin" },
      }),
    ).toMatch(/built-in rule/);
  });

  it("leaves rules of your own, Ask and Never, and ordinary calls alone", () => {
    const peers = [
      { decision: "ask" as const, raw: "readFile(x)", owner: "your rule" },
    ];
    expect(
      refusalFor({ decision: "allow", rule: "readFile(x)", peers }),
    ).toBeUndefined();
    expect(
      refusalFor({
        decision: "ask",
        rule: "readFile(.env)",
        peers: [],
        after: { decision: "ask", source: "protected-path" },
      }),
    ).toBeUndefined();
    expect(
      refusalFor({
        decision: "allow",
        rule: "runTerminalCommand(npm test*)",
        peers: [],
        after: { decision: "allow", source: "allow-rule" },
      }),
    ).toBeUndefined();
  });

  it("the editor refuses and writes nothing when a floor rule holds the calls", () => {
    sources = { floor: ["runTerminalCommand(terraform destroy*)"] };
    const before = fs.readFileSync(file, "utf8");
    const res = editToolRule(
      edit({
        decision: "allow",
        rule: "runTerminalCommand(terraform destroy -auto-approve*)",
      }),
      deps,
    );
    expect(res.result).toBe("refused");
    expect(res.error).toMatch(/Always/);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
});

describe("the native confirmation text and dialog", () => {
  it("names the change in Never, Ask and Always", () => {
    const t = looseningText("remove", {
      decision: "deny",
      rule: "runTerminalCommand(terraform apply*)",
    });
    expect(t).toMatch(/Remove the Never rule/);
    expect(t).toMatch(/without asking/);
    expect(
      looseningText("update", {
        decision: "ask",
        rule: "a(x)",
        newDecision: "allow",
        newRule: "a(y)",
      }),
    ).toMatch(/Change Ask a\(x\) to Always a\(y\)/);
  });

  it("is modal in VS Code and answers true only for Allow", async () => {
    const showToast = vi.fn().mockResolvedValue("Allow");
    const ide = {
      getIdeInfo: async () => ({ ideType: "vscode" }),
      showToast,
    } as never;
    expect(await confirmInIde(ide, "text")).toBe(true);
    expect(showToast).toHaveBeenCalledWith(
      "warning",
      "text",
      { modal: true },
      "Allow",
    );
  });

  it("sends only strings to other IDEs and treats a closed notification as no", async () => {
    const showToast = vi.fn().mockResolvedValue("");
    const ide = {
      getIdeInfo: async () => ({ ideType: "jetbrains" }),
      showToast,
    } as never;
    expect(await confirmInIde(ide, "text")).toBe(false);
    expect(showToast).toHaveBeenCalledWith("warning", "text", "Allow");
  });
});
