import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY_LEVELS } from "./policy";
import {
  applyPolicyUpdate,
  parsePolicyFile,
  readPolicyFile,
  writePolicyFile,
} from "./settingsFile";

describe("parsePolicyFile", () => {
  it("a missing or empty file is the defaults", () => {
    for (const text of [undefined, "", "  \n"]) {
      const r = parsePolicyFile(text);
      expect(r.settings.levels).toEqual(DEFAULT_POLICY_LEVELS);
      expect(r.notices).toEqual([]);
    }
  });

  it("reads levels, the plan limit, question lists, switches, floor and trusted servers", () => {
    const r = parsePolicyFile(`
levels:
  tools: permissive
  edits: automatic
plan:
  maxNewItems: 3
questions:
  delivery: wait
  youDecide: [security]
  agentDecides: [detail, design]
builtin:
  protect-network-paths: off
floor:
  - runTerminalCommand(rm -rf *)
mcpServers:
  github: trusted
`);
    expect(r.notices).toEqual([]);
    expect(r.settings).toMatchObject({
      levels: {
        ...DEFAULT_POLICY_LEVELS,
        tools: "permissive",
        edits: "automatic",
      },
      maxNewPlanItems: 3,
      questions: {
        delivery: "wait",
        youDecide: ["security"],
        agentDecides: ["detail", "design"],
      },
      builtin: { "protect-network-paths": false },
      floor: ["runTerminalCommand(rm -rf *)"],
      mcpServers: { github: "trusted" },
    });
  });

  it("a saved idgaf is read as the default, with a notice", () => {
    const r = parsePolicyFile("levels:\n  tools: idgaf\n  questions: idgaf\n");
    expect(r.settings.levels.tools).toBe(DEFAULT_POLICY_LEVELS.tools);
    expect(r.settings.levels.questions).toBe(DEFAULT_POLICY_LEVELS.questions);
    expect(r.notices.join("\n")).toContain(
      "levels.tools: idgaf is for one session",
    );
  });

  it("an unknown level or built-in is reported, never silently ignored", () => {
    const r = parsePolicyFile(
      "levels:\n  tools: sometimes\nbuiltin:\n  made-up: off\n  protect-secrets: maybe\n",
    );
    expect(r.settings.levels.tools).toBe(DEFAULT_POLICY_LEVELS.tools);
    expect(r.notices.join("\n")).toContain('"sometimes" is not a level');
    expect(r.notices.join("\n")).toContain("no built-in rule with that id");
    expect(r.notices.join("\n")).toContain("use on or off");
  });

  it("a file that is not YAML is the defaults with a notice", () => {
    const r = parsePolicyFile("levels: [unclosed");
    expect(r.settings.levels).toEqual(DEFAULT_POLICY_LEVELS);
    expect(r.notices).toHaveLength(1);
  });

  it("leaves the CLI's own keys alone", () => {
    const r = parsePolicyFile(
      "allow:\n  - Bash(ls)\nlevels:\n  tools: manual\n",
    );
    expect(r.notices).toEqual([]);
    expect(r.settings.levels.tools).toBe("manual");
  });
});

