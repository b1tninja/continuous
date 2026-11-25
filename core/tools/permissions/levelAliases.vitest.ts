import { describe, expect, it } from "vitest";

import type { TaskPlan } from "../..";
import { createLoop, restoreLoop } from "../../util/loopMode";
import { callRows } from "./audit/reader";
import { decisionEvent, resetSeq } from "./audit/auditIndexFixtures";
import {
  DEFAULT_POLICY_LEVELS,
  isDeprecatedLevelSpelling,
  modernizeLevelText,
  normalizePolicy,
  parsePolicyLevel,
  POLICY_LEVELS,
  POLICY_PRESETS,
  policyLevelLabel,
} from "./policy";
import { applyPolicyUpdate, parsePolicyFile } from "./settingsFile";

// `yolo` is what 2.14.x called the top level. It is read, never written.

describe("IDGAF is a preset, not a level", () => {
  it("is not in the list of levels, and neither is yolo", () => {
    expect(POLICY_LEVELS as readonly string[]).not.toContain("idgaf");
    expect(POLICY_LEVELS as readonly string[]).not.toContain("yolo");
  });

  it("every level has a plain label on every area", () => {
    for (const area of [
      "context",
      "tools",
      "edits",
      "plan",
      "questions",
    ] as const) {
      expect(policyLevelLabel(area, "permissive")).toBe("Permissive");
      expect(policyLevelLabel(area, "automatic")).toBe("Automatic");
    }
  });

  it("has one preset, named IDGAF", () => {
    expect(Object.keys(POLICY_PRESETS)).toContain("idgaf");
    expect(Object.keys(POLICY_PRESETS)).not.toContain("yolo");
    expect(POLICY_PRESETS.idgaf.label).toBe("IDGAF");
    // Questions is a delegated decision, not a safety check: the preset leaves it
    const { questions, ...areas } = POLICY_PRESETS.idgaf.levels;
    expect(Object.values(areas)).toEqual(Array(4).fill("permissive"));
    expect(questions).toBe(DEFAULT_POLICY_LEVELS.questions);
  });
});

describe("reading the old spelling", () => {
  it("maps yolo and idgaf, in any case, to permissive", () => {
    for (const word of ["yolo", "YOLO", " Yolo ", "idgaf", "IDGAF"]) {
      expect(parsePolicyLevel(word)).toBe("permissive");
    }
    expect(parsePolicyLevel("nope")).toBeUndefined();
    expect(parsePolicyLevel(3)).toBeUndefined();
    expect(isDeprecatedLevelSpelling("YOLO")).toBe(true);
    expect(isDeprecatedLevelSpelling("idgaf")).toBe(true);
  });

  it("normalizePolicy reads yolo as permissive without a problem", () => {
    const { policy, problems } = normalizePolicy({
      levels: { tools: "yolo", questions: "YOLO", plan: "Manual" },
    });
    expect(problems).toEqual([]);
    expect(policy.levels.tools).toBe("permissive");
    // Questions' old IDGAF meant "the agent decides everything": Delegate
    expect(policy.levels.questions).toBe("delegate");
    // an unknown word still falls back, with a notice
    expect(
      normalizePolicy({ levels: { tools: "bogus" } }).problems,
    ).toHaveLength(1);
    expect(policy.levels.context).toBe(DEFAULT_POLICY_LEVELS.context);
  });

  it("a saved yolo in permissions.yaml is Permissive, with no notice", () => {
    const r = parsePolicyFile(
      "levels:\n  tools: yolo\n  edits: YOLO\n  plan: manual\n  questions: idgaf\n",
    );
    expect(r.settings.levels.tools).toBe("permissive");
    expect(r.settings.levels.edits).toBe("permissive");
    expect(r.settings.levels.plan).toBe("manual");
    // Questions never had a check to switch off: it was "the agent decides"
    expect(r.settings.levels.questions).toBe("delegate");
    expect(r.notices.join("\n")).not.toMatch(/yolo|idgaf|session/i);
  });
});

describe("writing", () => {
  it("never writes yolo or idgaf to permissions.yaml: it writes the current level", () => {
    const text = applyPolicyUpdate("levels:\n  tools: manual\n", {
      levels: {
        ...DEFAULT_POLICY_LEVELS,
        tools: "idgaf" as never,
        plan: "yolo" as never,
        questions: "idgaf" as never,
      },
    });
    expect(text).not.toMatch(/yolo|idgaf/i);
    expect(text).toMatch(/tools: permissive/);
    expect(text).toMatch(/plan: permissive/);
    expect(text).toMatch(/questions: delegate/);
  });

  it("a loop saved with yolo is restored as Delegate, which is what its Questions IDGAF meant", () => {
    const plan: TaskPlan = {
      items: [{ id: "1", text: "A", status: "pending" }],
      updatedAt: "2026-11-08T10:00:00Z",
    };
    const loop = createLoop(plan, {
      now: new Date("2026-11-08T10:00:00Z"),
      sessionTokens: 0,
      policy: { plan: "permissive", questions: "delegate" },
    });
    const old = JSON.parse(JSON.stringify(loop));
    old.policy.questions = "yolo";
    const restored = restoreLoop(old)!;
    expect(restored.policy?.questions).toBe("delegate");
    expect(JSON.stringify(restored)).not.toMatch(/yolo/i);
  });
});

describe("audit entries written by 2.14.x", () => {
  it("keep their text on disk and read as idgaf", () => {
    resetSeq();
    const old = decisionEvent(
      "c1",
      "Bash",
      { command: "ls" },
      {
        policy: "allow",
        source: "yolo",
        reason: "Allowed: Tool use is set to YOLO.",
      },
    );
    const [row] = callRows([old]);
    expect(row.source).toBe("idgaf");
    expect(row.reason).toBe("Allowed: Tool use is set to IDGAF.");
    // the record itself is untouched
    expect(old.source).toBe("yolo");
    expect(modernizeLevelText("at YOLO and yolo; yoloish")).toBe(
      "at IDGAF and idgaf; yoloish",
    );
  });
});
