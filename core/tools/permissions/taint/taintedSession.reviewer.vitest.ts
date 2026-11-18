import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { evaluateTerminalCommandSecurity } from "@continuedev/terminal-security";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autoReviewToolCall, type AutoReviewDeps } from "../auto/handler";
import { buildReviewMessages } from "../auto/prompt";
import { AutoReviewSessions } from "../auto/state";
import { DEFAULT_POLICY_LEVELS } from "../policy";
import { taintRegistry } from "./taintState";

let dir = "";
let stamp = 0;
vi.mock("../../../util/paths", async (orig) => ({
  ...(await orig<typeof import("../../../util/paths")>()),
  getContinueGlobalPath: () => dir,
}));

function setRule(rule: string) {
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(
    file,
    `name: u\nversion: 1.0.0\ntoolPermissions:\n  auto:\n    environment:\n      taintedSessionRule: ${rule}\n`,
  );
  const when = new Date(Date.now() + 10_000 * ++stamp);
  fs.utimesSync(file, when, when);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "taint-rev-"));
  taintRegistry.reset();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const allow = JSON.stringify({ decision: "allow", reason: "Runs the tests." });
const stubLlm = () => ({
  chat: vi.fn(async () => ({ role: "assistant", content: allow }) as never),
});
const terminalTool = {
  group: "Built-In",
  evaluateToolCallPolicy: (base: never, args: Record<string, unknown>) =>
    evaluateTerminalCommandSecurity(base, args.command as string),
} as never;
const history = { userMessages: ["push the branch"], toolCalls: [] };
const approval = {
  levels: { ...DEFAULT_POLICY_LEVELS, tools: "automatic" as const },
};

function review(
  command: string,
  session: string,
  sessions = new AutoReviewSessions(),
) {
  const llm = stubLlm();
  const deps: AutoReviewDeps = {
    tool: terminalTool,
    permissions: undefined,
    enabled: true,
    reviewer: llm as never,
    environment: {},
    sessions,
  };
  return {
    llm,
    result: autoReviewToolCall(deps, {
      sessionId: session,
      toolName: "run_terminal_command",
      basePolicy: "allowedWithPermission",
      parsedArgs: { command },
      history,
      approval,
    }),
  };
}

describe("the tainted-session rule and the Auto reviewer", () => {
  it("rule off: the reviewer judges a push as before", async () => {
    taintRegistry.mark("s", "web-fetch");
    const { llm, result } = review("git push origin main", "s");
    expect(await result).toMatchObject({ decision: "allow", by: "reviewer" });
    expect(llm.chat).toHaveBeenCalledTimes(1);
  });

  it("rule on: a sink in a tainted session is the person's, not the reviewer's", async () => {
    setRule("ask");
    taintRegistry.mark("s", "web-fetch");
    const { llm, result } = review("git push origin main", "s");
    expect(await result).toMatchObject({
      decision: "ask",
      by: "rules",
      ruleSource: "tainted-session",
    });
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it("rule on, session clean: the reviewer decides as before", async () => {
    setRule("ask");
    const { result } = review("git push origin main", "clean");
    expect(await result).toMatchObject({ decision: "allow", by: "reviewer" });
  });

  it("rule on: a call that is not a sink still goes to the reviewer, with the taint fact as context", async () => {
    setRule("ask");
    taintRegistry.mark("s", "mcp-result", 3);
    const { llm, result } = review("npm test", "s");
    expect(await result).toMatchObject({ decision: "allow", by: "reviewer" });
    const sent = (
      llm.chat.mock.calls[0] as unknown as [{ content: string }[]]
    )[0];
    const user = sent[1].content;
    expect(user).toContain("Session taint: untrusted content entered");
    expect(user).toContain("mcp-result");
    expect(user).toContain("from turn 3");
  });

  it("a verdict cached under one taint state is not reused under another", async () => {
    setRule("ask");
    const sessions = new AutoReviewSessions();
    const clean = review("npm test", "s", sessions);
    await clean.result;
    expect(clean.llm.chat).toHaveBeenCalledTimes(1);
    taintRegistry.mark("s", "web-fetch");
    const tainted = review("npm test", "s", sessions);
    expect(await tainted.result).toMatchObject({ by: "reviewer" });
    expect(tainted.llm.chat).toHaveBeenCalledTimes(1);
    const again = review("npm test", "s", sessions);
    expect(await again.result).toMatchObject({ cached: true });
    expect(again.llm.chat).not.toHaveBeenCalled();
  });

  it("the prompt has no taint line without the fact", () => {
    const messages = buildReviewMessages({
      toolName: "run_terminal_command",
      args: { command: "npm test" },
      history,
      environment: { os: "linux" },
      nonce: "n",
    });
    expect(messages[1].content).not.toContain("Session taint");
  });
});
