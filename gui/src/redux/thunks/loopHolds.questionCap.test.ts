import { BuiltInToolNames } from "core/tools/builtIn";
import { refusalText } from "core/tools/refusalText";
import { createLoop, LOOP_LIMITS, startItemRun } from "core/util/loopMode";
import { describe, expect, it, vi } from "vitest";
import { getEmptyRootState } from "../../util/test/mockStore";
import { RootState } from "../store";
import { EvaluatedPolicy } from "./evaluateToolPolicies";
import { applyLoopHolds } from "./loopHolds";

const NOW = new Date("2026-11-21T10:00:00Z");
const PLAN = {
  items: [{ id: "1", text: "Build it", status: "pending" as const }],
  updatedAt: NOW.toISOString(),
};
const CAP = LOOP_LIMITS.maxOpenQuestionsPerItem;
const TOOL = BuiltInToolNames.RunTerminalCommand;

/** A call that would ask the person: a different command each time. */
function asks(n: number): EvaluatedPolicy {
  return {
    policy: "allowedWithPermission",
    toolCallState: {
      toolCallId: `call-${n}`,
      toolCall: {
        id: `call-${n}`,
        type: "function",
        function: { name: TOOL, arguments: "{}" },
      },
      parsedArgs: { command: `npm run build:${n}` },
      status: "generated",
    } as any,
  };
}

/** Item 1 running; `hold` applies the loop's holds to one reply's calls. */
function running() {
  const state = getEmptyRootState();
  let current: RootState = {
    ...state,
    session: {
      ...state.session,
      loop: startItemRun(
        createLoop(PLAN, { now: NOW, sessionTokens: 0 }),
        "1",
        0,
        NOW,
      ),
      history: [],
    },
  };
  const results: { toolCallId: string; content: string }[] = [];
  const dispatch = vi.fn((action: any) => {
    if (action.type === "session/setLoop") {
      current = {
        ...current,
        session: { ...current.session, loop: action.payload },
      };
    }
    if (action.type === "session/updateToolCallOutput") {
      results.push({
        toolCallId: action.payload.toolCallId,
        content: action.payload.contextItems[0].content,
      });
    }
    return action;
  });
  return {
    hold: (...policies: EvaluatedPolicy[]) =>
      applyLoopHolds(dispatch as any, () => current, policies),
    loop: () => current.session.loop!,
    results,
  };
}

describe("a held call at the item's question limit", () => {
  it("below the limit each call is held as a question and the run goes on", () => {
    const h = running();
    for (let n = 1; n <= CAP; n++) {
      expect(h.hold(asks(n))[0].policy).toBe("disabled");
    }
    expect(h.loop().questions).toHaveLength(CAP);
    expect(h.loop().current?.report).toBeUndefined();
    expect(h.loop().current?.questionCap).toBeUndefined();
    expect(h.results).toHaveLength(CAP);
    for (const [i, r] of h.results.entries()) {
      expect(r.content).toContain(`held as question q${i + 1}`);
    }
  });

  it("the next one ends the run as waiting with one result, and holds nothing more", () => {
    const h = running();
    for (let n = 1; n <= CAP; n++) h.hold(asks(n));
    h.results.length = 0;

    expect(h.hold(asks(CAP + 1))[0].policy).toBe("disabled");
    expect(h.results).toEqual([
      {
        toolCallId: `call-${CAP + 1}`,
        content: refusalText.questionCapWaiting(TOOL, CAP),
      },
    ]);
    expect(h.loop().questions).toHaveLength(CAP);
    // What streamNormalInput ends the turn on
    expect(h.loop().current).toMatchObject({
      questionCap: true,
      report: { outcome: "waiting" },
    });
  });

  it("the rest of the same reply gets no result: the turn's end cancels it", () => {
    const h = running();
    for (let n = 1; n < CAP; n++) h.hold(asks(n));
    h.results.length = 0;

    const after = h.hold(asks(CAP), asks(CAP + 1), asks(CAP + 2), {
      ...asks(CAP + 3),
      policy: "allowedWithoutPermission",
    });
    expect(h.results.map((r) => r.toolCallId)).toEqual([
      `call-${CAP}`,
      `call-${CAP + 1}`,
    ]);
    expect(h.results[0].content).toContain(`held as question q${CAP}`);
    expect(h.results[1].content).toBe(
      refusalText.questionCapWaiting(TOOL, CAP),
    );
    // Left as they were, for the cancelled turn to clear
    expect(after.map((p) => p.policy)).toEqual([
      "disabled",
      "disabled",
      "allowedWithPermission",
      "allowedWithoutPermission",
    ]);
    expect(h.loop().questions).toHaveLength(CAP);
  });
});
