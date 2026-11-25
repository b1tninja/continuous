import fs from "fs";
import os from "os";
import path from "path";

import {
  DEFAULT_POLICY_LEVELS,
  POLICY_PRESETS,
  presetOf,
} from "core/tools/permissions/policy.js";
import { noChecksOn } from "core/tools/permissions/safetyDegrees.js";
import { readPolicyFile } from "core/tools/permissions/settingsFile.js";
import { afterEach, describe, expect, it } from "vitest";

import { handleSlashCommands } from "../slashCommands.js";

import { setAutoReviewEnabled } from "./coreRules.js";
import { evaluateWithCoreRules } from "./coreRules.js";
import { loadPermissionsYaml } from "./permissionsYamlLoader.js";
import {
  approvalExtras,
  describePolicy,
  effectiveLevels,
  getPolicyLevels,
  levelsForAutonomy,
  loadPolicyFile,
  parsePolicySpec,
  policyIsDefault,
  YOLO_DEPRECATION_NOTE,
  resetPolicyLevels,
  savePolicyFile,
  setPolicyBuiltin,
  setPolicyLevels,
  toolLevelsAreDefault,
} from "./policyLevels.js";

const withFile = (text: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-policy-"));
  const file = path.join(dir, "permissions.yaml");
  fs.writeFileSync(file, text);
  return { dir, file };
};

afterEach(() => {
  resetPolicyLevels();
  setAutoReviewEnabled(false);
});

describe("parsePolicySpec", () => {
  it("takes a preset by name, in any case, with its levels and its switches", () => {
    const r = parsePolicySpec("IDGAF");
    expect(r.ok && r.levels).toEqual(POLICY_PRESETS.idgaf.levels);
    expect(r.ok && noChecksOn(r.builtin)).toBe(true);
    const careful = parsePolicySpec("careful");
    expect(careful.ok && careful.levels).toEqual(DEFAULT_POLICY_LEVELS);
    expect(careful.ok && noChecksOn(careful.builtin)).toBe(false);
  });

  it("levels given one by one carry no switches: the file's are left as they are", () => {
    const r = parsePolicySpec("tools=permissive");
    expect(r.ok && r.builtin).toBeUndefined();
  });

  it("takes area=level pairs on top of the current levels", () => {
    const r = parsePolicySpec("tools=permissive,plan=manual");
    expect(r.ok && r.levels).toEqual({
      ...DEFAULT_POLICY_LEVELS,
      tools: "permissive",
      plan: "manual",
    });
  });

  it("yolo, any case, still works as the idgaf preset and says so", () => {
    for (const spec of ["yolo", "YOLO"]) {
      const r = parsePolicySpec(spec);
      expect(r.ok && r.levels).toEqual(POLICY_PRESETS.idgaf.levels);
      expect(r.ok && noChecksOn(r.builtin)).toBe(true);
      expect(r.ok && r.deprecated).toBe(YOLO_DEPRECATION_NOTE);
    }
    // as a level the old word is read as Permissive
    const pair = parsePolicySpec("tools=yolo,plan=manual");
    expect(pair.ok && pair.levels.tools).toBe("permissive");
    expect(pair.ok && pair.deprecated).toBe(YOLO_DEPRECATION_NOTE);
    // the new name carries no note, and the note never repeats the profanity
    expect(parsePolicySpec("idgaf")).not.toHaveProperty("deprecated");
    expect(YOLO_DEPRECATION_NOTE).not.toContain("\n");
  });

  it("a bare level sets every area, and idgaf is a preset, not a level", () => {
    const r = parsePolicySpec("permissive");
    expect(r.ok && Object.values(r.levels)).toEqual(
      Array(5).fill("permissive"),
    );
    const idgaf = parsePolicySpec("idgaf");
    expect(idgaf.ok && idgaf.levels.tools).toBe("permissive");
    // Delegate is a Questions level only
    expect(parsePolicySpec("delegate")).toMatchObject({ ok: false });
    expect(parsePolicySpec("tools=delegate")).toMatchObject({ ok: false });
    const q = parsePolicySpec("questions=delegate");
    expect(q.ok && q.levels.questions).toBe("delegate");
  });

  it("refuses what it cannot read, naming it", () => {
    expect(parsePolicySpec("tools=sometimes")).toMatchObject({
      ok: false,
      error: expect.stringContaining('"sometimes"'),
    });
    expect(parsePolicySpec("colour=manual")).toMatchObject({ ok: false });
    expect(parsePolicySpec("whatever")).toMatchObject({ ok: false });
    expect(parsePolicySpec("  ")).toMatchObject({ ok: false });
  });
});

