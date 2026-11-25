import { DEFAULT_POLICY_LEVELS } from "core/tools/permissions/policy";
import { builtinForPreset } from "core/tools/permissions/safetyDegrees";
import { describe, expect, it } from "vitest";
import {
  REVIEWER_NEEDED_MESSAGE,
  selectApprovalSettings,
  selectAutoApproval,
  selectEffectiveLevels,
  selectLoopPolicy,
  selectIdgafAreas,
} from "./selectAutoApproval";

const state = (over: {
  flag?: boolean;
  reviewer?: boolean;
  levels?: Partial<typeof DEFAULT_POLICY_LEVELS>;
  builtin?: Record<string, boolean>;
}) =>
  ({
    config: {
      config: {
        experimental: { enableAutoApproval: over.flag },
        selectedModelByRole: {
          chat: { title: "chat" },
          reviewer: over.reviewer ? { title: "r" } : null,
        },
      },
    },
    ui: {
      policyLevels: { ...DEFAULT_POLICY_LEVELS, ...over.levels },
      policyExtras: over.builtin ? { builtin: over.builtin } : {},
    },
  }) as any;

describe("selectAutoApproval", () => {
  it("is not offered unless the experimental setting is on", () => {
    expect(
      selectAutoApproval(
        state({ reviewer: true, levels: { tools: "automatic" } }),
      ),
    ).toMatchObject({ offered: false, available: false, active: false });
  });

  it("is unavailable until a reviewer model is chosen, even when an area is Automatic", () => {
    const s = selectAutoApproval(
      state({ flag: true, levels: { tools: "automatic" } }),
    );
    expect(s).toMatchObject({ offered: true, available: false, active: false });
    expect(s.unavailableReason).toBe(REVIEWER_NEEDED_MESSAGE);
  });

  it("is not active by default even when available", () => {
    expect(
      selectAutoApproval(state({ flag: true, reviewer: true })),
    ).toMatchObject({ available: true, active: false });
  });

  it("is active when a reviewable area is Automatic and a reviewer is set", () => {
    expect(
      selectAutoApproval(
        state({ flag: true, reviewer: true, levels: { tools: "automatic" } }),
      ).active,
    ).toBe(true);
  });

  it("is not active for Plan edits or Questions alone: no reviewer judges those yet", () => {
    expect(
      selectAutoApproval(
        state({ flag: true, reviewer: true, levels: { plan: "automatic" } }),
      ).active,
    ).toBe(false);
  });
});

describe("selectApprovalSettings", () => {
  it("sends one level per area", () => {
    expect(selectApprovalSettings(state({}))).toEqual({
      levels: DEFAULT_POLICY_LEVELS,
    });
    expect(
      selectApprovalSettings(state({ levels: { tools: "permissive" } })).levels
        .tools,
    ).toBe("permissive");
  });

  it("a saved Automatic that cannot run becomes Cautious, never looser", () => {
    const noReviewer = state({ flag: true, levels: { tools: "automatic" } });
    expect(selectEffectiveLevels(noReviewer).tools).toBe("cautious");
    const experimentOff = state({
      reviewer: true,
      levels: { context: "automatic" },
    });
    expect(selectEffectiveLevels(experimentOff).context).toBe("cautious");
  });

  it("Automatic is sent as automatic once usable, for a reviewable area", () => {
    const usable = state({
      flag: true,
      reviewer: true,
      levels: { tools: "automatic", plan: "automatic" },
    });
    const levels = selectApprovalSettings(usable).levels;
    expect(levels.tools).toBe("automatic");
    // No reviewer judges plans yet, so that area waits for the person
    expect(levels.plan).toBe("cautious");
  });
});

describe("the loop's policy and the IDGAF banner", () => {
  it("the loop follows Plan edits and Questions", () => {
    expect(
      selectLoopPolicy(
        state({ levels: { plan: "permissive", questions: "delegate" } }),
      ),
    ).toMatchObject({ plan: "permissive", questions: "delegate" });
  });

  it("the loop carries the re-plan switch only when it is off", () => {
    expect(selectLoopPolicy(state({}))).not.toHaveProperty("holdReplans");
    expect(
      selectLoopPolicy(state({ builtin: { "plan-keeps-checks": false } })),
    ).toMatchObject({ holdReplans: false });
  });

  it("the banner names every area while no check is on, and none otherwise", () => {
    expect(selectIdgafAreas(state({}))).toEqual([]);
    expect(
      selectIdgafAreas(state({ builtin: builtinForPreset("idgaf") })),
    ).toEqual(["context", "tools", "edits", "plan", "questions"]);
    // one check back on: it is no longer IDGAF
    expect(
      selectIdgafAreas(
        state({
          builtin: { ...builtinForPreset("idgaf"), "protect-secrets": true },
        }),
      ),
    ).toEqual([]);
  });

  it("the levels alone do not make the banner", () => {
    expect(
      selectIdgafAreas(
        state({ levels: { tools: "permissive", edits: "permissive" } }),
      ),
    ).toEqual([]);
  });
});
