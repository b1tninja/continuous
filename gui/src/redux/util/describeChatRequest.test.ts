import budgets from "core/llm/promptSegmentBudgets.json";
import {
  CACHE_BREAKPOINTS,
  type CacheProvider,
  type PromptSegment,
  cacheOrderViolations,
  commonPrefixLength,
  firstChangedVsPrev,
  overBudget,
  staticHashes,
  validateManifest,
  visibleOffenders,
  volatileEarly,
} from "core/llm/promptSegments";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { buildChatRequest } from "./buildChatRequest";
import { describeChatRequest } from "./describeChatRequest";
import { renderChatMessage } from "core/util/messageContent";
import { CLAUDE, IDE_SCENARIOS, PLAN, ideState, msg } from "./segmentScenarios";

/**
 * C62 on the IDE: the manifests of the scenarios built with the real
 * builders. Ordering, per-segment budgets, static hash goldens and prefix
 * stability, with the known volatile-early offenders recorded as BASELINE
 * tests: they assert today's behaviour, so the PR that fixes one flips the
 * expectation deliberately.
 */

const GOLDEN_FILE = join(__dirname, "segmentGolden.json");
const manifests: Record<string, PromptSegment[]> = Object.fromEntries(
  Object.entries(IDE_SCENARIOS).map(([name, build]) => [
    name,
    describeChatRequest(build()),
  ]),
);

describe("IDE segment manifests", () => {
  for (const name of Object.keys(IDE_SCENARIOS)) {
    describe(name, () => {
      it("is in canonical order", () => {
        expect(validateManifest(manifests[name])).toEqual([]);
      });
      it("is within the per-segment token budgets", () => {
        expect(overBudget(manifests[name], budgets.ide)).toEqual([]);
      });
      it("puts stable segments before volatile ones at every breakpoint", () => {
        for (const p of Object.keys(CACHE_BREAKPOINTS) as CacheProvider[]) {
          expect(cacheOrderViolations(manifests[name], p)).toEqual([]);
        }
      });
    });
  }

  it("keeps the static segment hashes recorded in segmentGolden.json", () => {
    const actual = Object.fromEntries(
      Object.entries(manifests).map(([n, m]) => [n, staticHashes(m)]),
    );
    if (process.env.WRITE_GOLDEN) {
      writeFileSync(GOLDEN_FILE, JSON.stringify(actual, null, 2) + "\n");
    }
    const golden = existsSync(GOLDEN_FILE)
      ? JSON.parse(readFileSync(GOLDEN_FILE, "utf8"))
      : {};
    expect(actual).toEqual(golden);
  });

  it("a prompted-tools request has a format segment and no native tools", () => {
    const m = manifests["ide-agent-qwen-prompted"];
    expect(m.some((s) => s.source === "format")).toBe(true);
    expect(m.some((s) => s.region === "tools")).toBe(false);
  });

  it("negative control: a native tool list with a format segment fails", () => {
    const native = manifests["ide-agent-claude"];
    const prompted = manifests["ide-agent-qwen-prompted"];
    const bad = [native[0], ...prompted.filter((s) => s.source === "format")];
    expect(validateManifest(bad).map((v) => v.rule)).toContain(
      "format-with-native-tools",
    );
  });

  it("negative control: a volatile segment first fails", () => {
    const m = manifests["ide-agent-claude-tasklist"];
    const taskList = m.find((s) => s.id === "task-list")!;
    const bad = [
      m[0],
      { ...taskList, region: "system" as const },
      ...m.slice(1, 3),
    ];
    expect(validateManifest(bad).length).toBeGreaterThan(0);
  });
});

