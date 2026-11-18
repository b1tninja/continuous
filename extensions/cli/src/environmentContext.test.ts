import { renderEnvironment } from "core/util/environmentPrompt.js";
import type { ChatCompletionMessageParam } from "openai/resources.mjs";
import { afterEach, describe, expect, it } from "vitest";

import {
  ENVIRONMENT_BLOCK_OPEN,
  ensureSessionEnvironment,
  environmentContextBlock,
  environmentDetail,
  environmentDisclosure,
  environmentNotices,
  inheritEnvironment,
  noteDateRollover,
  resetEnvironmentContextBlock,
  sessionEnvironment,
  setAssistantEnvironmentDetail,
  setEnvironmentDetail,
  withEnvironmentBlock,
} from "./environmentContext.js";
import { getCurrentSession, startNewSession } from "./session.js";

afterEach(() => resetEnvironmentContextBlock());

describe("the session's environment", () => {
  it("is gathered once, saved on the session and rendered by the renderer", async () => {
    startNewSession();
    const env = await ensureSessionEnvironment();
    expect(getCurrentSession().environment).toBe(env);
    expect(await ensureSessionEnvironment()).toBe(env);
    const block = environmentContextBlock();
    expect(block).toBe(
      renderEnvironment(env.snapshot, { surface: "cli", detail: "standard" })
        .firstMessageBlock,
    );
    expect(block.startsWith(ENVIRONMENT_BLOCK_OPEN)).toBe(true);
    expect(block).toContain(`Today's date: ${env.snapshot.localDay}`);
    expect(block).toContain("Working folder: ");
    expect(block.endsWith("</context>")).toBe(true);
    expect(environmentContextBlock()).toBe(block);
  });

  it("a resumed session keeps the bytes it was saved with", async () => {
    startNewSession();
    const env = await ensureSessionEnvironment();
    const saved = JSON.parse(JSON.stringify(getCurrentSession()));
    const before = environmentDisclosure();
    resetEnvironmentContextBlock();
    // A later day and another folder change nothing for the saved session
    saved.environment.snapshot.workspace.cwd = "/elsewhere";
    startNewSession();
    Object.assign(getCurrentSession(), { environment: saved.environment });
    expect(await ensureSessionEnvironment()).toBe(saved.environment);
    expect(environmentDisclosure().systemLine).toBe(before.systemLine);
    expect(environmentDisclosure().toolSentence).toBe(before.toolSentence);
    expect(env.snapshot.takenAt).toBe(saved.environment.snapshot.takenAt);
    expect(environmentContextBlock()).toContain("/elsewhere");
  });

  it("a new session gathers its own", async () => {
    startNewSession();
    const first = await ensureSessionEnvironment();
    startNewSession();
    const second = await ensureSessionEnvironment();
    expect(second).not.toBe(first);
    expect(getCurrentSession().environment).toBe(second);
  });

  it("the system line and tool sentence are the same before the gather finishes", async () => {
    startNewSession();
    const early = environmentDisclosure(sessionEnvironment());
    await ensureSessionEnvironment();
    const late = environmentDisclosure();
    expect(early.systemLine).toBe(late.systemLine);
    expect(early.toolSentence).toBe(late.toolSentence);
  });

  it("the detail level is frozen with the session", async () => {
    startNewSession();
    setEnvironmentDetail("minimal");
    const env = await ensureSessionEnvironment();
    expect(env.detail).toBe("minimal");
    setEnvironmentDetail("full");
    expect(sessionEnvironment().detail).toBe("minimal");
    expect(environmentContextBlock()).not.toContain("Working folder");
  });

  it("an assistant's environment.detail may lower the level, never raise it", () => {
    setAssistantEnvironmentDetail("minimal");
    expect(environmentDetail()).toBe("minimal");
    setAssistantEnvironmentDetail("full");
    expect(environmentDetail()).toBe("standard");
    setEnvironmentDetail("full");
    expect(environmentDetail()).toBe("full");
    setAssistantEnvironmentDetail("minimal");
    expect(environmentDetail()).toBe("minimal");
  });

  it("a subagent carries the parent's three strings", () => {
    const parent = {
      systemLine: "<env>\nPlatform: X\n</env>",
      toolSentence: "Runs in X.",
      firstMessageBlock: '<context name="environment">\nX\n</context>',
    };
    inheritEnvironment(parent);
    expect(environmentDisclosure()).toEqual(parent);
    inheritEnvironment(undefined);
    expect(environmentDisclosure()).not.toEqual(parent);
  });
});

describe("the date notice (ENV32)", () => {
  const conversation = (n: number): ChatCompletionMessageParam[] =>
    Array.from({ length: n }, (_, i) => [
      { role: "user" as const, content: `u${i}` },
      { role: "assistant" as const, content: `a${i}` },
    ]).flat();

  it("lands on the newest user message once, and stays on it", async () => {
    startNewSession();
    const env = await ensureSessionEnvironment();
    const started = env.snapshot.localDay;
    const nextDay = "2999-01-02";
    // Same day: nothing
    noteDateRollover(1, started);
    expect(environmentNotices()).toEqual([]);
    const first = withEnvironmentBlock(conversation(1));
    // The next day, third request: the notice goes on user message 3
    noteDateRollover(3, nextDay);
    const third = withEnvironmentBlock(conversation(3));
    expect(third[4].content).toBe(
      `u2\n\n<context name="environment-update">\nToday's date is now ${nextDay} (the session started on ${started}).\n</context>`,
    );
    // Earlier messages keep their bytes
    expect(third[0]).toEqual(first[0]);
    expect(third[2].content).toBe("u1");
    // A later request the same day: the notice stays where it was
    noteDateRollover(4, nextDay);
    const fourth = withEnvironmentBlock(conversation(4));
    expect(fourth.slice(0, 6)).toEqual(third.slice(0, 6));
    expect(fourth[6].content).toBe("u3");
    // It is saved with the session, so a resumed session keeps it
    expect(getCurrentSession().environment?.notices).toHaveLength(1);
  });
});

describe("withEnvironmentBlock", () => {
  const block = '<context name="environment">\nToday: test\n</context>';

  it("appends the block to the first user message only", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: "system text" },
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ];
    const result = withEnvironmentBlock(messages, block);
    expect(result[0]).toEqual({ role: "system", content: "system text" });
    expect(result[1].content).toBe(`first\n\n${block}`);
    expect(result[2]).toEqual({ role: "assistant", content: "reply" });
    expect(result[3].content).toBe("second");
    // The input is left alone: the history must not carry the block
    expect(messages[1].content).toBe("first");
  });

  it("adds a text part when the first user message has parts", () => {
    const messages: ChatCompletionMessageParam[] = [
      {
        role: "user",
        content: [{ type: "text", text: "look at this" }],
      },
    ];
    const result = withEnvironmentBlock(messages, block);
    expect(result[0].content).toEqual([
      { type: "text", text: "look at this" },
      { type: "text", text: block },
    ]);
  });

  it("returns the messages unchanged when there is no user message", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: "only system" },
    ];
    expect(withEnvironmentBlock(messages, block)).toBe(messages);
  });
});
