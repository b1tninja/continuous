import { describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { EMPTY_CONFIG, updateConfig } from "../../redux/slices/configSlice";
import { setupStore } from "../../redux/store";
import { renderWithProviders } from "../../util/test/render";
import { ModelRetirementChip, retirementChipText } from "./ModelRetirementChip";
import { fireEvent } from "@testing-library/react";
import { act, screen } from "./noticeTestUtils";

const notice = {
  model: "claude-sonnet-4-5-20250929",
  severity: "retiring",
  retiresAt: "2026-11-30",
  daysLeft: 19,
  from: "table",
  sourceUrl:
    "https://platform.claude.com/docs/en/about-claude/model-deprecations",
  fetchedOn: "2026-11-11",
  message:
    "claude-sonnet-4-5-20250929 is deprecated and retires on 2026-11-30 (19 days). Suggested replacement: claude-sonnet-5-5.",
  key: "k",
} as const;

async function setup(
  model: any,
  content: any,
  calls: any[] = [],
  asked: any[] = [],
) {
  const ideMessenger = new MockIdeMessenger();
  ideMessenger.responseHandlers["model/retirementNotice"] = async (data) => {
    asked.push(data);
    return typeof content === "function" ? content() : content;
  };
  ideMessenger.responseHandlers["model/dismissRetirementNotice"] = async (
    data,
  ) => {
    calls.push(data);
  };
  const store = setupStore({ ideMessenger });
  await renderWithProviders(<ModelRetirementChip />, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  await act(async () => {
    store.dispatch(
      updateConfig({
        ...EMPTY_CONFIG,
        selectedModelByRole: {
          ...EMPTY_CONFIG.selectedModelByRole,
          chat: model,
        },
        modelsByRole: { ...EMPTY_CONFIG.modelsByRole, chat: [model] },
      } as any),
    );
  });
  return ideMessenger;
}

const sonnet = {
  title: "Sonnet",
  provider: "anthropic",
  model: "claude-sonnet-4-5-20250929",
  underlyingProviderName: "anthropic",
};

describe("retirementChipText", () => {
  it("is short and carries the date", () => {
    expect(retirementChipText(notice as any)).toBe("retires 2026-11-30");
    expect(retirementChipText({ ...notice, severity: "retired" } as any)).toBe(
      "retired",
    );
    expect(retirementChipText({ ...notice, severity: "possible" } as any)).toBe(
      "may retire 2026-11-30",
    );
    expect(
      retirementChipText({ ...notice, severity: "deprecated" } as any),
    ).toBe("deprecated");
  });
});

describe("ModelRetirementChip", () => {
  it("shows the date, with the message and source in the tooltip", async () => {
    await setup(sonnet, { notice });
    const chip = await screen.findByText("retires 2026-11-30");
    expect(chip.getAttribute("title")).toContain("claude-sonnet-5-5");
    expect(chip.getAttribute("title")).toContain("model-deprecations");
  });

  it("hides when clicked and tells core to remember", async () => {
    const calls: any[] = [];
    await setup(sonnet, { notice }, calls);
    fireEvent.click(await screen.findByText("retires 2026-11-30"));
    expect(screen.queryByText("retires 2026-11-30")).toBeNull();
    expect(calls).toEqual([
      { provider: "anthropic", model: "claude-sonnet-4-5-20250929" },
    ]);
  });

  it("shows nothing when core has no notice, or for another provider", async () => {
    await setup(sonnet, {});
    expect(screen.queryByTestId("model-retirement-chip")).toBeNull();
  });

  it("does not ask for a model on another provider", async () => {
    const asked: any[] = [];
    await setup(
      { ...sonnet, provider: "mistral", model: "m" },
      { notice },
      [],
      asked,
    );
    expect(screen.queryByTestId("model-retirement-chip")).toBeNull();
    expect(asked).toEqual([]);
  });

  it("shows an OpenAI model's shutdown date", async () => {
    await setup(
      { ...sonnet, provider: "openai", model: "gpt-4.1" },
      {
        notice: {
          ...notice,
          model: "gpt-4.1",
          retiresAt: "2027-02-14",
          from: "live",
        },
      },
    );
    expect(await screen.findByText("retires 2027-02-14")).toBeTruthy();
  });

  it("asks again when the background refresh updated the selected model", async () => {
    const asked: any[] = [];
    let answer: any = {};
    const messenger = await setup(sonnet, () => answer, [], asked);
    expect(screen.queryByTestId("model-retirement-chip")).toBeNull();
    answer = { notice };
    await act(async () => {
      messenger.mockMessageToWebview("model/infoUpdated", {
        provider: "anthropic",
        model: "claude-sonnet-4-5-20250929",
      });
    });
    expect(await screen.findByText("retires 2026-11-30")).toBeTruthy();
    expect(asked.length).toBeGreaterThanOrEqual(2);
  });
});