describe("IDE prefix stability (C62 a)", () => {
  const base = manifests["ide-agent-claude-tasklist"];

  it("a changed task list changes only the task-list segment", () => {
    const other = describeChatRequest(
      ideState({
        model: CLAUDE,
        taskPlan: {
          ...PLAN,
          items: [{ id: "1", text: "Something else", status: "pending" }],
        },
      }),
    );
    expect(commonPrefixLength(base, other)).toBe(base.length - 1);
    expect(firstChangedVsPrev(other, base)).toBe("none");
  });

  it("a new user message leaves tools and system untouched", () => {
    const longer = describeChatRequest(
      ideState({
        model: CLAUDE,
        taskPlan: PLAN,
        history: [
          msg("user", "Fix the bug in lexer.ts"),
          msg("assistant", "Looking at it."),
          msg("user", "Now add a test."),
          msg("assistant", "Done."),
          msg("user", "Thanks, one more thing."),
        ],
      }),
    );
    expect(firstChangedVsPrev(longer, base)).toBe("none");
    expect(commonPrefixLength(base, longer)).toBe(
      base.filter((s) => s.region === "tools" || s.region === "system").length,
    );
  });

  // The BASELINE tests below record the volatile-early offenders as they are.
  // Each is a prefix break the next slice is meant to remove.

  it("BASELINE offender: a first-time file-scoped rule is appended to the system message", () => {
    const withScoped = manifests["ide-agent-scoped-rule"];
    const without = manifests["ide-agent-claude"];
    expect(firstChangedVsPrev(withScoped, without)).toBe(
      "rules.scoped:ts-only",
    );
    expect(
      volatileEarly(withScoped)
        .filter((s) => s.stability === "turn")
        .map((s) => s.id),
    ).toEqual(["rules.scoped:ts-only"]);
  });

  it("BASELINE offender: a plan-to-act switch changes tools and system", () => {
    const plan = manifests["ide-plan-claude"];
    const agent = manifests["ide-agent-claude"];
    expect(commonPrefixLength(plan, agent)).toBe(0);
    expect(firstChangedVsPrev(agent, plan)).toBe("tools.builtin@agent");
  });

  it("BASELINE offender: task_list appearing changes the tool list", () => {
    expect(
      firstChangedVsPrev(
        manifests["ide-agent-claude-tasklist"],
        manifests["ide-agent-claude"],
      ),
    ).toBe("tools.builtin@agent");
  });

  it("a compaction summary is the first user message, after an unchanged system message (C104)", () => {
    const compacted = manifests["ide-compacted"];
    const before = manifests["ide-agent-claude"];
    // The tools and the system message are the same segments as before
    expect(firstChangedVsPrev(compacted, before)).toBe("summary.compaction");
    const summary = compacted.find((x) => x.id === "summary.compaction");
    expect(summary).toMatchObject({
      region: "first-user",
      stability: "session",
    });
    expect(summary?.exposedTo).toBeUndefined();
    const head = (xs: typeof before) =>
      xs.filter((x) => x.region === "tools" || x.region === "system");
    expect(head(compacted)).toEqual(head(before));
  });

  it("makes the plan's offenders visible per scenario", () => {
    const visible = (n: string) => visibleOffenders(manifests[n]).sort();
    expect(visible("ide-agent-claude")).toEqual(["mode-switch"]);
    expect(visible("ide-agent-claude-tasklist")).toEqual([
      "mode-switch",
      "tool-list-event",
    ]);
    expect(visible("ide-loop-item")).toEqual([
      "mode-switch",
      "tool-list-event",
    ]);
    expect(visible("ide-agent-scoped-rule")).toEqual([
      "mode-switch",
      "scoped-rule-appended",
    ]);
    expect(visible("ide-compacted")).toEqual(["mode-switch"]);
  });

  it("a scoped rule listed before a global one still comes after it (C62)", () => {
    const first = manifests["ide-agent-scoped-first"];
    expect(first.map((x) => x.id)).toEqual(
      manifests["ide-agent-scoped-rule"].map((x) => x.id),
    );
    // Only the order was fixed: the system message is exactly the one the
    // global-first listing builds, so no text was lost or added.
    const system = (name: string) =>
      renderChatMessage(buildChatRequest(IDE_SCENARIOS[name]()).messages[0]);
    expect(system("ide-agent-scoped-first")).toBe(
      system("ide-agent-scoped-rule"),
    );
  });
});
