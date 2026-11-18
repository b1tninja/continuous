import { describe, expect, it } from "vitest";
import {
  ASSISTANT_ALLOW_REASON,
  FOLDER_ALLOW_REASON,
  listEffectiveRules,
  type RuleSourcesInput,
} from "./effectiveRules";
import { DEFAULT_POLICY_LEVELS } from "./policy";

const full: RuleSourcesInput = {
  floor: ["runTerminalCommand(rm -rf /*)"],
  user: {
    deny: ["runTerminalCommand(terraform apply*)"],
    ask: ["runTerminalCommand(git push*)"],
    allow: ["runTerminalCommand(npm test*)", "readFile(src/**)"],
  },
  assistant: { allow: ["mcp__github__*"], deny: ["writeFile(.github/**)"] },
  folder: [
    {
      file: "/repo/.continue/rules.yaml",
      permissions: {
        allow: ["runTerminalCommand(curl*)"],
        ask: ["readFile(.env*)"],
      },
    },
  ],
  cliFile: { allow: ["Bash(ls)"], exclude: ["Write(.git/**)"] },
};

const byRaw = (report: ReturnType<typeof listEffectiveRules>, raw: string) =>
  report.rules.find((r) => r.raw === raw)!;

describe("listEffectiveRules", () => {
  const report = listEffectiveRules(full);

  it("covers every source", () => {
    const sources = new Set(report.rules.map((r) => r.source));
    expect([...sources].sort()).toEqual(
      [
        "assistant",
        "floor",
        "folder",
        "permissions-yaml",
        "user-config",
      ].sort(),
    );
  });

  it("derives the area from the tool name", () => {
    expect(byRaw(report, "runTerminalCommand(npm test*)").area).toBe("tools");
    expect(byRaw(report, "readFile(src/**)").area).toBe("context");
    expect(byRaw(report, "writeFile(.github/**)").area).toBe("edits");
    expect(byRaw(report, "mcp__github__*").area).toBe("tools");
    expect(byRaw(report, "Write(.git/**)").area).toBe("edits");
    expect(byRaw(report, "runTerminalCommand(npm test*)").areaNote).toMatch(
      /per command/,
    );
  });

  it("puts rules in their area, deny first, then ask, then allow", () => {
    const tools = report.areas.tools.rules.map((r) => r.decision);
    expect(tools).toEqual(
      [...tools].sort((a, b) => "dax".indexOf(a[0]) - "dax".indexOf(b[0])),
    );
    expect(report.areas.tools.rules[0].decision).toBe("deny");
  });

  it("shows both dialects when the rule has them", () => {
    const r = byRaw(report, "runTerminalCommand(npm test*)");
    expect(r.core).toBe("runTerminalCommand(npm test*)");
    expect(r.cli).toBe("Bash(npm test*)");
    const cli = byRaw(report, "Bash(ls)");
    expect(cli.dialect).toBe("cli");
    expect(cli.core).toBe("runTerminalCommand(ls)");
    expect(cli.decision).toBe("allow");
    expect(byRaw(report, "Write(.git/**)").decision).toBe("deny");
    expect(byRaw(report, "mcp__github__*").cli).toBe("mcp__github__*");
  });

  it("has no CLI form for a host: or effect: rule", () => {
    const r = listEffectiveRules({
      user: { deny: ["runTerminalCommand(host:*.x.com)"] },
    }).rules[0];
    expect(r.cli).toBeUndefined();
    expect(r.core).toBe("runTerminalCommand(host:*.x.com)");
  });

  it("flags floor rules locked and others not", () => {
    expect(byRaw(report, "runTerminalCommand(rm -rf /*)")).toMatchObject({
      locked: true,
      source: "floor",
      decision: "deny",
      state: "effective",
    });
    expect(byRaw(report, "readFile(src/**)").locked).toBe(false);
  });

  it("ignores a workspace allow with the reason, and keeps its ask", () => {
    const allow = byRaw(report, "runTerminalCommand(curl*)");
    expect(allow).toMatchObject({
      state: "ignored",
      ignoredCause: "trust",
      ignoredReason: FOLDER_ALLOW_REASON,
      file: "/repo/.continue/rules.yaml",
    });
    expect(byRaw(report, "readFile(.env*)").state).toBe("effective");
  });

  it("treats an assistant allow as effective until trust hardening says otherwise", () => {
    expect(byRaw(report, "mcp__github__*").state).toBe("effective");
    const hardened = listEffectiveRules({ ...full, assistantAllow: "ignored" });
    expect(byRaw(hardened, "mcp__github__*")).toMatchObject({
      state: "ignored",
      ignoredReason: ASSISTANT_ALLOW_REASON,
    });
    // a deny from the assistant still counts
    expect(byRaw(hardened, "writeFile(.github/**)").state).toBe("effective");
  });

  it("ignores allow rules while the area is Manual, except for edits", () => {
    const r = listEffectiveRules({
      ...full,
      levels: { ...DEFAULT_POLICY_LEVELS, tools: "manual", edits: "manual" },
      assistant: { allow: ["writeFile(docs/**)"] },
    });
    expect(byRaw(r, "runTerminalCommand(npm test*)")).toMatchObject({
      state: "ignored",
      ignoredCause: "level",
    });
    expect(byRaw(r, "runTerminalCommand(git push*)").state).toBe("effective");
    expect(byRaw(r, "writeFile(docs/**)").state).toBe("effective");
  });

  it("ignores every rule but the floor at IDGAF", () => {
    const r = listEffectiveRules({
      ...full,
      levels: { ...DEFAULT_POLICY_LEVELS, tools: "idgaf" },
    });
    expect(byRaw(r, "runTerminalCommand(terraform apply*)").state).toBe(
      "ignored",
    );
    expect(byRaw(r, "runTerminalCommand(rm -rf /*)").state).toBe("effective");
  });

  it("keeps an unreadable rule, ignored, with no area", () => {
    const r = listEffectiveRules({ user: { deny: ["runTerminalCommand()"] } });
    expect(r.unscoped).toHaveLength(1);
    expect(r.unscoped[0]).toMatchObject({
      state: "ignored",
      ignoredCause: "unreadable",
    });
  });

  it("puts a session tool in no area and warns about rules that never work", () => {
    const r = listEffectiveRules({
      user: {
        allow: [
          "task_list",
          "runTerminalCommand(host:x.com)",
          "mcp__a__b(foo)",
          "nonsenseTool",
        ],
      },
    });
    expect(r.rules.find((x) => x.tool === "task_list")?.area).toBeUndefined();
    expect(r.rules.find((x) => x.raw.includes("host:"))!.warnings[0]).toMatch(
      /never allows/,
    );
    expect(
      r.rules.find((x) => x.raw.startsWith("mcp__a"))!.warnings[0],
    ).toMatch(/never matches/);
    expect(r.rules.find((x) => x.tool === "nonsenseTool")!.warnings[0]).toMatch(
      /not a tool name/,
    );
  });

  it("reports the level per area and the settings Plan and Questions have", () => {
    const r = listEffectiveRules({
      levels: { ...DEFAULT_POLICY_LEVELS, tools: "permissive" },
      maxNewPlanItems: 3,
      builtin: { "plan-keeps-checks": false, "no-fetch-and-run": false },
    });
    expect(r.areas.tools).toMatchObject({
      level: "permissive",
      levelLabel: "Permissive",
    });
    expect(r.areas.plan.settings).toEqual({
      kind: "plan",
      maxNewItems: 3,
      keepsChecks: false,
    });
    expect(r.areas.questions.settings).toMatchObject({
      kind: "questions",
      delivery: "inbox",
    });
    expect(r.areas.plan.rules).toEqual([]);
    expect(r.areas.questions.rules).toEqual([]);
    expect(r.areas.context.settings).toBeUndefined();
    const nfr = r.areas.tools.builtins.find((b) => b.id === "no-fetch-and-run");
    expect(nfr?.on).toBe(false);
    expect(r.decisionOrder).toMatch(/does not matter/);
  });
});
