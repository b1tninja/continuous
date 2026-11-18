import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../../context/MockIdeMessenger";
import { setupStore } from "../../../redux/store";
import { renderWithProviders } from "../../../util/test/render";
import { ShadowReviewControl } from "./ShadowReviewControl";

const base = {
  form: { enabled: false, timeoutMs: 5000 } as Record<string, unknown>,
  trailEnabled: true,
  spentUsd: 0,
  reservedUsd: 0,
  reviews: 0,
};

async function setup(
  view: Record<string, unknown> = {},
  reply: unknown = undefined,
) {
  const ideMessenger = new MockIdeMessenger();
  const initial = { ...base, ...view };
  ideMessenger.responseHandlers["audit/shadowSettings"] = vi.fn(
    async () => initial,
  ) as any;
  const set = vi.fn(
    async (_: unknown) =>
      reply ?? {
        result: "saved",
        form: initial.form,
        view: {
          ...initial,
          form: { enabled: true, budgetUsd: 0.25, timeoutMs: 5000 },
        },
      },
  );
  ideMessenger.responseHandlers["audit/setShadowSettings"] = set as any;
  const store = setupStore({ ideMessenger });
  await renderWithProviders(<ShadowReviewControl />, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  await act(async () => {});
  return { set };
}

const sw = () => screen.getByRole("switch", { name: /record the reviewer/i });

describe("ShadowReviewControl", () => {
  it("is off by default, with a named switch and a status line", async () => {
    await setup();
    expect(sw()).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("shadow-review-state")).toHaveTextContent("Off");
    expect(screen.getByTestId("shadow-review-cost")).toHaveTextContent(
      "No budget is set",
    );
    expect(screen.getByLabelText("Budget (US dollars)")).toBeInTheDocument();
    expect(screen.getByLabelText("Timeout (milliseconds)")).toBeInTheDocument();
  });

  it("uses unique ids", async () => {
    await setup();
    const ids = [...document.querySelectorAll("[id]")].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("shows spent, remaining and the number of reviews from the ledger", async () => {
    await setup({
      form: { enabled: true, budgetUsd: 0.25, timeoutMs: 5000 },
      spentUsd: 0.0612,
      reservedUsd: 0,
      reviews: 7,
    });
    expect(screen.getByTestId("shadow-review-cost")).toHaveTextContent(
      "$0.0612 of $0.25 spent, $0.1888 left, on 7 reviews.",
    );
  });

  it("says when the budget is used up", async () => {
    await setup({
      form: { enabled: true, budgetUsd: 0.05, timeoutMs: 5000 },
      spentUsd: 0.05,
      reviews: 1,
    });
    expect(screen.getByTestId("shadow-review-cost")).toHaveTextContent(
      "no more run",
    );
  });

  it("turns on with the typed budget; the editor dialog does the confirming", async () => {
    const { set } = await setup();
    fireEvent.change(screen.getByLabelText("Budget (US dollars)"), {
      target: { value: "0.25" },
    });
    await act(async () => fireEvent.click(sw()));
    expect(set).toHaveBeenCalledWith({
      enabled: true,
      budgetUsd: 0.25,
      timeoutMs: 5000,
    });
    expect(sw()).toHaveAttribute("aria-checked", "true");
  });

  it("does not send a request without a usable budget", async () => {
    const { set } = await setup();
    for (const value of ["", "0", "-2", "abc", "1000"]) {
      fireEvent.change(screen.getByLabelText("Budget (US dollars)"), {
        target: { value },
      });
      await act(async () => fireEvent.click(sw()));
      expect(screen.getByTestId("shadow-review-error")).toBeInTheDocument();
    }
    expect(set).not.toHaveBeenCalled();
  });

  it("shows the refusal when the dialog was not confirmed", async () => {
    await setup(
      {},
      {
        result: "refused",
        error:
          "Not confirmed in the editor's own dialog, so nothing was changed.",
      },
    );
    fireEvent.change(screen.getByLabelText("Budget (US dollars)"), {
      target: { value: "1" },
    });
    await act(async () => fireEvent.click(sw()));
    expect(screen.getByRole("alert")).toHaveTextContent("Not confirmed");
    expect(sw()).toHaveAttribute("aria-checked", "false");
  });

  it("turns off without a budget", async () => {
    const { set } = await setup({
      form: { enabled: true, budgetUsd: 0.25, timeoutMs: 5000 },
    });
    await act(async () => fireEvent.click(sw()));
    expect(set).toHaveBeenCalledWith({ enabled: false });
  });

  it("saves a changed budget and timeout together, only when valid", async () => {
    const { set } = await setup({
      form: { enabled: true, budgetUsd: 0.25, timeoutMs: 5000 },
    });
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Timeout (milliseconds)"), {
      target: { value: "50" },
    });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Timeout (milliseconds)"), {
      target: { value: "8000" },
    });
    await act(async () => fireEvent.click(save));
    expect(set).toHaveBeenCalledWith({ budgetUsd: 0.25, timeoutMs: 8000 });
  });

  it("warns when the audit trail is off", async () => {
    await setup({ trailEnabled: false });
    expect(screen.getByTestId("shadow-review-trail-off")).toHaveTextContent(
      "none will run",
    );
  });
});
