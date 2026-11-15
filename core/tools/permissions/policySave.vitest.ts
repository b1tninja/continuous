import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY_LEVELS, normalizePolicy } from "./policy";
import {
  POLICY_SAVE_NOT_CONFIRMED,
  policySaveConfirmText,
  policySaveLoosenings,
  previewPolicySave,
  savePolicyWithConfirmation,
} from "./policySave";
import {
  applyPolicyUpdate,
  parsePolicyFile,
  type PolicyFileUpdate,
} from "./settingsFile";

const FILE = `# my settings
levels:
  tools: cautious # keep me
builtin:
  ask-outside-paths: off
floor:
  - runTerminalCommand(git push --force*)
  - runTerminalCommand(terraform destroy*)
plan:
  mcpTools:
    - github/get_issue
mcpServers:
  docs: trusted
allow:
  - Bash(npm test)
`;

const before = parsePolicyFile(FILE).settings;
const keys = (update: PolicyFileUpdate) =>
  policySaveLoosenings(before, update).map((l) => l.key);

describe("policySaveLoosenings: what a save loosens", () => {
  it.each<[string, PolicyFileUpdate, string[]]>([
    [
      "raising a level",
      { levels: { ...before.levels, tools: "permissive" } },
      ["levels.tools"],
    ],
    [
      "IDGAF counts as raised, though it is never written",
      { levels: { ...before.levels, edits: "idgaf" } },
      ["levels.edits"],
    ],
    [
      "lowering a level does not",
      { levels: { ...before.levels, tools: "manual" } },
      [],
    ],
    ["the same levels do not", { levels: { ...before.levels } }, []],
    [
      "switching a built-in rule off",
      { builtin: { "protect-secrets": false } },
      ["builtin.protect-secrets"],
    ],
    [
      "a built-in rule already off, or switched on, does not",
      { builtin: { "ask-outside-paths": false, "protect-secrets": true } },
      [],
    ],
    [
      "removing a floor rule",
      { floor: ["runTerminalCommand(git push --force*)"] },
      ["floor"],
    ],
    [
      "adding a floor rule does not",
      { floor: [...before.floor!, "runTerminalCommand(rm -rf /*)"] },
      [],
    ],
    [
      "trusting an MCP server",
      { trustedMcpServers: ["docs", "github"] },
      ["mcpServers"],
    ],
    ["un-trusting one does not", { trustedMcpServers: [] }, []],
    [
      "adding to plan.mcpTools",
      { planMcpTools: ["github/get_issue", "github/*"] },
      ["plan.mcpTools"],
    ],
    ["removing from plan.mcpTools does not", { planMcpTools: [] }, []],
    [
      "offering the terminal in Plan mode",
      { planAllowTerminal: true },
      ["plan.allowTerminal"],
    ],
    ["taking it away does not", { planAllowTerminal: false }, []],
    [
      "a key left out of the update does not",
      { questions: { delivery: "wait" } },
      [],
    ],
    [
      "storing a custom set does not (provenance only)",
      {
        custom: {
          from: "careful",
          levels: { ...DEFAULT_POLICY_LEVELS, edits: "permissive" },
        },
      },
      [],
    ],
  ])("%s", (_name, update, expected) => {
    expect(keys(update)).toEqual(expected);
  });

  it("names each loosening in the dialog's text", () => {
    const text = policySaveConfirmText(
      policySaveLoosenings(before, {
        levels: { ...before.levels, tools: "permissive" },
        floor: [],
        trustedMcpServers: ["docs", "github"],
      }),
    );
    expect(text).toContain("Tool use: Cautious → Permissive");
    expect(text).toContain(
      "Remove the Always-on Never rule runTerminalCommand(terraform destroy*)",
    );
    expect(text).toContain(
      "Trust the read-only hints of the MCP server github",
    );
  });
});

