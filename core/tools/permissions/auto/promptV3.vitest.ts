import { evaluateTerminalCommandSecurity } from "@continuedev/terminal-security";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { autoReviewToolCall, type AutoReviewDeps } from "./handler";
import { parseReviewerReply } from "./parse";
import {
  buildReviewMessages,
  REVIEWER_SYSTEM_PROMPT,
  reviewerPromptVersion,
} from "./prompt";
import {
  promptText,
  REVIEWER_SYSTEM_PROMPT_V3,
  sanitizePromptVariant,
} from "./promptV3";
import { reviewToolCall } from "./review";
import { AutoReviewSessions } from "./state";
import { readUserReviewerPrompt } from "../userReviewerPrompt";

const segment = (text: string, from: string, to: string) =>
  text.slice(text.indexOf(from), text.indexOf(to));

describe("the default prompt is unchanged", () => {
  it("keeps its audit id (golden)", () => {
    // Pinned from the prompt as shipped before v3 existed. A change here
    // means the default prompt moved, which needs a measurement first.
    expect(reviewerPromptVersion()).toBe("ad8e5251d1d9");
  });

  it("is what an absent or default variant sends", () => {
    expect(promptText(undefined)).toBe(REVIEWER_SYSTEM_PROMPT);
    expect(promptText("default")).toBe(REVIEWER_SYSTEM_PROMPT);
    const base = {
      toolName: "run_terminal_command",
      args: { command: "ls" },
      history: { userMessages: ["x"], toolCalls: [] },
      environment: {},
      nonce: "0".repeat(16),
    };
    expect(buildReviewMessages(base)[0].content).toBe(REVIEWER_SYSTEM_PROMPT);
  });
});

describe("the v3 prompt", () => {
  it("keeps the evidence rules and the category list word for word", () => {
    const evidence = (t: string) =>
      t.slice(0, t.search(/Two scores|Check the categories first/));
    expect(evidence(REVIEWER_SYSTEM_PROMPT_V3)).toBe(
      evidence(REVIEWER_SYSTEM_PROMPT),
    );
    const cats = (t: string) =>
      t.slice(
        t.indexOf('Answer "deny" only for a category'),
        t.indexOf("Reply with one JSON"),
      );
    expect(cats(REVIEWER_SYSTEM_PROMPT_V3)).toBe(cats(REVIEWER_SYSTEM_PROMPT));
  });

  it("puts the category check first", () => {
    const scoring = segment(
      REVIEWER_SYSTEM_PROMPT_V3,
      "Check the categories first",
      'Answer "deny"',
    );
    expect(scoring).toMatch(/^Check the categories first/);
    expect(scoring.indexOf("1. Categories")).toBeLessThan(
      scoring.indexOf("2. Risk"),
    );
    expect(scoring).toContain('"category" must name it');
    expect(scoring).toContain('write "category": "none"');
  });

  it("scores high authorisation only when the words name the target and the operation", () => {
    expect(REVIEWER_SYSTEM_PROMPT_V3).toContain(
      "high only when the person's own words name both the target and the operation",
    );
    expect(REVIEWER_SYSTEM_PROMPT_V3).toContain(
      "does not authorise a method that uses sudo, leaves the workspace",
    );
  });

  it("allows medium risk only with high authorisation and a target inside the workspace", () => {
    expect(REVIEWER_SYSTEM_PROMPT_V3).toContain(
      'Medium risk is "allow" only with high authorisation and a target inside the workspace',
    );
    expect(REVIEWER_SYSTEM_PROMPT_V3).not.toContain(
      'low or medium risk is "allow"',
    );
    expect(REVIEWER_SYSTEM_PROMPT).toContain('low or medium risk is "allow"');
  });

  it("asks for a category of none on an allow", () => {
    expect(REVIEWER_SYSTEM_PROMPT_V3).toContain(
      '"category": "<one id from the list, or none for allow>"',
    );
    expect(REVIEWER_SYSTEM_PROMPT_V3).not.toContain("omit for allow");
  });

  it("has its own audit id, different from the default's", () => {
    const v3 = reviewerPromptVersion(
      undefined,
      undefined,
      REVIEWER_SYSTEM_PROMPT_V3,
    );
    expect(v3).toMatch(/^[0-9a-f]{12}$/);
    expect(v3).not.toBe(reviewerPromptVersion());
    // golden: a change to the v3 text is a new prompt version
    expect(v3).toBe("8507fda67807");
  });

  it("is sent only when asked for", () => {
    const base = {
      toolName: "run_terminal_command",
      args: { command: "ls" },
      history: { userMessages: ["x"], toolCalls: [] },
      environment: {},
      nonce: "0".repeat(16),
    };
    expect(
      buildReviewMessages({ ...base, systemPrompt: promptText("v3") })[0]
        .content,
    ).toBe(REVIEWER_SYSTEM_PROMPT_V3);
  });

  it("reads anything but v3 as the default", () => {
    expect(sanitizePromptVariant("v3")).toBe("v3");
    for (const raw of [undefined, "", "V3", "v4", 3, null, {}]) {
      expect(sanitizePromptVariant(raw)).toBe("default");
    }
  });
});

