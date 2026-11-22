import fs from "fs";
import os from "os";
import path from "path";

import { evaluateTerminalCommandSecurity } from "@continuedev/terminal-security";
import { evaluateToolPolicyWithRules } from "core/tools/permissions/evaluate";
import { PLAN_MODE_HOLD_REASON } from "core/tools/permissions/planMode";
import { POLICY_PRESETS } from "core/tools/permissions/policy";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { newSession } from "../slices/sessionSlice";
import { setPolicyExtras, setPolicyLevels } from "../slices/uiSlice";
import { setupStore } from "../store";
import { findToolCallById } from "../util";

import { evaluateToolPolicies } from "./evaluateToolPolicies";
import { holdForHeadsUp } from "./headsUp";

/**
 * IDGAF is the top level, and its heads-up window is 0 unless set. With a
 * window, a call it ran past an ask or a refusal is held for a countdown; a
 * call that would have run at a lower level is not delayed.
 *
 * The decisions here are the engine's own: the mock host runs core's
 * evaluator, as the editor's host does.
 */
const IDGAF = POLICY_PRESETS.idgaf.levels;
const ALLOW = "allowedWithoutPermission" as const;

const terminalTool = {
  group: "Built-In",
  function: { name: "run_terminal_command" },
  evaluateToolCallPolicy: (base: any, args: Record<string, unknown>) =>
    evaluateTerminalCommandSecurity(base, args.command as string),
} as any;
const editTool = {
  group: "Built-In",
  function: { name: "create_new_file" },
  evaluateToolCallPolicy: (base: any) => base,
} as any;

// git is vouched as read-only only in a repository whose config runs nothing
let repo: string;
beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "idgaf-window-"));
  fs.mkdirSync(path.join(repo, ".git"));
  fs.writeFileSync(
    path.join(repo, ".git", "config"),
    "[core]\n\tbare = false\n",
  );
  vi.stubEnv("GIT_CONFIG_GLOBAL", path.join(repo, "no-global-config"));
  vi.stubEnv("GIT_CONFIG_SYSTEM", path.join(repo, "no-system-config"));
  vi.stubEnv("GIT_CONFIG_COUNT", "0");
});
afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(repo, { recursive: true, force: true });
});

const terminal = (id: string, command: string) =>
  ({
    toolCallId: id,
    toolCall: {
      id,
      type: "function",
      function: { name: "run_terminal_command", arguments: "{}" },
    },
    parsedArgs: { command },
    status: "generated",
  }) as any;

const edit = (id: string, filepath: string) =>
  ({
    toolCallId: id,
    toolCall: {
      id,
      type: "function",
      function: { name: "create_new_file", arguments: "{}" },
    },
    parsedArgs: { filepath, contents: "x" },
    processedArgs: {
      resolvedPath: {
        uri: `file://${filepath}`,
        isWithinWorkspace: filepath.startsWith("/w/"),
      },
    },
    status: "generated",
  }) as any;

function setup(
  calls: any[],
  opts: { headsUp?: Record<string, number>; ask?: string[] } = {},
) {
  const ideMessenger = new MockIdeMessenger();
  ideMessenger.responseHandlers["tools/evaluatePolicy"] = (async (data: any) =>
    evaluateToolPolicyWithRules({
      tool: data.toolName === "run_terminal_command" ? terminalTool : editTool,
      toolName: data.toolName,
      basePolicy: data.basePolicy,
      parsedArgs: data.parsedArgs,
      processedArgs: data.processedArgs,
      permissions: opts.ask ? { ask: opts.ask } : undefined,
      approval: data.approval,
      cwd: repo,
      shell: "bash",
      ...(data.planMode ? { planMode: true } : {}),
    })) as never;
  const store = setupStore({ ideMessenger });
  store.dispatch(
    newSession({
      sessionId: "s",
      title: "t",
      workspaceDirectory: "",
      history: [
        {
          message: { role: "assistant", content: "" },
          contextItems: [],
          toolCallStates: calls,
        },
      ],
    } as any),
  );
  store.dispatch(setPolicyLevels({ ...IDGAF }));
  if (opts.headsUp) {
    store.dispatch(setPolicyExtras({ headsUp: opts.headsUp as never }));
  }
  return { store, ideMessenger };
}

