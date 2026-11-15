import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MockIdeMessenger } from "../../../context/MockIdeMessenger";
import { setupStore } from "../../../redux/store";
import { renderWithProviders } from "../../../util/test/render";
import { ModelRoleRow } from "./ModelRoleRow";

const opus = {
  title: "Opus 4.5",
  provider: "anthropic",
  underlyingProviderName: "anthropic",
  model: "claude-opus-4-5-20251101",
} as any;

const message =
  "claude-opus-4-5-20251101 may retire from 2026-11-24 (Anthropic's earliest date; no retirement is announced yet). Suggested replacement: claude-opus-5-5.";

async function setup(withNotice: boolean) {
  const ideMessenger = new MockIdeMessenger();
  ideMessenger.responseHandlers["model/retirementNotices"] = async (data) => ({
    notices: withNotice
      ? data.models.map((m) => ({
          ...m,
          notice: {
            model: m.model,
            severity: "possible",
            retiresAt: "2026-11-24",
            replacement: "claude-opus-5-5",
            from: "table",
            message,
            key: "k",
          },
        }))
      : [],
  });
  const store = setupStore({ ideMessenger });
  await renderWithProviders(
    <ModelRoleRow
      role="chat"
      displayName="Chat"
      description="Chat model"
      models={[opus]}
      selectedModel={opus}
      onSelect={() => {}}
      onConfigure={() => {}}
      setupURL=""
    />,
    { store, mockIdeMessenger: ideMessenger },
  );
}

describe("Settings > Models retirement line", () => {
  it("states what retires, when, and the successor under the role's model", async () => {
    await setup(true);
    const row = await screen.findByTestId("model-row-retirement-chat");
    expect(row.textContent).toBe(message);
  });

  it("is absent for a model with no notice", async () => {
    await setup(false);
    await waitFor(() =>
      expect(screen.queryByTestId("model-row-retirement-chat")).toBeNull(),
    );
  });
});
