import { describe, expect, it } from "vitest";
import {
  BUILT_IN_SUBAGENTS,
  DEFAULT_SUBAGENT_MAX_TURNS,
  EXPLORE_AGENT,
  parseSubagentFile,
} from "./definitions";

/**
 * The default is what a research agent gets unless it says otherwise. It was 30,
 * and deep research was cut off at it (6 of 16 runs in one machine's sessions).
 */
describe("the default subagent turn limit", () => {
  it("is 50 model calls", () => {
    expect(DEFAULT_SUBAGENT_MAX_TURNS).toBe(50);
  });

  it("is higher than the 30 that cut research off, and still bounded", () => {
    expect(DEFAULT_SUBAGENT_MAX_TURNS).toBeGreaterThan(30);
    expect(Number.isInteger(DEFAULT_SUBAGENT_MAX_TURNS)).toBe(true);
    expect(DEFAULT_SUBAGENT_MAX_TURNS).toBeLessThanOrEqual(100);
  });

  it("is what every built-in agent gets: none sets a lower limit of its own", () => {
    for (const agent of BUILT_IN_SUBAGENTS) {
      expect(agent.maxTurns, agent.name).toBeUndefined();
    }
    expect(EXPLORE_AGENT.maxTurns).toBeUndefined();
  });

  it("is overridden by a definition's own maxTurns, up or down", () => {
    const parse = (n: number) =>
      parseSubagentFile(
        `---\nname: a\ndescription: d\nmaxTurns: ${n}\n---\nbody`,
        "a.md",
        "workspace-continue",
      );
    expect(parse(5).maxTurns).toBe(5);
    expect(parse(200).maxTurns).toBe(200);
  });

  it("applies to a definition that does not set maxTurns", () => {
    const def = parseSubagentFile(
      "---\nname: a\ndescription: d\n---\nbody",
      "a.md",
      "workspace-continue",
    );
    expect(def.maxTurns).toBeUndefined();
    expect(def.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS).toBe(50);
  });

  it("still refuses a limit that is not a positive whole number", () => {
    for (const bad of [0, -3, 1.5]) {
      expect(() =>
        parseSubagentFile(
          `---\nname: a\ndescription: d\nmaxTurns: ${bad}\n---\nbody`,
          "a.md",
          "workspace-continue",
        ),
      ).toThrow(/maxTurns/);
    }
  });
});
