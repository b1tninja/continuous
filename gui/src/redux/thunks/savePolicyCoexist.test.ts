import { describe, expect, it } from "vitest";

import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { setPolicyExtras } from "../slices/uiSlice";
import { setupStore } from "../store";

import { savePolicySettings } from "./policySettings";

/**
 * The timer and heads-up windows and skipPermissionConfirm are saved by the
 * same thunk. Each must be sent when set and left out when not, so that a save
 * made for one reason cannot remove another setting from the file.
 */
async function save(extras: Parameters<typeof setPolicyExtras>[0]) {
  const sent: any[] = [];
  const ideMessenger = new MockIdeMessenger();
  ideMessenger.responseHandlers["policy/save"] = (async (update: unknown) => {
    sent.push(update);
  }) as never;
  const store = setupStore({ ideMessenger });
  store.dispatch(setPolicyExtras(extras));
  await store.dispatch(savePolicySettings());
  return sent.at(-1);
}

describe("savePolicySettings with the timer and skipPermissionConfirm", () => {
  it("sends neither window when none was set, and removes the skip line when it is off", async () => {
    const update = await save({});
    expect("timer" in update).toBe(false);
    expect("headsUp" in update).toBe(false);
    // off means the line is removed from the file
    expect(update.skipPermissionConfirm).toBeNull();
  });

  it("sends the timer and the skip setting together", async () => {
    const update = await save({
      timer: { cautious: 15 },
      skipPermissionConfirm: true,
    });
    expect(update.timer).toEqual({ cautious: 15 });
    expect(update.skipPermissionConfirm).toBe(true);
    expect("headsUp" in update).toBe(false);
  });

  it("sends the heads-up and the timer together", async () => {
    const update = await save({
      timer: { manual: 5 },
      headsUp: { permissive: 10 },
    });
    expect(update.timer).toEqual({ manual: 5 });
    expect(update.headsUp).toEqual({ permissive: 10 });
  });

  it("sends an empty window map, which removes it, when the person turned every window off", async () => {
    const update = await save({ timer: {}, headsUp: {} });
    expect(update.timer).toEqual({});
    expect(update.headsUp).toEqual({});
  });

  it("sends all three at once", async () => {
    const update = await save({
      timer: { cautious: 30 },
      headsUp: { cautious: 5 },
      skipPermissionConfirm: true,
    });
    expect(update.timer).toEqual({ cautious: 30 });
    expect(update.headsUp).toEqual({ cautious: 5 });
    expect(update.skipPermissionConfirm).toBe(true);
  });
});
