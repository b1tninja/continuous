import type { SessionEnvironment } from "core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getEmptyRootState } from "../../util/test/mockStore";
import type { RootState } from "../store";
import {
  ensureSessionEnvironment,
  needsSessionEnvironment,
  resetSessionEnvironmentFreeze,
} from "./sessionEnvironment";

const ENV = {
  snapshot: { version: 1 },
  detail: "standard",
  strings: { systemLine: "S", toolSentence: "T", firstMessageBlock: "U" },
} as unknown as SessionEnvironment;

function setup(
  environment?: SessionEnvironment,
  answer: unknown = { status: "success", content: ENV },
) {
  const base = getEmptyRootState();
  let state: RootState = {
    ...base,
    session: { ...base.session, id: "s1", environment },
  };
  const request = vi.fn(async () => answer);
  const dispatch = vi.fn((action: { type: string; payload: unknown }) => {
    if (action.type === "session/setSessionEnvironment") {
      state = {
        ...state,
        session: { ...state.session, environment: action.payload as never },
      };
    }
    return action;
  });
  return {
    getState: () => state,
    dispatch,
    request,
    run: () =>
      ensureSessionEnvironment(
        () => state,
        dispatch as never,
        { request } as never,
      ),
  };
}

beforeEach(() => resetSessionEnvironmentFreeze());

describe("ensureSessionEnvironment", () => {
  it("asks core once for a new session and stores the answer", async () => {
    const t = setup();
    expect(needsSessionEnvironment(t.getState())).toBe(true);
    await t.run();
    await t.run();
    expect(t.request).toHaveBeenCalledTimes(1);
    expect(t.request).toHaveBeenCalledWith("environment/session", {
      saved: undefined,
    });
    expect(t.getState().session.environment).toBe(ENV);
    expect(needsSessionEnvironment(t.getState())).toBe(false);
  });

  it("sends a resumed session's environment back to freeze its shell, and keeps its texts", async () => {
    const saved = {
      ...ENV,
      strings: { ...ENV.strings!, firstMessageBlock: "SAVED" },
    };
    const t = setup(saved);
    await t.run();
    expect(t.request).toHaveBeenCalledWith("environment/session", { saved });
    expect(t.dispatch).not.toHaveBeenCalled();
    expect(t.getState().session.environment).toBe(saved);
  });

  it("goes without when core cannot answer, and does not ask again", async () => {
    const t = setup(undefined, { status: "error", error: "no" });
    await t.run();
    await t.run();
    expect(t.request).toHaveBeenCalledTimes(1);
    expect(t.getState().session.environment).toBeUndefined();
  });
});
