import { act, fireEvent, screen } from "@testing-library/react";
import type { LoopState } from "core";
import { createLoop } from "core/util/loopMode";
import { describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { setLoop } from "../../redux/slices/sessionSlice";
import { setupStore } from "../../redux/store";
import { renderWithProviders } from "../../util/test/render";
import { LoopSettingsDialog, useLoopNoteDraft } from "./LoopSettingsDialog";

const PLAN = {
  items: [{ id: "1", text: "Fix it", status: "pending" as const }],
  updatedAt: "2026-11-09T10:00:00Z",
};

function Harness({ loop, onClose }: { loop: LoopState; onClose: () => void }) {
  const draft = useLoopNoteDraft();
  return (
    <LoopSettingsDialog
      loop={loop}
      open
      onClose={onClose}
      draft={draft}
      onBudgetApplied={() => {}}
    />
  );
}

async function setup() {
  const loop = createLoop(PLAN, {
    now: new Date("2026-11-09T10:00:00Z"),
    sessionTokens: 0,
    autonomy: "auto",
  });
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  let closed = 0;
  await renderWithProviders(<Harness loop={loop} onClose={() => closed++} />, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  await act(async () => {
    store.dispatch(setLoop(loop));
  });
  return { store, closed: () => closed };
}

describe("LoopSettingsDialog", () => {
  it("is a named modal dialog holding every setting that left the main stack", async () => {
    await setup();
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(screen.getByText("Loop settings")).toBeDefined();
    for (const id of [
      "loop-strategy",
      "loop-parallel",
      "loop-policy",
      "loop-replan",
      "loop-budget-toggle",
      "loop-usage",
      "loop-plan-note",
      "loop-replan-now",
      "loop-standing",
      "loop-plan-note-send",
    ]) {
      expect(screen.getByTestId(id), id).toBeDefined();
    }
  });

  it("closes on Escape and on the close button", async () => {
    const { closed } = await setup();
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    });
    expect(closed()).toBeGreaterThanOrEqual(1);
    const before = closed();
    await act(async () =>
      fireEvent.click(screen.getByTestId("loop-settings-close")),
    );
    expect(closed()).toBe(before + 1);
  });

  it("limits the budget fields until asked for and offers the limit policy inside them", async () => {
    await setup();
    expect(screen.queryByTestId("loop-limit-policy")).toBeNull();
    await act(async () =>
      fireEvent.click(screen.getByTestId("loop-budget-toggle")),
    );
    const select = screen.getByTestId("loop-limit-policy") as HTMLSelectElement;
    // Auto reads as Review
    expect(select.value).toBe("review");
    expect([...select.options].map((o) => o.value)).toEqual([
      "suggest",
      "force",
      "review",
    ]);
  });

  it("the note goes with its target only when there is text", async () => {
    await setup();
    const send = screen.getByTestId("loop-plan-note-send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await act(async () =>
      fireEvent.change(screen.getByTestId("loop-plan-note"), {
        target: { value: "Never edit generated files" },
      }),
    );
    expect(send.disabled).toBe(false);
    // The two targets exclude each other
    await act(async () =>
      fireEvent.click(screen.getByTestId("loop-replan-now")),
    );
    await act(async () => fireEvent.click(screen.getByTestId("loop-standing")));
    expect(
      (screen.getByTestId("loop-replan-now") as HTMLInputElement).checked,
    ).toBe(false);
  });
});
