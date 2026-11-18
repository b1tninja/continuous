import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { EMPTY_CONFIG, updateConfig } from "../../redux/slices/configSlice";
import { setupStore } from "../../redux/store";
import { renderWithProviders } from "../../util/test/render";
import ModelSelect from "./ModelSelect";

const model = (title: string, provider: string, id: string) =>
  ({
    title,
    model: id,
    provider,
    underlyingProviderName: provider,
    configurationStatus: "valid",
  }) as any;

const sonnetNotice = {
  model: "claude-sonnet-4-5-20250929",
  severity: "retiring",
  retiresAt: "2026-11-30",
  daysLeft: 16,
  replacement: "claude-sonnet-5-5",
  from: "table",
  sourceUrl:
    "https://platform.claude.com/docs/en/about-claude/model-deprecations",
  fetchedOn: "2026-11-11",
  message:
    "claude-sonnet-4-5-20250929 is deprecated and retires on 2026-11-30 (16 days). Suggested replacement: claude-sonnet-5-5.",
  key: "claude-sonnet-4-5-20250929@2026-11-30:retiring",
} as const;

async function setup(models: any[], asked: any[] = []) {
  const ideMessenger = new MockIdeMessenger();
  ideMessenger.responseHandlers["model/retirementNotices"] = async (data) => {
    asked.push(data);
    return {
      notices: data.models
        .filter((m) => m.model === sonnetNotice.model)
        .map((m) => ({ ...m, notice: sonnetNotice })),
    };
  };
  const store = setupStore({ ideMessenger });
  const view = await renderWithProviders(<ModelSelect />, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  await act(async () => {
    store.dispatch(
      updateConfig({
        ...EMPTY_CONFIG,
        modelsByRole: { ...EMPTY_CONFIG.modelsByRole, chat: models },
        selectedModelByRole: {
          ...EMPTY_CONFIG.selectedModelByRole,
          chat: models[0],
        },
      }),
    );
  });
  await view.user.click(screen.getByTestId("model-select-button"));
  return view;
}

describe("model picker retirement warning", () => {
  it("marks the retiring model with its date and the successor in the tooltip", async () => {
    await setup([
      model("Sonnet 4.5", "anthropic", "claude-sonnet-4-5-20250929"),
      model("Sonnet 5.5", "anthropic", "claude-sonnet-5-5"),
    ]);
    const label = await screen.findByTestId("model-option-retirement");
    expect(label.textContent).toBe("(retires 2026-11-30)");
    expect(label.getAttribute("title")).toContain("claude-sonnet-5-5");
    expect(label.getAttribute("title")).toContain("model-deprecations");
    // Only the retiring model is marked
    expect(screen.getAllByTestId("model-option-retirement")).toHaveLength(1);
  });

  it("asks once for the providers that have notices, and not for others", async () => {
    const asked: any[] = [];
    await setup(
      [
        model("Sonnet 4.5", "anthropic", "claude-sonnet-4-5-20250929"),
        model(
          "Sonnet 4.5 (Bedrock)",
          "bedrock",
          "anthropic.claude-sonnet-4-5-20250929-v1:0",
        ),
      ],
      asked,
    );
    await waitFor(() => expect(asked.length).toBeGreaterThan(0));
    expect(asked.at(-1).models).toEqual([
      { provider: "anthropic", model: "claude-sonnet-4-5-20250929" },
    ]);
  });

  it("shows nothing when no listed model has a notice", async () => {
    const asked: any[] = [];
    await setup([model("Sonnet 5.5", "anthropic", "claude-sonnet-5-5")], asked);
    await waitFor(() => expect(asked.length).toBeGreaterThan(0));
    expect(screen.queryByTestId("model-option-retirement")).toBeNull();
  });
});
