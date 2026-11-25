import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY_LEVELS,
  levelRank,
  levelsOfArea,
  normalizePolicy,
  parsePolicyLevel,
  parseWebLevel,
  POLICY_AREAS,
  POLICY_LEVELS,
  POLICY_PRESETS,
  questionDecider,
  questionsAutoAnswer,
  questionsNeverAsk,
  type PolicyLevel,
  type PolicySettings,
} from "./policy";

/**
 * Delegate is the Questions level where the agent makes every decision for you.
 * That is decision making, not review, so it is not Automatic: Automatic is the
 * reviewer, on every area, and is a different decider rather than a looser one.
 */
const settings = (
  questions: PolicyLevel,
  youDecide?: ("irreversible" | "detail")[],
): PolicySettings => ({
  levels: { ...DEFAULT_POLICY_LEVELS, questions },
  ...(youDecide ? { questions: { youDecide } } : {}),
});

describe("which areas offer which levels", () => {
  it("Questions offers Delegate and no other area does", () => {
    expect(levelsOfArea("questions")).toContain("delegate");
    for (const area of POLICY_AREAS.filter((a) => a !== "questions")) {
      expect(levelsOfArea(area), area).not.toContain("delegate");
    }
  });

  it("every area offers the four shared levels, in the list's order", () => {
    for (const area of POLICY_AREAS) {
      const shared = levelsOfArea(area).filter((l) => l !== "delegate");
      expect(shared, area).toEqual([
        "manual",
        "cautious",
        "permissive",
        "automatic",
      ]);
    }
  });

  it("Delegate is last, after Automatic: it is not a step along the review road", () => {
    expect(POLICY_LEVELS[POLICY_LEVELS.length - 1]).toBe("delegate");
    expect(POLICY_LEVELS.indexOf("automatic")).toBeLessThan(
      POLICY_LEVELS.indexOf("delegate"),
    );
  });
});

describe("rank: Automatic does not loosen Permissive, Delegate does", () => {
  it("Permissive and Automatic rank the same, so neither raises the other", () => {
    expect(levelRank("permissive")).toBe(levelRank("automatic"));
  });

  it("Delegate ranks above both, because fewer questions reach you", () => {
    expect(levelRank("delegate")).toBeGreaterThan(levelRank("permissive"));
    expect(levelRank("delegate")).toBeGreaterThan(levelRank("automatic"));
  });

  it("a retired spelling ranks as the level it is read as", () => {
    expect(levelRank("idgaf")).toBe(levelRank("permissive"));
    expect(levelRank("yolo")).toBe(levelRank("permissive"));
  });

  it("text that is not a level ranks -1", () => {
    expect(levelRank("nope")).toBe(-1);
    expect(levelRank(undefined)).toBe(-1);
    expect(levelRank("")).toBe(-1);
    // not an own property: no accident of the prototype chain
    expect(levelRank("constructor")).toBe(-1);
    expect(levelRank("toString")).toBe(-1);
  });
});

describe("who answers a question", () => {
  it("Delegate: the agent decides every type, whatever the lists say", () => {
    const own = settings("delegate", ["irreversible", "detail"]);
    for (const type of [
      "scope",
      "irreversible",
      "security",
      "cost",
      "detail",
      undefined,
      "made up",
    ]) {
      expect(questionDecider(own, type), String(type)).toBe("agent");
    }
  });

  it("Automatic is review and no question reviewer exists: it works as Permissive", () => {
    const own = settings("automatic", ["irreversible"]);
    expect(questionDecider(own, "irreversible")).toBe("person");
    expect(questionDecider(own, "detail")).toBe("agent");
    // not delegation: a type on your own list still reaches you
    expect(questionDecider(own, "irreversible")).not.toBe("agent");
  });

  it("only Delegate never asks", () => {
    for (const level of POLICY_LEVELS) {
      expect(questionsNeverAsk(level), level).toBe(level === "delegate");
    }
    expect(questionsNeverAsk(undefined)).toBe(false);
  });

  it("a loop may answer for the agent at Permissive, Automatic and Delegate only", () => {
    for (const level of POLICY_LEVELS) {
      expect(questionsAutoAnswer(level), level).toBe(
        level === "permissive" || level === "automatic" || level === "delegate",
      );
    }
  });
});

describe("the retired top level", () => {
  it("reads as Permissive on a tool area", () => {
    for (const word of ["idgaf", "IDGAF", " yolo ", "Yolo"]) {
      expect(parsePolicyLevel(word), word).toBe("permissive");
    }
  });

  it("reads as Delegate on Questions, which is what it meant there", () => {
    for (const word of ["idgaf", "yolo", "IDGAF"]) {
      const { policy, problems } = normalizePolicy({
        levels: { questions: word },
      });
      expect(problems, word).toEqual([]);
      expect(policy.levels.questions, word).toBe("delegate");
    }
  });

  it("is Permissive on every other area, with no problem reported", () => {
    const { policy, problems } = normalizePolicy({
      levels: {
        context: "idgaf",
        tools: "yolo",
        edits: "IDGAF",
        plan: "idgaf",
      },
    });
    expect(problems).toEqual([]);
    expect(policy.levels).toMatchObject({
      context: "permissive",
      tools: "permissive",
      edits: "permissive",
      plan: "permissive",
    });
  });
});

describe("Delegate is valid on Questions only", () => {
  it("is refused on another area, with the reason, and the default applies", () => {
    for (const area of ["context", "tools", "edits", "plan"] as const) {
      const { policy, problems } = normalizePolicy({
        levels: { [area]: "delegate" },
      });
      expect(problems, area).toEqual([
        `${area}: "delegate" is a Questions level only`,
      ]);
      expect(policy.levels[area], area).toBe(DEFAULT_POLICY_LEVELS[area]);
    }
  });

  it("is read on Questions", () => {
    const { policy, problems } = normalizePolicy({
      levels: { questions: "delegate" },
    });
    expect(problems).toEqual([]);
    expect(policy.levels.questions).toBe("delegate");
  });

  it("is not a Web level, which follows the other areas' levels", () => {
    expect(parseWebLevel("delegate")).toBeUndefined();
    expect(parseWebLevel("automatic")).toBe("automatic");
    expect(parseWebLevel("off")).toBe("off");
  });

  it("an unknown word is still a problem, not Delegate", () => {
    const { problems } = normalizePolicy({
      levels: { questions: "everything" },
    });
    expect(problems).toHaveLength(1);
  });
});

describe("the IDGAF preset leaves Questions alone", () => {
  it("sets Questions to the default, not Delegate and not Automatic", () => {
    expect(POLICY_PRESETS.idgaf.levels.questions).toBe(
      DEFAULT_POLICY_LEVELS.questions,
    );
    expect(POLICY_PRESETS.idgaf.levels.questions).not.toBe("delegate");
    expect(POLICY_PRESETS.idgaf.levels.questions).not.toBe("automatic");
  });

  it("sets Permissive on the four other areas", () => {
    const { questions: _q, ...rest } = POLICY_PRESETS.idgaf.levels;
    expect(Object.values(rest)).toEqual([
      "permissive",
      "permissive",
      "permissive",
      "permissive",
    ]);
  });
});
