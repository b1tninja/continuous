import type { ChatHistoryItem, Session } from "core";
import { beforeEach, describe, expect, it } from "vitest";
import type { IIdeMessenger } from "../../context/IdeMessenger";
import { resetSessionDeltaState, saveSessionToCore } from "./sessionDelta";

function item(role: "user" | "assistant", content: string): ChatHistoryItem {
  return { message: { role, content }, contextItems: [] };
}

/** Records what was posted; answers like a core with the session log on. */
function fakeCore(opts: { log?: boolean; refuseDeltas?: boolean } = {}) {
  const posted: { type: string; data: any }[] = [];
  let rev = 0;
  const messenger = {
    request: async (type: string, data: any) => {
      posted.push({ type, data });
      if (type === "history/save") {
        return {
          status: "success",
          content: opts.log === false ? undefined : { rev: `r${++rev}` },
        };
      }
      if (type === "history/saveDelta") {
        if (opts.refuseDeltas || data.baseRev !== `r${rev}`) {
          return { status: "success", content: { rev: null, needFull: true } };
        }
        return { status: "success", content: { rev: `r${++rev}` } };
      }
      throw new Error(type);
    },
  } as unknown as IIdeMessenger;
  return { messenger, posted };
}

function session(history: ChatHistoryItem[], extra: Partial<Session> = {}) {
  return {
    sessionId: "s1",
    title: "T",
    workspaceDirectory: "/ws",
    history,
    ...extra,
  } as Session;
}

beforeEach(() => resetSessionDeltaState());

describe("saveSessionToCore", () => {
  it("sends the whole session first, then only changed items", async () => {
    const { messenger, posted } = fakeCore();
    const a = item("user", "q");
    const b = item("assistant", "a");
    await saveSessionToCore(messenger, session([a, b]));
    const c = item("user", "next");
    const b2 = { ...b, message: { ...b.message, content: "a, edited" } };
    const report = await saveSessionToCore(
      messenger,
      session([a, b2, c], { mode: "agent" }),
    );
    expect(report.kind).toBe("delta");
    expect(posted.map((p) => p.type)).toEqual([
      "history/save",
      "history/saveDelta",
    ]);
    const delta = posted[1].data;
    expect(delta.items.map((i: any) => i.index)).toEqual([1, 2]);
    expect(delta.length).toBe(3);
    expect(delta.meta).toEqual({
      title: "T",
      workspaceDirectory: "/ws",
      mode: "agent",
    });
  });

  it("an unchanged session sends no items", async () => {
    const { messenger, posted } = fakeCore();
    const s = session([item("user", "q")]);
    await saveSessionToCore(messenger, s);
    await saveSessionToCore(messenger, { ...s });
    expect(posted[1].data.items).toEqual([]);
  });

  it("records removed fields and a shorter history", async () => {
    const { messenger, posted } = fakeCore();
    const h = [item("user", "q"), item("assistant", "a")];
    await saveSessionToCore(messenger, session(h, { planFile: "p.md" }));
    await saveSessionToCore(messenger, session(h.slice(0, 1)));
    expect(posted[1].data).toMatchObject({
      length: 1,
      items: [],
      unset: ["planFile"],
    });
  });

  it("sends the whole session when the core asks for it", async () => {
    const { messenger, posted } = fakeCore({ refuseDeltas: true });
    const s = session([item("user", "q")]);
    await saveSessionToCore(messenger, s);
    const report = await saveSessionToCore(messenger, {
      ...s,
      history: [...s.history, item("assistant", "a")],
    });
    expect(report.kind).toBe("full");
    expect(posted.map((p) => p.type)).toEqual([
      "history/save",
      "history/saveDelta",
      "history/save",
    ]);
  });

  it("drops prompts from what it sends", async () => {
    const { messenger, posted } = fakeCore();
    const withPrompt: ChatHistoryItem = {
      ...item("assistant", "a"),
      promptLogs: [
        {
          modelTitle: "m",
          modelProvider: "p",
          prompt: "the whole conversation",
          completion: "a",
        },
      ],
    };
    await saveSessionToCore(messenger, session([withPrompt]));
    expect(JSON.stringify(posted[0].data)).not.toContain(
      "the whole conversation",
    );
  });

  describe("checkpoints during a turn", () => {
    it("marks the newest item as cut off, and sends it again unmarked after", async () => {
      const { messenger, posted } = fakeCore();
      const q = item("user", "q");
      await saveSessionToCore(messenger, session([q]));
      const partial = item("assistant", "half");
      await saveSessionToCore(messenger, session([q, partial]), {
        checkpoint: "reloaded",
      });
      expect(posted[1].data.items).toEqual([
        { index: 1, item: { ...partial, interrupted: "reloaded" } },
      ]);
      // The turn ends with the same object in the store: still sent, unmarked
      await saveSessionToCore(messenger, session([q, partial]));
      expect(posted[2].data.items).toEqual([{ index: 1, item: partial }]);
    });

    it("are skipped when the core keeps sessions as one JSON file", async () => {
      const { messenger, posted } = fakeCore({ log: false });
      const s = session([item("user", "q")]);
      await saveSessionToCore(messenger, s);
      const report = await saveSessionToCore(messenger, s, {
        checkpoint: "reloaded",
      });
      expect(report.kind).toBe("skipped");
      expect(posted).toHaveLength(1);
    });

    it("run one at a time, in order", async () => {
      const { messenger, posted } = fakeCore();
      const q = item("user", "q");
      const runs = [
        saveSessionToCore(messenger, session([q])),
        saveSessionToCore(messenger, session([q, item("assistant", "1")]), {
          checkpoint: "reloaded",
        }),
        saveSessionToCore(messenger, session([q, item("assistant", "12")])),
      ];
      const reports = await Promise.all(runs);
      expect(reports.map((r) => r.kind)).toEqual(["full", "delta", "delta"]);
      expect(posted.map((p) => p.type)).toEqual([
        "history/save",
        "history/saveDelta",
        "history/saveDelta",
      ]);
    });
  });
});
