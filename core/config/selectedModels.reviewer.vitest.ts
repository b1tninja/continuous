import { describe, expect, it, vi } from "vitest";
import type { ContinueConfig, ILLM } from "..";

/**
 * Which config a role's model comes from. The model for a role is picked from
 * the models of the config that is active, by title. A title saved from another
 * config (the same profile id used to name a Bedrock config) never brings a
 * model in: it is only a preference among the active config's own models.
 */
const saved = vi.hoisted(() => ({
  value: undefined as Record<string, Record<string, string | null>> | undefined,
  writes: [] as unknown[],
}));

vi.mock("../util/GlobalContext", () => ({
  GlobalContext: class {
    get() {
      return saved.value;
    }
    update(_key: string, value: unknown) {
      saved.writes.push(value);
    }
  },
}));

import { rectifySelectedModelsFromGlobalContext } from "./selectedModels";

const llm = (title: string): ILLM =>
  ({
    title,
    model: title,
    getConfigurationStatus: () => "valid",
  }) as unknown as ILLM;

const ROLES = [
  "chat",
  "edit",
  "apply",
  "summarize",
  "autocomplete",
  "embed",
  "rerank",
  "reviewer",
  "subagent",
] as const;

function config(
  byRole: Partial<Record<(typeof ROLES)[number], ILLM[]>>,
  modeModels?: unknown,
) {
  const modelsByRole = Object.fromEntries(
    ROLES.map((r) => [r, byRole[r] ?? []]),
  );
  const selectedModelByRole = Object.fromEntries(ROLES.map((r) => [r, null]));
  return {
    modelsByRole,
    selectedModelByRole,
    modeModels,
  } as unknown as ContinueConfig;
}

const BEDROCK = "Claude Fable 5.1 (Bedrock)";

describe("the reviewer is chosen from the active config only", () => {
  it("a Bedrock reviewer saved for this profile is ignored when the active config has none", () => {
    saved.value = { local: { reviewer: BEDROCK, chat: "Strata act" } };
    const strata = llm("Strata act");
    const out = rectifySelectedModelsFromGlobalContext(
      config({ chat: [strata] }),
      "local",
    );
    expect(out.selectedModelByRole.reviewer).toBeNull();
    expect(out.selectedModelByRole.chat?.title).toBe("Strata act");
  });

  it("the saved selection is rewritten without the Bedrock title", () => {
    saved.value = { local: { reviewer: BEDROCK, chat: "Strata act" } };
    saved.writes.length = 0;
    rectifySelectedModelsFromGlobalContext(
      config({ chat: [llm("Strata act")] }),
      "local",
    );
    const written = JSON.stringify(saved.writes);
    expect(written).not.toContain("Bedrock");
  });

  it("with a reviewer of its own, the active config's model is chosen, not the saved Bedrock title", () => {
    saved.value = { local: { reviewer: BEDROCK } };
    const local = llm("Strata reviewer");
    const out = rectifySelectedModelsFromGlobalContext(
      config({ chat: [llm("Strata act")], reviewer: [local] }),
      "local",
    );
    expect(out.selectedModelByRole.reviewer).toBe(local);
  });

  it("no model becomes a reviewer when none of the active config's models lists the role", () => {
    saved.value = undefined;
    const out = rectifySelectedModelsFromGlobalContext(
      config({ chat: [llm("Strata act")], edit: [llm("Strata act")] }),
      "local",
    );
    expect(out.selectedModelByRole.reviewer).toBeNull();
  });

  it("the same holds for the other roles: a title that is not in the active config picks nothing from elsewhere", () => {
    saved.value = {
      local: { chat: BEDROCK, edit: BEDROCK },
    };
    const strata = llm("Strata act");
    const out = rectifySelectedModelsFromGlobalContext(
      config({ chat: [strata], edit: [strata] }),
      "local",
    );
    for (const role of ["chat", "edit"] as const) {
      expect(out.selectedModelByRole[role]?.title, role).toBe("Strata act");
    }
  });
});
