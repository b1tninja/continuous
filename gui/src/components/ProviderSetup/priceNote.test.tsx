import { screen } from "@testing-library/react";
import type { ProviderSetupInfo } from "core/config/providerSetup";
import { setOpenRouterCatalog } from "core/llm/utils/catalogPricing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { resetCatalogueAnswers } from "../../pages/AddNewModel/configs/fetchProviderModels";
import { renderWithProviders } from "../../util/test/render";
import { ProviderSetupFlow } from "./ProviderSetupFlow";

const SETUP: ProviderSetupInfo = {
  connections: [],
  secureStorageAvailable: true,
  preferredKeyStorage: "secure",
  editable: true,
};

describe("ProviderSetupFlow: prices from the downloaded list", () => {
  beforeEach(() => resetCatalogueAnswers());
  afterEach(() => setOpenRouterCatalog(undefined));

  it("shows the price and its date next to a model the list prices", async () => {
    const messenger = new MockIdeMessenger();
    messenger.responseHandlers["config/getProviderSetup"] = async () => SETUP;
    messenger.responseHandlers["modelCatalog/cached"] = async () => ({
      fetchedAt: "2026-11-01T00:00:00.000Z",
      models: [
        {
          id: "zz-test/priced",
          name: "ZZ Priced",
          supportsTools: true,
          pricing: { prompt: 0.000001, completion: 0.000002 },
        },
        {
          id: "zz-test/free:free",
          name: "ZZ Free",
          supportsTools: true,
          pricing: { prompt: 0, completion: 0 },
        },
        { id: "zz-test/unpriced", name: "ZZ Unpriced", supportsTools: true },
      ],
    });
    const { user } = await renderWithProviders(
      <ProviderSetupFlow initialProvider="openrouter" onDone={vi.fn()} />,
      { mockIdeMessenger: messenger },
    );
    await user.type(await screen.findByLabelText(/API key/i), "test-key");
    await user.click(screen.getByRole("button", { name: "Next" }));
    const priced = await screen.findByTestId("model-row-price-zz-test/priced");
    expect(priced.textContent).toBe(
      "$1 in / $2 out per MTok, prices as of 2026-11-01",
    );
    expect(
      screen.getByTestId("model-row-price-zz-test/free:free").textContent,
    ).toBe("free, prices as of 2026-11-01");
    expect(screen.queryByTestId("model-row-price-zz-test/unpriced")).toBeNull();
  });
});