/** The policy check and then the heads-up, as a turn does them. */
async function decide(
  s: ReturnType<typeof setup>,
  calls: any[],
  mode: "plan" | "agent",
  state: any = s.store.getState(),
) {
  const policies = await evaluateToolPolicies(
    s.store.dispatch,
    s.ideMessenger,
    [terminalTool, editTool],
    calls,
    {},
    undefined,
    { levels: IDGAF },
    mode,
    "s",
  );
  const held = holdForHeadsUp(
    state,
    s.store.dispatch,
    policies.filter((p) => p.policy === ALLOW),
  );
  return { policies, held };
}

const timerOf = (s: ReturnType<typeof setup>, id: string) =>
  findToolCallById(s.store.getState().session.history, id)?.askTimer;

describe("IDGAF with its heads-up window at 0, the default", () => {
  it("delays nothing in Plan mode: the call runs at once", async () => {
    const calls = [terminal("a", "mkdir x")];
    const s = setup(calls);
    const { policies, held } = await decide(s, calls, "plan");
    expect(policies[0].policy).toBe(ALLOW);
    expect(policies[0].idgafOverride?.source).toBe("plan-mode");
    expect(held.size).toBe(0);
    expect(timerOf(s, "a")).toBeUndefined();
  });

  it("a window set for another level changes nothing at IDGAF", async () => {
    const calls = [terminal("a", "mkdir x")];
    const s = setup(calls, { headsUp: { permissive: 5, cautious: 10 } });
    expect((await decide(s, calls, "plan")).held.size).toBe(0);
  });
});

describe("IDGAF with a heads-up window of 5 s", () => {
  const headsUp = { idgaf: 5 };

  it("in Plan mode, a command that changes things is held, with Plan mode's reason", async () => {
    const calls = [terminal("a", "mkdir x")];
    const s = setup(calls, { headsUp });
    const { held } = await decide(s, calls, "plan");
    expect([...held]).toEqual(["a"]);
    expect(timerOf(s, "a")).toMatchObject({
      seconds: 5,
      proposed: "allow",
      override: {
        policy: "allowedWithPermission",
        source: "plan-mode",
        reason: PLAN_MODE_HOLD_REASON,
      },
    });
  });

  it("a command that only reads would run below IDGAF too, so it is not delayed", async () => {
    const calls = [terminal("a", "git log")];
    const s = setup(calls, { headsUp });
    const { policies, held } = await decide(s, calls, "plan");
    expect(policies[0].policy).toBe(ALLOW);
    expect(held.size).toBe(0);
    expect(timerOf(s, "a")).toBeUndefined();
  });

  it("outside Plan mode, a command nothing would have stopped is not delayed", async () => {
    const calls = [terminal("a", "mkdir x")];
    const s = setup(calls, { headsUp });
    expect((await decide(s, calls, "agent")).held.size).toBe(0);
  });

  it("outside Plan mode, an edit an ask rule covers is held, and a plain edit is not", async () => {
    const calls = [edit("a", "/w/secret/a.ts"), edit("b", "/w/src/a.ts")];
    const s = setup(calls, { headsUp, ask: ["writeFile(**/secret/**)"] });
    const { held } = await decide(s, calls, "agent");
    expect([...held]).toEqual(["a"]);
    expect(timerOf(s, "a")?.override).toMatchObject({
      policy: "allowedWithPermission",
      source: "ask-rule",
    });
  });

  it("outside Plan mode, an edit of the policy file is held: below IDGAF it is refused", async () => {
    const calls = [edit("a", "/home/me/.continue/permissions.yaml")];
    const s = setup(calls, { headsUp });
    const { held } = await decide(s, calls, "agent");
    expect([...held]).toEqual(["a"]);
    expect(timerOf(s, "a")?.override?.policy).toBe("disabled");
  });

  it("an unattended Loop run has nobody to show it to: no window", async () => {
    const calls = [terminal("a", "mkdir x")];
    const s = setup(calls, { headsUp });
    const state = s.store.getState() as any;
    const looped = {
      ...state,
      session: { ...state.session, loop: { current: { id: "run" } } },
    };
    expect((await decide(s, calls, "plan", looped)).held.size).toBe(0);
  });
});
