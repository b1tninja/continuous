import * as fs from "fs";
import * as path from "path";

import {
  CACHE_BREAKPOINTS,
  type CacheProvider,
  type PromptSegment,
  cacheOrderViolations,
  type SegmentBudgets,
  commonPrefixLength,
  firstChangedVsPrev,
  overBudget,
  staticHashes,
  validateManifest,
  visibleOffenders,
} from "core/llm/promptSegments.js";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { describeCliRequest } from "./promptSegments.js";
import {
  SCENARIO_DIR,
  SCENARIOS,
  buildCliScenario,
  enterScenarioDir,
  type CliScenarioSpec,
} from "./stream/segmentScenarios.js";

vi.mock("./services/ServiceContainer.js", () => ({
  serviceContainer: {
    get: vi.fn(async () => ({ config: { rules: [] } })),
    getSync: vi.fn(() => ({ value: undefined })),
    on: vi.fn(),
    off: vi.fn(),
  },
}));

/**
 * C62 on the CLI: the manifests of the scenarios built with the real
 * `constructSystemMessage`, tool definitions and `buildChatRequestBody`.
 * BASELINE tests record the volatile-early offenders as they are today.
 */

// The budgets file lives in core, shared with the IDE tests.
const budgets: { cli: SegmentBudgets } = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../../../core/llm/promptSegmentBudgets.json"),
    "utf8",
  ),
);
const GOLDEN_FILE = path.join(__dirname, "promptSegmentGolden.json");

async function manifest(spec: CliScenarioSpec): Promise<PromptSegment[]> {
  const r = await buildCliScenario(spec);
  return describeCliRequest({
    systemMessage: r.systemMessage,
    tools: r.tools,
    environmentBlock: r.environmentBlock,
    taskListBlock: spec.taskListBlock,
    turnTail: spec.turnTail,
    history: spec.taskListBlock ? r.messages.slice(1, -1) : r.messages.slice(1),
    subagentPrompt: spec.subagentPrompt,
  });
}

const manifests: Record<string, PromptSegment[]> = {};
beforeAll(async () => {
  enterScenarioDir();
  for (const [name, spec] of Object.entries(SCENARIOS)) {
    manifests[name] = await manifest(spec);
  }
});

describe("CLI segment manifests", () => {
  for (const name of Object.keys(SCENARIOS)) {
    describe(name, () => {
      it("is in canonical order", () => {
        expect(validateManifest(manifests[name]).map((v) => v.message)).toEqual(
          [],
        );
      });
      it("puts stable segments before volatile ones at every breakpoint", () => {
        for (const p of Object.keys(CACHE_BREAKPOINTS) as CacheProvider[]) {
          expect(cacheOrderViolations(manifests[name], p)).toEqual([]);
        }
      });
      it("is within the per-segment token budgets", () => {
        expect(overBudget(manifests[name], budgets.cli)).toEqual([]);
      });
    });
  }

  it("keeps the static segment hashes recorded in promptSegmentGolden.json", () => {
    const actual = Object.fromEntries(
      Object.entries(manifests).map(([n, m]) => [n, staticHashes(m)]),
    );
    if (process.env.WRITE_GOLDEN) {
      fs.writeFileSync(GOLDEN_FILE, JSON.stringify(actual, null, 2) + "\n");
    }
    const golden = fs.existsSync(GOLDEN_FILE)
      ? JSON.parse(fs.readFileSync(GOLDEN_FILE, "utf8"))
      : {};
    expect(actual).toEqual(golden);
  });

  it("negative control: a volatile segment placed first fails", () => {
    const m = manifests["cli-agent"];
    const env = m.find((s) => s.id === "env.date+git")!;
    const bad = [{ ...env, region: "system" as const }, ...m.slice(0, 3)];
    expect(validateManifest(bad).length).toBeGreaterThan(0);
  });
});

describe("CLI prefix stability (C62 a)", () => {
  it("a changed task list changes only the task-list segment", async () => {
    const base = manifests["cli-agent"];
    const other = await manifest({
      ...SCENARIOS["cli-agent"],
      taskListBlock: "<task_list>\n[x] 1. Add a test\n</task_list>",
    });
    expect(commonPrefixLength(base, other)).toBe(base.length - 1);
  });

  it("a turn tail is a tail segment and leaves the prefix alone", async () => {
    const base = manifests["cli-agent"];
    const tailed = await manifest({
      ...SCENARIOS["cli-agent"],
      turnTail: "Keep going.",
    });
    expect(tailed.some((s) => s.id === "tail.turn")).toBe(true);
    expect(firstChangedVsPrev(tailed, base)).toBe("none");
  });

  it("a different day changes only the environment segment (resume)", () => {
    expect(
      firstChangedVsPrev(manifests["cli-resume"], manifests["cli-agent-plain"]),
    ).toBe("env.date+git");
  });

  it("a compaction request starts with the same prefix as the request before it", () => {
    const before = manifests["cli-agent-plain"];
    const compaction = manifests["cli-compaction"];
    expect(firstChangedVsPrev(compaction, before)).toBe("none");
  });

  // BASELINE tests: each records an offender as it is today.

  it("BASELINE offender: MCP tools are in connection order", async () => {
    const base = manifests["cli-agent"];
    const reordered = await manifest({
      ...SCENARIOS["cli-agent"],
      mcp: ["mcp__c__list", "mcp__a__search", "mcp__b__fetch"],
    });
    expect(firstChangedVsPrev(reordered, base)).toBe("tools.mcp");
  });

  it("BASELINE offender: editing AGENTS.md rewrites the rules segment", async () => {
    const base = manifests["cli-agent"];
    const file = path.join(SCENARIO_DIR, "AGENTS.md");
    const original = fs.readFileSync(file, "utf8");
    try {
      fs.writeFileSync(file, original + "A new note the agent wrote.\n");
      const edited = await manifest(SCENARIOS["cli-agent"]);
      expect(firstChangedVsPrev(edited, base)).toBe("rules.user");
    } finally {
      fs.writeFileSync(file, original);
    }
  });

  it("BASELINE offender: a plan-to-act switch changes tools and system", () => {
    expect(
      commonPrefixLength(manifests["cli-plan"], manifests["cli-agent"]),
    ).toBe(0);
  });

  it("BASELINE offender: task list and MCP tool order are tool-list events", () => {
    expect(visibleOffenders(manifests["cli-agent"]).sort()).toEqual([
      "instruction-file-edit",
      "mcp-order",
      "mode-switch",
      "tool-list-event",
    ]);
    expect(visibleOffenders(manifests["cli-plan"]).sort()).toEqual([
      "instruction-file-edit",
      "mode-switch",
    ]);
  });
});