describe("applyPolicyUpdate", () => {
  it("writes levels and keeps the CLI's lists and comments", () => {
    const before = "# mine\nallow:\n  - Bash(ls)\nexclude:\n  - Bash(rm *)\n";
    const after = applyPolicyUpdate(before, {
      levels: { ...DEFAULT_POLICY_LEVELS, tools: "permissive" },
    });
    expect(after).toContain("# mine");
    expect(after).toContain("- Bash(ls)");
    expect(after).toContain("- Bash(rm *)");
    expect(parsePolicyFile(after).settings.levels.tools).toBe("permissive");
  });

  it("never writes IDGAF: the area keeps what the file had", () => {
    const first = applyPolicyUpdate(undefined, {
      levels: { ...DEFAULT_POLICY_LEVELS, tools: "permissive" },
    });
    const second = applyPolicyUpdate(first, {
      levels: { ...DEFAULT_POLICY_LEVELS, tools: "idgaf", plan: "idgaf" },
    });
    expect(second).not.toContain("idgaf");
    expect(parsePolicyFile(second).settings.levels.tools).toBe("permissive");
  });

  it("stores a built-in only when it is off, and drops the key when it is switched back on", () => {
    const off = applyPolicyUpdate(undefined, {
      builtin: { "protect-secrets": false },
    });
    expect(parsePolicyFile(off).settings.builtin).toEqual({
      "protect-secrets": false,
    });
    const on = applyPolicyUpdate(off, { builtin: { "protect-secrets": true } });
    expect(on).not.toContain("builtin");
  });

  it("writes the plan limit and the question lists", () => {
    const text = applyPolicyUpdate(undefined, {
      maxNewPlanItems: 2,
      questions: { youDecide: ["scope"], agentDecides: ["detail"] },
    });
    expect(parsePolicyFile(text).settings).toMatchObject({
      maxNewPlanItems: 2,
      questions: { youDecide: ["scope"], agentDecides: ["detail"] },
    });
  });
});

describe("the file on disk", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("round-trips, and a missing file reads as the defaults", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-file-"));
    const file = path.join(dir, "nested", "permissions.yaml");
    expect(readPolicyFile(file).settings.levels).toEqual(DEFAULT_POLICY_LEVELS);
    writePolicyFile(file, {
      levels: { ...DEFAULT_POLICY_LEVELS, edits: "permissive" },
    });
    expect(readPolicyFile(file).settings.levels.edits).toBe("permissive");
  });

  it("does not write over a file that is not valid YAML", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-file-"));
    const file = path.join(dir, "permissions.yaml");
    const broken = "floor:\n  - Bash(rm -rf*)\nallow: [Read\n";
    fs.writeFileSync(file, broken);
    expect(() =>
      writePolicyFile(file, {
        levels: { ...DEFAULT_POLICY_LEVELS, edits: "permissive" },
      }),
    ).toThrow();
    expect(fs.readFileSync(file, "utf-8")).toBe(broken);
    expect(fs.readdirSync(dir)).toEqual(["permissions.yaml"]);
  });

  it("keeps comments and the keys it does not set", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-file-"));
    const file = path.join(dir, "permissions.yaml");
    fs.writeFileSync(
      file,
      "# mine\nfloor:\n  - Bash(rm -rf*) # never\nallow:\n  - Read\n",
    );
    writePolicyFile(file, {
      levels: { ...DEFAULT_POLICY_LEVELS, edits: "permissive" },
    });
    const after = fs.readFileSync(file, "utf-8");
    expect(after).toContain("# mine");
    expect(after).toContain("- Bash(rm -rf*) # never");
    expect(after).toContain("- Read");
    expect(readPolicyFile(file).settings.levels.edits).toBe("permissive");
    expect(fs.readdirSync(dir)).toEqual(["permissions.yaml"]);
  });
});

describe("plan.mcpTools", () => {
  it("reads the tools the person lets Plan mode use, and ignores what is not a name", () => {
    const text = [
      "plan:",
      "  mcpTools:",
      "    - docs/search",
      "    - 3",
      "    - wiki/*",
      "",
    ].join(String.fromCharCode(10));
    expect(parsePolicyFile(text).settings.planMcpTools).toEqual([
      "docs/search",
      "wiki/*",
    ]);
  });

  it("reads plan.allowTerminal, absent by default", () => {
    const parse = (v: string) =>
      parsePolicyFile(`plan:\n  allowTerminal: ${v}\n`).settings
        .planAllowTerminal;
    expect(parse("true")).toBe(true);
    expect(parse("false")).toBe(false);
    expect(parse("maybe")).toBeUndefined();
    expect(
      parsePolicyFile(undefined).settings.planAllowTerminal,
    ).toBeUndefined();
  });

  it("is absent when the file does not say", () => {
    expect(parsePolicyFile(undefined).settings.planMcpTools).toBeUndefined();
  });
});
