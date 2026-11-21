import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { setPolicyExtras } from "../../redux/slices/uiSlice";
import { changePolicyExtras } from "../../redux/thunks/policySettings";
import { setupStore } from "../../redux/store";
import { renderWithProviders } from "../../util/test/render";

import { DecisionTimerCard, withWindow } from "./DecisionTimerCard";

async function setup(initial?: { timer?: any; headsUp?: any }) {
  const saved: any[] = [];
  const ideMessenger = new MockIdeMessenger();
  ideMessenger.responseHandlers["policy/save"] = (async (update: unknown) => {
    saved.push(update);
  }) as never;
  const store = setupStore({ ideMessenger });
  if (initial) store.dispatch(setPolicyExtras(initial));
  await renderWithProviders(<DecisionTimerCard />, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  return { store, saved };
}

const pick = async (testId: string, value: string) => {
  await act(async () => {
    fireEvent.change(screen.getByTestId(testId), { target: { value } });
  });
};

describe("withWindow", () => {
  it("sets a window and leaves the others", () => {
    expect(withWindow({ manual: 5 }, "cautious", 15)).toEqual({
      manual: 5,
      cautious: 15,
    });
  });
  it("changes a window", () => {
    expect(withWindow({ cautious: 5 }, "cautious", 30)).toEqual({
      cautious: 30,
    });
  });
  it("removes a window set to off, and leaves an empty object when none is left", () => {
    expect(withWindow({ cautious: 5, manual: 10 }, "cautious", 0)).toEqual({
      manual: 10,
    });
    expect(withWindow({ cautious: 5 }, "cautious", 0)).toEqual({});
  });
  it("starts from nothing", () => {
    expect(withWindow(undefined, "manual", 5)).toEqual({ manual: 5 });
  });
  it("does not change its input", () => {
    const input = { cautious: 5 } as const;
    withWindow(input, "cautious", 0);
    expect(input).toEqual({ cautious: 5 });
  });
});

describe("DecisionTimerCard", () => {
  it("lists the four levels, each with an ask window and a heads-up, and no IDGAF", async () => {
    await setup();
    for (const level of ["manual", "cautious", "automatic", "permissive"]) {
      expect(screen.getByTestId(`timer-${level}`)).toBeTruthy();
      expect(screen.getByTestId(`headsUp-${level}`)).toBeTruthy();
    }
    expect(screen.queryByTestId("timer-idgaf")).toBeNull();
  });

  it("starts with everything off", async () => {
    await setup();
    for (const level of ["manual", "cautious", "automatic", "permissive"]) {
      expect(
        (screen.getByTestId(`timer-${level}`) as HTMLSelectElement).value,
      ).toBe("0");
      expect(
        (screen.getByTestId(`headsUp-${level}`) as HTMLSelectElement).value,
      ).toBe("0");
    }
  });

  it("offers 5, 10, 15 and 30 s for asks and 5 and 10 s for allowed calls, never 60", async () => {
    await setup();
    const values = (id: string) =>
      Array.from((screen.getByTestId(id) as HTMLSelectElement).options).map(
        (o) => o.value,
      );
    expect(values("timer-cautious")).toEqual(["0", "5", "10", "15", "30"]);
    expect(values("headsUp-cautious")).toEqual(["0", "5", "10"]);
  });

  it("shows what the file holds", async () => {
    await setup({ timer: { cautious: 15 }, headsUp: { permissive: 5 } });
    expect(
      (screen.getByTestId("timer-cautious") as HTMLSelectElement).value,
    ).toBe("15");
    expect(
      (screen.getByTestId("headsUp-permissive") as HTMLSelectElement).value,
    ).toBe("5");
    expect(
      (screen.getByTestId("timer-permissive") as HTMLSelectElement).value,
    ).toBe("0");
  });

  it("saves a window to permissions.yaml when it is chosen", async () => {
    const { saved, store } = await setup();
    await pick("timer-cautious", "15");
    expect(store.getState().ui.policyExtras.timer).toEqual({ cautious: 15 });
    expect(saved.at(-1).timer).toEqual({ cautious: 15 });
  });

  it("the two settings are saved apart", async () => {
    const { saved } = await setup();
    await pick("headsUp-permissive", "10");
    expect(saved.at(-1).headsUp).toEqual({ permissive: 10 });
    expect(saved.at(-1).timer).toBeUndefined();
  });

  it("turning the last window off saves an empty object, which removes it from the file", async () => {
    const { saved } = await setup({ timer: { cautious: 15 } });
    await pick("timer-cautious", "0");
    expect(saved.at(-1).timer).toEqual({});
  });

  it("a save made while nothing is set sends neither key, so it cannot remove the file's", async () => {
    const { saved, store } = await setup();
    await act(async () => {
      await store.dispatch(changePolicyExtras({ maxNewPlanItems: 3 }));
    });
    const last = saved.at(-1);
    expect(last).toBeDefined();
    expect(Object.keys(last)).not.toContain("timer");
    expect(Object.keys(last)).not.toContain("headsUp");
  });

  it("once a window is set, later unrelated saves keep sending it", async () => {
    const { saved, store } = await setup({ timer: { cautious: 15 } });
    await act(async () => {
      await store.dispatch(changePolicyExtras({ maxNewPlanItems: 3 }));
    });
    expect(saved.at(-1).timer).toEqual({ cautious: 15 });
  });

  it("each select has a name that says what it sets", async () => {
    await setup();
    expect(screen.getByLabelText("Window for asks at Cautious")).toBeTruthy();
    expect(
      screen.getByLabelText("Heads-up for allowed calls at Permissive"),
    ).toBeTruthy();
  });

  it("explains what the timer does and what it leaves waiting", async () => {
    await setup();
    const text = screen.getByTestId("decision-timer").textContent ?? "";
    expect(text).toContain("refused when its window ends");
    expect(text).toContain("keep waiting");
  });
});