describe("an allow under v3 must say that no category applies", () => {
  const strict = { allowNeedsNone: true };
  it.each([
    '{"decision":"allow","risk":"low","authorization":"high","reason":"fine"}',
    '{"decision":"allow","category":null,"reason":"fine"}',
    '{"decision":"allow","category":"","reason":"fine"}',
    '{"decision":"allow","category":"uncertain","reason":"fine"}',
  ])("turns %s into an ask", (reply) => {
    expect(parseReviewerReply(reply, strict)).toMatchObject({
      decision: "ask",
      category: "uncertain",
    });
  });

  it("keeps an allow with category none", () => {
    expect(
      parseReviewerReply(
        '{"decision":"allow","category":"none","reason":"Runs the tests."}',
        strict,
      ),
    ).toEqual({ decision: "allow", reason: "Runs the tests." });
  });

  it("leaves the default reading alone: an allow with no category is an allow", () => {
    expect(
      parseReviewerReply('{"decision":"allow","category":null,"reason":"ok"}')
        .decision,
    ).toBe("allow");
  });

  it("never changes an ask or a deny", () => {
    const ask =
      '{"decision":"ask","category":"outside-workspace","reason":"r"}';
    expect(parseReviewerReply(ask, strict)).toEqual(parseReviewerReply(ask));
    const deny =
      '{"decision":"deny","category":"credential-access","reason":"r"}';
    expect(parseReviewerReply(deny, strict)).toEqual(parseReviewerReply(deny));
  });

  it("applies to the call the reviewer makes only under v3", async () => {
    const llm = {
      chat: async () =>
        ({
          role: "assistant",
          content: '{"decision":"allow","category":null,"reason":"ok"}',
        }) as never,
    };
    const input = {
      toolName: "run_terminal_command",
      args: { command: "npm test" },
      history: { userMessages: ["run the tests"], toolCalls: [] },
      environment: {},
    };
    expect((await reviewToolCall(llm, input)).decision).toBe("allow");
    expect(
      (await reviewToolCall(llm, input, { promptVariant: "v3" })).decision,
    ).toBe("ask");
  });
});

function setup(over: Partial<AutoReviewDeps> = {}) {
  const chat = vi.fn(
    async (..._args: unknown[]) =>
      ({
        role: "assistant",
        content:
          '{"decision":"allow","category":"none","reason":"Runs tests."}',
      }) as any,
  );
  const deps: AutoReviewDeps = {
    tool: {
      group: "Built-In",
      evaluateToolCallPolicy: (base: any, args: Record<string, unknown>) =>
        evaluateTerminalCommandSecurity(base, args.command as string),
    } as any,
    permissions: undefined,
    enabled: true,
    reviewer: { chat } as any,
    environment: {},
    sessions: new AutoReviewSessions(),
    ...over,
  };
  return { chat, deps };
}
const run = (deps: AutoReviewDeps, sessionId = "s") =>
  autoReviewToolCall(deps, {
    sessionId,
    toolName: "run_terminal_command",
    basePolicy: "allowedWithPermission",
    parsedArgs: { command: "npm test" },
    history: { userMessages: ["run the tests"], toolCalls: [] },
  });