describe("savePolicyWithConfirmation: the native confirmation", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-save-"));
    file = path.join(dir, "permissions.yaml");
    fs.writeFileSync(file, FILE);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("asks once, with the loosenings, and writes on yes", async () => {
    const confirm = vi.fn(async (_text: string) => true);
    const update = {
      levels: { ...before.levels, tools: "permissive" as const },
    };
    await savePolicyWithConfirmation(file, update, { confirm });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toContain(
      "Tool use: Cautious → Permissive",
    );
    expect(
      parsePolicyFile(fs.readFileSync(file, "utf-8")).settings.levels.tools,
    ).toBe("permissive");
  });

  it.each([
    ["no", async () => false],
    ["a dialog that fails", async () => Promise.reject(new Error("closed"))],
  ])("writes nothing on %s", async (_name, answer) => {
    const confirm = vi.fn(answer);
    await expect(
      savePolicyWithConfirmation(
        file,
        { floor: [], trustedMcpServers: ["docs", "github"] },
        { confirm },
      ),
    ).rejects.toThrow(POLICY_SAVE_NOT_CONFIRMED);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(file, "utf-8")).toBe(FILE);
  });

  it("does not ask for a save that only tightens", async () => {
    const confirm = vi.fn(async (_text: string) => false);
    await savePolicyWithConfirmation(
      file,
      {
        levels: { ...before.levels, tools: "manual" },
        planAllowTerminal: false,
      },
      { confirm },
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, "utf-8")).toContain("tools: manual # keep me");
  });

  it("refuses an update the writer cannot read back before asking anything", async () => {
    const confirm = vi.fn(async (_text: string) => true);
    await expect(
      savePolicyWithConfirmation(
        file,
        { floor: ["("], trustedMcpServers: ["docs", "github"] },
        { confirm },
      ),
    ).rejects.toThrow(/^Not saved: floor:/);
    expect(confirm).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, "utf-8")).toBe(FILE);
  });

  it("compares against a missing file as the defaults", async () => {
    fs.rmSync(file);
    const confirm = vi.fn(async (_text: string) => true);
    await savePolicyWithConfirmation(
      file,
      { levels: { ...DEFAULT_POLICY_LEVELS, edits: "permissive" } },
      { confirm },
    );
    expect(confirm.mock.calls[0][0]).toContain(
      "File edits: Manual → Permissive",
    );
  });
});

describe("previewPolicySave: the exact diff, dry-run", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-preview-"));
    file = path.join(dir, "permissions.yaml");
    fs.writeFileSync(file, FILE);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("is the writer's own text, line by line, and writes nothing", () => {
    const update: PolicyFileUpdate = {
      levels: { ...before.levels, tools: "permissive" },
      floor: ["runTerminalCommand(git push --force*)"],
    };
    const preview = previewPolicySave(file, update);
    expect(fs.readFileSync(file, "utf-8")).toBe(FILE);
    expect(preview.after).toBe(applyPolicyUpdate(FILE, update));
    expect(preview.changed).toBe(true);
    expect(preview.diff.filter((d) => d.type !== "same")).toEqual([
      { type: "old", line: "  tools: cautious # keep me" },
      { type: "new", line: "  tools: permissive # keep me" },
      // The writer writes all five levels, so the ones the file left to
      // their defaults appear too: the diff is what will be on disk
      { type: "new", line: "  context: permissive" },
      { type: "new", line: "  edits: manual" },
      { type: "new", line: "  plan: cautious" },
      { type: "new", line: "  questions: cautious" },
      { type: "old", line: "  - runTerminalCommand(terraform destroy*)" },
    ]);
    // Old and kept lines rebuild the file; new and kept rebuild the result
    const side = (t: "old" | "new") =>
      preview.diff
        .filter((d) => d.type === "same" || d.type === t)
        .map((d) => d.line)
        .join("\n");
    expect(side("old")).toBe(FILE.trimEnd());
    expect(side("new")).toBe(preview.after.trimEnd());
    expect(preview.loosens.map((l) => l.key)).toEqual([
      "levels.tools",
      "floor",
    ]);
  });

  it("an update that changes nothing has no diff", () => {
    const preview = previewPolicySave(file, { floor: before.floor });
    expect(preview.changed).toBe(false);
    expect(preview.diff).toEqual([]);
  });

  it("says why the writer would refuse, with no diff", () => {
    const preview = previewPolicySave(file, { planMcpTools: ["a/b/c"] });
    expect(preview.problem).toMatch(/^plan\.mcpTools:/);
    expect(preview.diff).toEqual([]);
  });

  it("shows a stored custom set as the lines it adds under levels", () => {
    const preview = previewPolicySave(file, {
      custom: {
        from: "careful",
        levels: { ...DEFAULT_POLICY_LEVELS, edits: "permissive" },
      },
    });
    const added = preview.diff
      .filter((d) => d.type === "new")
      .map((d) => d.line);
    expect(added[0]).toBe("  custom:");
    expect(added).toContain("    from: careful");
    expect(added).toContain("      edits: permissive");
    expect(preview.loosens).toEqual([]);
  });
});

