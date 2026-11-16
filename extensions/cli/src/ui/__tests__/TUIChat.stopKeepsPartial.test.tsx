import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getCurrentSession, loadSessionById } from "../../session.js";
import {
  continueStoppedReply,
  keepStoppedReply,
  markPartialReplyStopped,
  RESUME_PROMPT,
} from "../hooks/useChat.stopped.js";

import {
  ENTER,
  messageText,
  partialHeldTurn,
  registerFlowServices,
  renderFlow,
  resetFlowState,
  ScriptedLlm,
  stopWithEsc,
  textTurn,
  tick,
  type,
  waitUntil,
} from "./TUIChat.flowHarness.js";

/*
 * Stop keeps the partial reply, as the IDE does: it stays on screen, is
 * saved with the session marked stopped, and Resume asks the model to go on
 * from it.
 */

const user = (content: string) => ({
  message: { role: "user" as const, content },
  contextItems: [],
});
const assistant = (content: string) => ({
  message: { role: "assistant" as const, content },
  contextItems: [],
});

describe("the partial reply helpers", () => {
  it("mark the partial reply stopped, and drop an empty one", () => {
    expect(
      markPartialReplyStopped([user("hi"), assistant("The build starts")]).at(
        -1,
      ),
    ).toEqual({ ...assistant("The build starts"), interrupted: "stopped" });
    expect(markPartialReplyStopped([user("hi"), assistant("")])).toEqual([
      user("hi"),
    ]);
    expect(markPartialReplyStopped([user("hi")])).toEqual([user("hi")]);
  });

  it("add the streamed text as the stopped reply, or nothing when there was none", () => {
    expect(keepStoppedReply([user("hi")], "The build starts")).toEqual([
      user("hi"),
      { ...assistant("The build starts"), interrupted: "stopped" },
    ]);
    expect(keepStoppedReply([user("hi")], "  ")).toEqual([user("hi")]);
  });

  it("continue a stopped reply with the resume prompt, and nothing else", () => {
    const stopped = markPartialReplyStopped([
      user("hi"),
      assistant("The build starts"),
    ]);
    const next = continueStoppedReply(stopped)!;
    expect(next.at(-2)?.message.content).toBe("The build starts");
    expect(next.at(-2)?.interrupted).toBeUndefined();
    expect(next.at(-1)?.message).toEqual({
      role: "user",
      content: RESUME_PROMPT,
    });
    expect(
      continueStoppedReply([user("hi"), assistant("done")]),
    ).toBeUndefined();
  });
});

describe("TUIChat - Stop keeps the partial reply", () => {
  beforeEach(resetFlowState);
  afterEach(resetFlowState);

  it("keeps it on screen and in the saved session, marked stopped; Resume goes on from it", async () => {
    const first = partialHeldTurn("The build starts", " never sent");
    const llm = new ScriptedLlm([first.turn, textTurn(" with the config.")]);
    await registerFlowServices({ llm });
    const ui = renderFlow();
    try {
      await type(ui.stdin, "explain the build");
      await type(ui.stdin, ENTER);
      await first.started;
      // The text streamed so far, still being written
      await tick(300);

      await stopWithEsc(ui.stdin);
      await waitUntil(() => first.wasAborted(), "the stop", ui.lastFrame);

      const sessionId = getCurrentSession().sessionId;
      await waitUntil(
        () =>
          loadSessionById(sessionId)?.history.at(-1)?.interrupted === "stopped",
        "the stopped reply on disk",
        ui.lastFrame,
      );
      const saved = loadSessionById(sessionId)!;
      expect(saved.history.at(-1)?.message.content).toBe("The build starts");
      await waitUntil(
        () => ui.allOutput().includes("The build starts"),
        "the partial reply on screen",
        ui.lastFrame,
      );

      // Enter on the empty prompt resumes from the partial reply
      await type(ui.stdin, ENTER);
      await waitUntil(
        () => llm.requests.length === 2,
        "the resumed request",
        ui.lastFrame,
      );
      const sent = llm.requests[1].messages;
      expect(messageText(sent.at(-2)!)).toBe("The build starts");
      expect(messageText(sent.at(-1)!)).toBe(RESUME_PROMPT);
      await waitUntil(
        () => ui.allOutput().includes("with the config."),
        "the resumed reply",
        ui.lastFrame,
      );
    } finally {
      ui.unmount();
    }
  });
});
