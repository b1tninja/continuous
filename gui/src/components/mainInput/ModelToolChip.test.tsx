import { describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { EMPTY_CONFIG, updateConfig } from "../../redux/slices/configSlice";
import { setupStore } from "../../redux/store";
import { renderWithProviders } from "../../util/test/render";
import { chipText, ModelToolChip } from "./ModelToolChip";
import { act, screen } from "./noticeTestUtils";

async function setup(model: any, status: any) {
  const ideMessenger = new MockIdeMessenger();
  ideMessenger.responseHandlers["openaiCompat/probeStatus"] = async () =>
    status;
  const store = setupStore({ ideMessenger });
  await renderWithProviders(<ModelToolChip />, {
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
}

const lm = {
  title: "Qwen",
  provider: "lmstudio",
  model: "qwen3-coder",
  underlyingProviderName: "lmstudio",
};

describe("chipText", () => {
  it("is short and says the three states", () => {
    expect(chipText({ kind: "native" }, false)).toBe("tool calls: native");
    expect(chipText({ kind: "text" }, true)).toBe("as text: recovery on");
    expect(chipText({ kind: "text" }, false)).toBe("as text: recovery off");
    expect(chipText({ kind: "none" }, false)).toBe("tool calls: none");
    expect(chipText({ kind: "unknown" }, false)).toBe("unknown");
    expect(chipText(undefined, false)).toBe("unknown");
  });
});

describe("ModelToolChip", () => {
  it("shows the last local result with its date in the tooltip", async () => {
    await setup(lm, { kind: "native", n: 1, readOn: "2026-11-11" });
    const chip = await screen.findByText("tool calls: native");
    expect(chip.getAttribute("title")).toContain("2026-11-11");
    expect(chip.getAttribute("title")).toContain("1 probe");
  });

  it("says recovery is on when the model has a dialect set", async () => {
    await setup(
      { ...lm, toolDialect: "qwen-xml" },
      { kind: "text", n: 1, readOn: "2026-11-11" },
    );
    expect(await screen.findByText("as text: recovery on")).toBeTruthy();
  });

  it("says unknown before any test", async () => {
    await setup(lm, { kind: "unknown" });
    expect(await screen.findByText("unknown")).toBeTruthy();
  });

  it("is absent for a provider Test connection does not cover", async () => {
    await setup(
      { ...lm, provider: "anthropic", underlyingProviderName: "anthropic" },
      { kind: "unknown" },
    );
    expect(screen.queryByTestId("model-tool-chip")).toBeNull();
  });
});