describe("effectiveLevels", () => {
  it("is the levels the person set", () => {
    setPolicyLevels({ ...DEFAULT_POLICY_LEVELS, tools: "manual" });
    expect(effectiveLevels("normal").tools).toBe("manual");
  });

  it("--auto is Permissive on the tool areas and a plan that goes on", () => {
    const l = effectiveLevels("auto");
    expect([l.context, l.tools, l.edits]).toEqual([
      "permissive",
      "permissive",
      "permissive",
    ]);
    expect(l.plan).toBe("permissive");
  });

  it("--auto has no check on, for the run only: the file's switches are not changed", () => {
    expect(noChecksOn(approvalExtras("auto").builtin)).toBe(true);
    expect(noChecksOn(approvalExtras("normal").builtin)).toBe(false);
    // asking again for the normal mode gives the file's switches back
    expect(approvalExtras("normal").builtin).toBeUndefined();
  });

  it("--auto keeps the file's own floor and its other settings", () => {
    const { dir, file } = withFile("floor:\n  - Bash(rm -rf *)\n");
    try {
      loadPolicyFile(file);
      expect(approvalExtras("auto").floor).toEqual(["Bash(rm -rf *)"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--auto-review makes Cautious Automatic, and keeps a level set higher", () => {
    setAutoReviewEnabled(true);
    setPolicyLevels({ ...DEFAULT_POLICY_LEVELS, tools: "permissive" });
    const l = effectiveLevels("normal");
    expect(l.tools).toBe("permissive");
    expect(l.context).toBe("permissive");
    expect(l.edits).toBe("manual");
  });

  it("the defaults leave core's engine out of calls that have no rules", () => {
    expect(toolLevelsAreDefault(effectiveLevels("normal"))).toBe(true);
    setPolicyLevels({ ...DEFAULT_POLICY_LEVELS, tools: "permissive" });
    expect(toolLevelsAreDefault(effectiveLevels("normal"))).toBe(false);
  });
});

describe("levelsForAutonomy", () => {
  it("maps the old level names onto Plan edits and Questions", () => {
    expect(levelsForAutonomy("supervised")).toEqual({
      plan: "manual",
      questions: "manual",
    });
    expect(levelsForAutonomy("idgaf")).toEqual({
      plan: "permissive",
      questions: "delegate",
    });
  });
});

describe("the levels reach core's engine", () => {
  const run = (
    levels: Partial<typeof DEFAULT_POLICY_LEVELS>,
    command: string,
  ) =>
    evaluateWithCoreRules({
      cliToolName: "Bash",
      args: { command },
      cliPermission: "ask",
      assistantPermissions: undefined,
      approval: { levels: { ...DEFAULT_POLICY_LEVELS, ...levels } },
      isHeadless: false,
    });

  it("Permissive runs a command the CLI would ask about", async () => {
    expect(
      await run({ tools: "permissive" }, "git push origin main"),
    ).toMatchObject({ decision: "allow", by: "rules" });
  });

  it("Manual still asks", async () => {
    expect((await run({ tools: "manual" }, "git push"))?.decision).toBe("ask");
  });

  it("at the default levels a command that only reads runs, and others still ask", async () => {
    expect(await run({}, "ls")).toMatchObject({
      decision: "allow",
      by: "rules",
    });
    expect(await run({}, "cat a.txt | sort")).toMatchObject({
      decision: "allow",
    });
    expect((await run({}, "npm test"))?.decision).toBe("ask");
    expect((await run({}, "ls > out.txt"))?.decision).toBe("ask");
  });

  it("a read-only command that names a credentials file still asks", async () => {
    expect((await run({}, "cat ~/.aws/credentials"))?.decision).toBe("ask");
  });

  it("without levels or rules the CLI keeps its own result", async () => {
    expect(
      await evaluateWithCoreRules({
        cliToolName: "Bash",
        args: { command: "ls" },
        cliPermission: "ask",
        assistantPermissions: undefined,
        isHeadless: false,
      }),
    ).toBeUndefined();
  });
});

describe("/policy", () => {
  it("shows the five areas", async () => {
    const r = await handleSlashCommands("/policy", {} as never);
    expect(r?.output).toContain("Context use");
    expect(r?.output).toContain("Questions");
    expect(r?.output).toContain("Careful");
  });

  it("sets levels, and says what it did not understand", async () => {
    await handleSlashCommands("/policy tools=permissive --yes", {} as never);
    expect(getPolicyLevels().tools).toBe("permissive");
    const bad = await handleSlashCommands("/policy tools=never", {} as never);
    expect(bad?.output).toContain('"never"');
    expect(getPolicyLevels().tools).toBe("permissive");
  });

  it("describePolicy names a custom mix", () => {
    expect(
      describePolicy({ ...DEFAULT_POLICY_LEVELS, tools: "permissive" }).join(
        "\n",
      ),
    ).toContain("Custom");
  });

  it("describePolicy uses the vocabulary: preset, level, rule", () => {
    const text = describePolicy(DEFAULT_POLICY_LEVELS).join("\n");
    expect(text).toContain("Preset: Careful");
    expect(text).toContain("Level of each area:");
    expect(text).toContain("Never, Ask, Always");
  });
});

describe("the shared settings file", () => {
  it("loads levels, switches and the floor, and reports what it cannot use", () => {
    const { dir, file } = withFile(
      "allow:\n  - Bash(ls)\nlevels:\n  tools: permissive\n  plan: delegate\nbuiltin:\n  protect-network-paths: off\nfloor:\n  - Bash(rm -rf *)\n",
    );
    try {
      const notices = loadPolicyFile(file);
      expect(getPolicyLevels().tools).toBe("permissive");
      // Delegate is a Questions level only: reported, and the default applies
      expect(getPolicyLevels().plan).toBe(DEFAULT_POLICY_LEVELS.plan);
      expect(notices.join("\n")).toContain("delegate");
      expect(approvalExtras("normal")).toEqual({
        builtin: { "protect-network-paths": false },
        floor: ["Bash(rm -rf *)"],
      });
      expect(policyIsDefault(effectiveLevels("normal"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a floor or a switched-off built-in is enough to run core's engine", () => {
    const { dir, file } = withFile("floor:\n  - Bash(rm -rf *)\n");
    try {
      loadPolicyFile(file);
      expect(toolLevelsAreDefault(effectiveLevels("normal"))).toBe(true);
      expect(policyIsDefault(effectiveLevels("normal"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("saving keeps the CLI's own lists, and a preset's switches are saved with its levels", () => {
    const { dir, file } = withFile("allow:\n  - Bash(ls)\n");
    try {
      const preset = parsePolicySpec("idgaf");
      if (!preset.ok) throw new Error(preset.error);
      setPolicyLevels(preset.levels);
      setPolicyBuiltin(preset.builtin);
      savePolicyFile(file);
      const text = fs.readFileSync(file, "utf-8");
      expect(text).toContain("Bash(ls)");
      expect(text).not.toContain("idgaf");
      expect(text).toContain("tools: permissive");
      // the switches are in the file: reading it back is the same preset
      const back = readPolicyFile(file).settings;
      expect(presetOf(back.levels, back.builtin)).toBe("idgaf");
      expect(noChecksOn(back.builtin)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the CLI's own loader still reads a file that has policy keys", () => {
    const { dir, file } = withFile(
      "allow:\n  - Bash(ls)\nlevels:\n  tools: manual\nquestions:\n  delivery: wait\n",
    );
    try {
      expect(loadPermissionsYaml(file)).toMatchObject({ allow: ["Bash(ls)"] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