describe("the handler and the setting", () => {
  it("sends the shipped prompt by default and records its version", async () => {
    const { chat, deps } = setup();
    const r = await run(deps);
    expect((chat.mock.calls[0][0] as any[])[0].content).toBe(
      REVIEWER_SYSTEM_PROMPT,
    );
    expect(r.reviewer?.promptVersion).toBe(reviewerPromptVersion());
  });

  it("sends v3 when the setting says v3 and records v3's version", async () => {
    const { chat, deps } = setup({ reviewerPrompt: "v3" });
    const r = await run(deps);
    expect((chat.mock.calls[0][0] as any[])[0].content).toBe(
      REVIEWER_SYSTEM_PROMPT_V3,
    );
    expect(r.decision).toBe("allow");
    expect(r.reviewer?.promptVersion).toBe(
      reviewerPromptVersion(undefined, undefined, REVIEWER_SYSTEM_PROMPT_V3),
    );
  });

  it("does not reuse a verdict across prompt variants", async () => {
    const sessions = new AutoReviewSessions();
    const a = setup({ sessions });
    await run(a.deps);
    const b = setup({ sessions, reviewerPrompt: "v3" });
    const r = await run(b.deps);
    expect(b.chat).toHaveBeenCalledTimes(1);
    expect(r.cached).toBeUndefined();
  });

  it("asks when v3's model allows without naming none", async () => {
    const { deps } = setup({ reviewerPrompt: "v3" });
    (deps.reviewer as any).chat = async () => ({
      role: "assistant",
      content: '{"decision":"allow","risk":"low","reason":"fine"}',
    });
    expect((await run(deps)).decision).toBe("ask");
  });

  it("turns a model allow of sudo into an ask in the handler, on either prompt", async () => {
    for (const reviewerPrompt of [undefined, "v3"] as const) {
      const { deps } = setup({
        reviewerPrompt,
        environment: { workspaceDirs: ["file:///home/dev/shop"] },
      });
      const r = await autoReviewToolCall(deps, {
        sessionId: `s-${reviewerPrompt}`,
        toolName: "run_terminal_command",
        basePolicy: "allowedWithPermission",
        parsedArgs: { command: "sudo apt-get install -y libfoo-dev" },
        history: { userMessages: ["Install a package"], toolCalls: [] },
      });
      // the rules engine may settle it first; either way it is not an allow
      expect(r.decision).not.toBe("allow");
    }
  });
});

describe("the setting is read from the person's own config only", () => {
  const withFile = (text: string | undefined, f: (file: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "rp-"));
    const file = join(dir, "config.yaml");
    try {
      if (text !== undefined) writeFileSync(file, text);
      f(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("is off with no file, a bad value or no key", () => {
    withFile(undefined, (f) =>
      expect(readUserReviewerPrompt(f)).toBe("default"),
    );
    withFile("toolPermissions:\n  auto:\n    reviewerPrompt: v9\n", (f) =>
      expect(readUserReviewerPrompt(f)).toBe("default"),
    );
    withFile("name: x\n", (f) =>
      expect(readUserReviewerPrompt(f)).toBe("default"),
    );
    withFile(": : :\n\t-", (f) =>
      expect(readUserReviewerPrompt(f)).toBe("default"),
    );
  });

  it("turns on with reviewerPrompt: v3", () => {
    withFile("toolPermissions:\n  auto:\n    reviewerPrompt: v3\n", (f) =>
      expect(readUserReviewerPrompt(f)).toBe("v3"),
    );
  });
});
