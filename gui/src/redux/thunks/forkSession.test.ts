import { describe, expect, it } from "vitest";
import { keyChanges } from "../../util/cacheSafeguards";
import { buildChatRequest } from "../util/buildChatRequest";
import { forkSessionThunk } from "./forkSession";
import {
  history,
  opus,
  parent,
  setupForkStore as setup,
  T0,
} from "./forkSession.fixture";

describe("Fork from here and Fork session (GUI)", () => {
  it("copies the history to the fork point, the mode, the model, the task plan and the cache record, and nothing else", async () => {
    const { store, saves } = await setup();
    const id = await store.dispatch(forkSessionThunk({ upTo: 2 })).unwrap();

    const s = store.getState().session;
    expect(id).toBeDefined();
    expect(s.id).toBe(id);
    expect(s.id).not.toBe("parent");
    expect(JSON.stringify(s.history)).toBe(JSON.stringify(history.slice(0, 3)));
    expect(s.mode).toBe("agent");
    expect(s.taskPlan).toEqual(parent.taskPlan);
    expect(s.planFile).toBeUndefined();
    expect(s.loopRequested).toBeUndefined();
    expect(s.checkpoints).toEqual([]);
    expect(s.usage).toBeUndefined();
    expect(s.forkedFrom).toEqual({ sessionId: "parent", index: 2 });

    // The record of the fork point: the entry the next request read (at
    // T0 + 60 s), the prompt up to there, Auto's escalation kept, the request
    // count restarted
    expect(s.promptCache).toMatchObject({
      lastRequestAt: T0 + 60_000,
      lastInputTokens: 61_300,
      lastTtl: "5m",
      escalated: true,
      escalatedBy: "requests",
    });
    expect(s.promptCache?.requests).toBeUndefined();
    expect(s.promptCache?.ledger?.map((e) => e.historyItems)).toEqual([1, 2]);

    // Saved: the original first, as it was, then the fork beside it
    expect(saves[0].sessionId).toBe("parent");
    expect(saves[0].planFile).toBe(parent.planFile);
    expect(saves[0].history).toHaveLength(5);
    const fork = saves.find((x) => x.sessionId === id)!;
    expect(fork.chatModelTitle).toBe(opus.title);
    expect(fork.forkedFrom).toEqual({ sessionId: "parent", index: 2 });
    expect(fork.planFile).toBeUndefined();
  });

  it("keeps the request prefix byte-identical to the parent's up to the fork point", async () => {
    const { store } = await setup();
    const before = store.getState();
    const parentFull = buildChatRequest(before);
    const parentAtPoint = buildChatRequest(
      before,
      before.session.history.slice(0, 3),
    );

    await store.dispatch(forkSessionThunk({ upTo: 2 })).unwrap();
    const forked = buildChatRequest(store.getState());

    // Tools, options (reasoning) and the system message: the same bytes
    expect(JSON.stringify(forked.activeTools)).toBe(
      JSON.stringify(parentFull.activeTools),
    );
    expect(JSON.stringify(forked.completionOptions)).toBe(
      JSON.stringify(parentFull.completionOptions),
    );
    expect(forked.messages[0]).toEqual(parentFull.messages[0]);
    expect(forked.messages[0].role).toBe("system");
    // The messages: exactly the parent's at that point, and a prefix of the
    // parent's whole conversation
    expect(JSON.stringify(forked.messages)).toBe(
      JSON.stringify(parentAtPoint.messages),
    );
    expect(JSON.stringify(forked.messages)).toBe(
      JSON.stringify(parentFull.messages.slice(0, forked.messages.length)),
    );
    expect(forked.messages.length).toBeGreaterThan(2);
  });

  it("records the fork's own key, so its next request is not reported as a miss", async () => {
    const { store } = await setup();
    await store.dispatch(forkSessionThunk({ upTo: 2 })).unwrap();
    const s = store.getState().session;
    const lastKey = s.promptCache?.lastKey;
    expect(lastKey).toBeDefined();
    // What the next request will key: the fork's messages plus a new one
    const next = { ...lastKey!, messages: [...lastKey!.messages!, "new"] };
    expect(keyChanges(lastKey, next)).toEqual([]);
  });

  it("Fork session copies the whole conversation and keeps the parent's record", async () => {
    const { store } = await setup();
    await store.dispatch(forkSessionThunk({})).unwrap();
    const s = store.getState().session;
    expect(JSON.stringify(s.history)).toBe(JSON.stringify(history));
    expect(s.forkedFrom).toEqual({ sessionId: "parent" });
    expect(s.promptCache).toMatchObject({
      lastRequestAt: T0 + 60_000,
      lastInputTokens: 62_000,
    });
    expect(s.promptCache?.ledger).toHaveLength(3);
  });

  it("keeps this window's permission levels, IDGAF included (it is per window, not per session)", async () => {
    const { store } = await setup();
    const levels = store.getState().ui.policyLevels;
    await store.dispatch(forkSessionThunk({ upTo: 2 })).unwrap();
    expect(store.getState().ui.policyLevels).toEqual(levels);
    expect(store.getState().ui.policyLevels.tools).toBe("idgaf");
  });

  it("does nothing while a response is streaming", async () => {
    const { store } = await setup();
    store.dispatch({ type: "session/setActive" });
    const id = await store.dispatch(forkSessionThunk({ upTo: 2 })).unwrap();
    expect(id).toBeUndefined();
    expect(store.getState().session.id).toBe("parent");
  });

  it("forks a session from another tab from its saved file", async () => {
    const { store, ideMessenger } = await setup();
    ideMessenger.responseHandlers["history/load"] = async () =>
      ({
        ...structuredClone(parent),
        sessionId: "other",
        promptCache: { lastRequestAt: 5, lastInputTokens: 9, lastTtl: "1h" },
      }) as any;
    const id = await store
      .dispatch(forkSessionThunk({ sessionId: "other" }))
      .unwrap();
    const s = store.getState().session;
    expect(s.id).toBe(id);
    expect(s.forkedFrom).toEqual({ sessionId: "other" });
    expect(s.history).toHaveLength(5);
    expect(s.promptCache).toMatchObject({
      lastRequestAt: 5,
      lastInputTokens: 9,
      lastTtl: "1h",
    });
  });
});