/** The keys every released build accepts at the top of permissions.yaml (2.16.2). */
const RELEASED_TOP_LEVEL_KEYS = [
  "allow",
  "ask",
  "exclude",
  "levels",
  "plan",
  "questions",
  "builtin",
  "floor",
  "mcpServers",
  "sandbox",
];

describe("levels.custom: the stored custom set", () => {
  const custom = {
    from: "acceptEdits" as const,
    levels: {
      ...DEFAULT_POLICY_LEVELS,
      edits: "permissive" as const,
      tools: "permissive" as const,
    },
  };

  it("round-trips, keeps the levels and comments, and is removed by null", () => {
    const text = applyPolicyUpdate(FILE, { custom });
    expect(parsePolicyFile(text).settings.custom).toEqual(custom);
    expect(parsePolicyFile(text).settings.levels).toEqual(before.levels);
    expect(text).toContain("tools: cautious # keep me");
    // Choosing a preset writes the levels and leaves the set to recall
    const preset = applyPolicyUpdate(text, {
      levels: { ...DEFAULT_POLICY_LEVELS },
    });
    expect(parsePolicyFile(preset).settings.custom).toEqual(custom);
    expect(applyPolicyUpdate(text, { custom: null })).toBe(FILE);
  });

  it("adds no top-level key, so an older CLI still reads the whole file", () => {
    const text = applyPolicyUpdate(FILE, { custom });
    for (const key of Object.keys(YAML.parse(text))) {
      expect(RELEASED_TOP_LEVEL_KEYS).toContain(key);
    }
  });

  it("an older reader of levels (one key per area) sees only the five levels and no problem", () => {
    const text = applyPolicyUpdate(FILE, { custom });
    const raw = YAML.parse(text);
    // The levels reader every release has used: the five area names, nothing else
    const { policy, problems } = normalizePolicy({ levels: raw.levels });
    expect(problems).toEqual([]);
    expect(policy.levels).toEqual(before.levels);
    expect(parsePolicyFile(text).notices).toEqual([]);
  });

  it.each([
    [
      "IDGAF in the set",
      { levels: { ...DEFAULT_POLICY_LEVELS, tools: "idgaf" } },
    ],
    ["a missing area", { levels: { tools: "manual" } }],
    ["an unknown preset", { from: "lax", levels: DEFAULT_POLICY_LEVELS }],
    ["IDGAF as the base", { from: "idgaf", levels: DEFAULT_POLICY_LEVELS }],
  ])("refuses to write, and does not offer on read, %s", async (_name, bad) => {
    await expect(
      savePolicyWithConfirmation(
        "unused",
        { custom: bad as never },
        {
          confirm: async () => true,
        },
      ),
    ).rejects.toThrow(/levels\.custom/);
    const text = `levels:\n  custom: ${JSON.stringify(bad)}\n`;
    const read = parsePolicyFile(text);
    expect(read.settings.custom).toBeUndefined();
    expect(read.notices).toEqual([
      "levels.custom: not a complete set of five levels, so it is not offered.",
    ]);
  });
});
