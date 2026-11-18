import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelInfoFreshness } from "../../../components/ModelInfoFreshness";
import { MockIdeMessenger } from "../../../context/MockIdeMessenger";
import { setupStore } from "../../../redux/store";
import { renderWithProviders } from "../../../util/test/render";
import { ModelInformationControl } from "./ModelInformationControl";

type Policy = "automatic" | "ask" | "never" | "off";

function messenger(
  initial: {
    policy?: Policy;
    fetchedAt?: string;
    lastAttempt?: { at: string; error?: string };
  } = {},
) {
  const ideMessenger = new MockIdeMessenger();
  let policy: Policy = initial.policy ?? "automatic";
  let refreshHours = 24;
  const saved: unknown[] = [];
  const pulls: unknown[] = [];
  ideMessenger.responseHandlers["modelCatalog/status"] = vi.fn(async () => ({
    policy,
    refreshHours,
    ...(initial.lastAttempt ? { lastAttempt: initial.lastAttempt } : {}),
    ...(initial.fetchedAt
      ? { openrouter: { fetchedAt: initial.fetchedAt, count: 3 } }
      : {}),
  })) as any;
  ideMessenger.responseHandlers["modelCatalog/setPolicy"] = vi.fn(
    async (req: any) => {
      saved.push(req);
      if (req.policy) policy = req.policy;
      if (req.refreshHours) refreshHours = req.refreshHours;
      return { saved: true };
    },
  ) as any;
  ideMessenger.responseHandlers["modelCatalog/pull"] = vi.fn(async () => {
    pulls.push(1);
    return {
      ok: true as const,
      fetchedAt: "2026-11-13T09:00:00.000Z",
      models: [],
    };
  }) as any;
  return { ideMessenger, saved, pulls };
}

async function render(ui: React.ReactElement, ideMessenger: MockIdeMessenger) {
  const store = setupStore({ ideMessenger });
  const r = await renderWithProviders(ui, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  await act(async () => {});
  return r;
}

describe("ModelInformationControl", () => {
  it("shows Automatic as the default and saves each choice to the shared setting", async () => {
    const { ideMessenger, saved, pulls } = messenger();
    const { user } = await render(<ModelInformationControl />, ideMessenger);
    const automatic = screen.getByRole("radio", { name: /Automatic/ });
    expect((automatic as HTMLInputElement).checked).toBe(true);

    await user.click(screen.getByRole("radio", { name: /^Off/ }));
    await waitFor(() => expect(saved).toContainEqual({ policy: "off" }));
    await user.click(screen.getByRole("radio", { name: /Only when I ask/ }));
    await waitFor(() => expect(saved).toContainEqual({ policy: "ask" }));
    await user.click(screen.getByRole("radio", { name: /Automatic/ }));
    await waitFor(() => expect(saved).toContainEqual({ policy: "automatic" }));
    // Choosing a setting never contacts openrouter.ai by itself
    expect(pulls).toHaveLength(0);
  });

  it("keeps a saved 'don't ask again' when Only when I ask is chosen again", async () => {
    const { ideMessenger, saved } = messenger({ policy: "never" });
    const { user } = await render(<ModelInformationControl />, ideMessenger);
    const manual = screen.getByRole("radio", { name: /Only when I ask/ });
    expect((manual as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByRole("radio", { name: /Automatic/ }));
    await user.click(screen.getByRole("radio", { name: /Only when I ask/ }));
    await waitFor(() => expect(saved.length).toBe(2));
    expect(saved[1]).toEqual({ policy: "ask" });
  });
});

describe("ModelInfoFreshness", () => {
  it("shows when the list was last updated, and Refresh now makes one request", async () => {
    const { ideMessenger, pulls } = messenger({
      fetchedAt: "2026-11-12T08:00:00.000Z",
    });
    const { user } = await render(<ModelInfoFreshness />, ideMessenger);
    expect(
      screen.getByText(/OpenRouter model information last updated/),
    ).toBeTruthy();
    expect(pulls).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Refresh now" }));
    await waitFor(() => expect(pulls).toHaveLength(1));
  });

  it("says when an automatic update failed", async () => {
    const { ideMessenger } = messenger({
      fetchedAt: "2026-11-12T08:00:00.000Z",
      lastAttempt: { at: "2026-11-13T08:00:00.000Z", error: "offline" },
    });
    await render(<ModelInfoFreshness />, ideMessenger);
    expect(
      screen.getByText(/last automatic update failed \(offline\)/),
    ).toBeTruthy();
  });

  it("offers no Refresh now when updates are off", async () => {
    const { ideMessenger, pulls } = messenger({
      policy: "off",
      fetchedAt: "2026-11-12T08:00:00.000Z",
    });
    await render(<ModelInfoFreshness />, ideMessenger);
    expect(screen.getByText(/Model information updates are off/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Refresh now" })).toBeNull();
    expect(pulls).toHaveLength(0);
  });
});
