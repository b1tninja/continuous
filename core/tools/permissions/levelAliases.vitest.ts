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

describe("the top level is IDGAF everywhere", () => {
  it("is one level with one label on every area", () => {
    expect(POLICY_LEVELS[POLICY_LEVELS.length - 1]).toBe("idgaf");
    expect(POLICY_LEVELS as readonly string[]).not.toContain("yolo");
    for (const area of [
      "context",
      "tools",
      "edits",
      "plan",
      "questions",
    ] as const) {
      expect(policyLevelLabel(area, "idgaf")).toBe("IDGAF");
    }
  });

  it("has one preset, named IDGAF", () => {
    expect(Object.keys(POLICY_PRESETS)).toContain("idgaf");
    expect(Object.keys(POLICY_PRESETS)).not.toContain("yolo");
    expect(POLICY_PRESETS.idgaf.label).toBe("IDGAF");
    expect(POLICY_PRESETS.idgaf.description).toBe(
      "Everything runs and nothing asks. Every rule is ignored, locked rules included.",
    );
    expect(Object.values(POLICY_PRESETS.idgaf.levels)).toEqual(
      Array(5).fill("idgaf"),
    );
  });
});

describe("reading the old spelling", () => {
  it("maps yolo, in any case, to idgaf", () => {
    for (const word of ["yolo", "YOLO", " Yolo ", "idgaf", "IDGAF"]) {
      expect(parsePolicyLevel(word)).toBe("idgaf");
    }
    expect(parsePolicyLevel("nope")).toBeUndefined();
    expect(parsePolicyLevel(3)).toBeUndefined();
    expect(isDeprecatedLevelSpelling("YOLO")).toBe(true);
    expect(isDeprecatedLevelSpelling("idgaf")).toBe(false);
  });

  it("normalizePolicy reads yolo as idgaf without a problem", () => {
    const { policy, problems } = normalizePolicy({
      levels: { tools: "yolo", questions: "YOLO", plan: "Manual" },
    });
    expect(problems).toEqual([]);
    expect(policy.levels.tools).toBe("idgaf");
    expect(policy.levels.questions).toBe("idgaf");
    // an unknown word still falls back, with a notice
    expect(
      normalizePolicy({ levels: { tools: "bogus" } }).problems,
    ).toHaveLength(1);
    expect(policy.levels.context).toBe(DEFAULT_POLICY_LEVELS.context);
  });

  it("a saved yolo in permissions.yaml is session-only, as idgaf is", () => {
    const r = parsePolicyFile(
      "levels:\n  tools: yolo\n  edits: YOLO\n  plan: manual\n",
    );
    expect(r.settings.levels.tools).toBe(DEFAULT_POLICY_LEVELS.tools);
    expect(r.settings.levels.edits).toBe(DEFAULT_POLICY_LEVELS.edits);
    expect(r.settings.levels.plan).toBe("manual");
    expect(r.notices.join("\n")).toContain(
      "levels.tools: idgaf is for one session",
    );
    expect(r.notices.join("\n")).not.toMatch(/yolo/i);
  });
});

describe("writing", () => {
  it("never writes yolo or idgaf to permissions.yaml", () => {
    const text = applyPolicyUpdate("levels:\n  tools: manual\n", {
      levels: { ...DEFAULT_POLICY_LEVELS, tools: "idgaf", plan: "idgaf" },
    });
    expect(text).not.toMatch(/yolo/i);
    expect(text).not.toContain("idgaf");
  });

  it("a loop saved with yolo is restored with idgaf", () => {
    const plan: TaskPlan = {
      items: [{ id: "1", text: "A", status: "pending" }],
      updatedAt: "2026-11-08T10:00:00Z",
    };
    const loop = createLoop(plan, {
      now: new Date("2026-11-08T10:00:00Z"),
      sessionTokens: 0,
      policy: { plan: "permissive", questions: "idgaf" },
    });
    const old = JSON.parse(JSON.stringify(loop));
    old.policy.questions = "yolo";
    const restored = restoreLoop(old)!;
    expect(restored.policy?.questions).toBe("idgaf");
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
