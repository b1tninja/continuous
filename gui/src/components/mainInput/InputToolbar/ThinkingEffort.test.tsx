import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../../context/MockIdeMessenger";
import { EMPTY_CONFIG, updateConfig } from "../../../redux/slices/configSlice";
import {
  setMode,
  setHasReasoningEnabled,
} from "../../../redux/slices/sessionSlice";
import { setReasoningSetting } from "../../../redux/slices/uiSlice";
import { setupStore } from "../../../redux/store";
import { renderWithProviders } from "../../../util/test/render";
import InputToolbar from "../InputToolbar";

const claude = {
  title: "Claude Opus",
  model: "claude-opus-4-1",
  provider: "anthropic",
  underlyingProviderName: "anthropic",
};

const plain = {
  title: "GPT-4",
  model: "gpt-4",
  provider: "openai",
  underlyingProviderName: "openai",
};

async function renderToolbar(model: typeof claude | typeof plain) {
  const ideMessenger = new MockIdeMessenger();
  const calls: unknown[] = [];
  // The startup config load would replace the toolbar's config and the
  // reasoning flag. Leave it pending so the test owns both.
  ideMessenger.responseHandlers["config/getSerializedProfileInfo"] = () =>
    new Promise(() => {});
  ideMessenger.responseHandlers["config/setModeModels"] = async (data) => {
    calls.push(data);
    return { saved: true };
  };
  const store = setupStore({ ideMessenger });
  const view = await renderWithProviders(
    <InputToolbar activeKey={null} onEnter={() => {}} isMainInput />,
    { store, mockIdeMessenger: ideMessenger },
  );
  await act(async () => {
    store.dispatch(
      updateConfig({
        ...EMPTY_CONFIG,
        selectedModelByRole: {
          ...EMPTY_CONFIG.selectedModelByRole,
          chat: model,
        },
        modelsByRole: {
          ...EMPTY_CONFIG.modelsByRole,
          chat: [model],
        },
      }),
    );
  });
  return { ...view, store, calls };
}

describe("the Thinking menu's choice for no effort", () => {
  const labels = () =>
    Array.from(
      (screen.getByTestId("thinking-effort") as HTMLSelectElement).options,
    ).map((o) => o.textContent);

  it("says what the model's own setting sends, never Default", async () => {
    const { store } = await renderToolbar(claude);
    // A reasoning model with the 2,048 token budget reasons at medium. The
    // toolbar measures as narrow here, where the label is the level alone
    // ("Model setting (medium)" with room: modeNotSet.test.ts)
    expect(labels()).toEqual(["(med)", "Off", "Low", "Medium", "High"]);

    // The bulb turned reasoning off for the session
    await act(async () => {
      store.dispatch(setHasReasoningEnabled(false));
    });
    expect(labels()[0]).toBe("(off)");
  });

  it("follows the model's own budget", async () => {
    await renderToolbar({
      ...claude,
      completionOptions: { reasoningBudgetTokens: 16_000 },
    } as typeof claude);
    expect(labels()[0]).toBe("(high)");
  });
});

describe("Thinking effort in the chat toolbar", () => {
  it("hides the menu when the model has no thinking setting", async () => {
    await renderToolbar(plain);
    expect(screen.queryByTestId("thinking-effort")).toBeNull();
    expect(screen.queryByLabelText("Thinking")).toBeNull();
  });

  it("shows the current mode's effort and writes that field", async () => {
    const { user, calls, store } = await renderToolbar(claude);
    await act(async () => {
      store.dispatch(
        updateConfig({
          ...store.getState().config.config,
          modeModels: {
            agent: { title: "Claude Opus", reasoningEffort: "high" },
          },
        }),
      );
      store.dispatch(setHasReasoningEnabled(true));
      store.dispatch(
        setReasoningSetting({ modelTitle: claude.title, enabled: true }),
      );
    });

    const select = screen.getByLabelText("Thinking") as HTMLSelectElement;
    expect(select.value).toBe("high");
    expect(
      select.compareDocumentPosition(screen.getByTestId("model-select-button")),
    ).toBe(Node.DOCUMENT_POSITION_PRECEDING);

    await user.selectOptions(select, "low");
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ agent: { reasoningEffort: "low" } });
    expect(select.value).toBe("low");
    expect(store.getState().session.hasReasoningEnabled).toBeUndefined();
    expect(store.getState().ui.reasoningSettings[claude.title]).toBeUndefined();
    expect(
      store.getState().config.config.modeModels?.agent?.reasoningEffort,
    ).toBe("low");
  });

  it("writes the plan entry, with the model name when the mode has none", async () => {
    const { user, calls, store } = await renderToolbar(claude);
    await act(async () => {
      store.dispatch(setMode("plan"));
    });
    await user.selectOptions(screen.getByLabelText("Thinking"), "medium");
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      plan: { model: "Claude Opus", reasoningEffort: "medium" },
    });
  });

  it("clears the effort the same way the mode table does", async () => {
    const { user, calls, store } = await renderToolbar(claude);
    await act(async () => {
      store.dispatch(
        updateConfig({
          ...store.getState().config.config,
          modeModels: {
            agent: { title: "Claude Opus", reasoningEffort: "low" },
          },
        }),
      );
    });
    await user.selectOptions(screen.getByLabelText("Thinking"), "");
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ agent: { reasoningEffort: null } });
    expect(
      store.getState().config.config.modeModels?.agent?.reasoningEffort,
    ).toBeUndefined();
  });
});
