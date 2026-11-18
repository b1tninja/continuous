import { renderHook, waitFor } from "@testing-library/react";
import {
  getCommunityCatalog,
  setCommunityCatalog,
} from "core/llm/utils/communityPricing";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { IdeMessengerContext } from "../context/IdeMessenger";
import { MockIdeMessenger } from "../context/MockIdeMessenger";
import { useOpenRouterPrices } from "./useOpenRouterPrices";

function withMessenger(messenger: MockIdeMessenger) {
  return ({ children }: { children: React.ReactNode }) => (
    <IdeMessengerContext.Provider value={messenger}>
      {children}
    </IdeMessengerContext.Provider>
  );
}

describe("useOpenRouterPrices: the community catalogue", () => {
  afterEach(() => setCommunityCatalog(undefined));

  it("takes the copy core reads from disk", async () => {
    const messenger = new MockIdeMessenger();
    messenger.responseHandlers["modelCatalog/communityCached"] = async () => ({
      fetchedAt: "2026-11-10T08:00:00.000Z",
      prices: [
        {
          provider: "mistral",
          id: "mistral-large-latest",
          input: 1,
          output: 2,
        },
      ],
    });
    renderHook(() => useOpenRouterPrices(), {
      wrapper: withMessenger(messenger),
    });
    await waitFor(() =>
      expect(getCommunityCatalog()?.fetchedAt).toBe("2026-11-10T08:00:00.000Z"),
    );
  });

  it("holds none when core has none (updates off, or no copy)", async () => {
    const messenger = new MockIdeMessenger();
    messenger.responseHandlers["modelCatalog/communityCached"] = async () =>
      null;
    renderHook(() => useOpenRouterPrices(), {
      wrapper: withMessenger(messenger),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(getCommunityCatalog()).toBeUndefined();
  });
});
