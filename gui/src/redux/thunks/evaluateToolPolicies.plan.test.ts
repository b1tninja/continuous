import { describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY_LEVELS } from "core/tools/permissions/policy";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import {
  evaluateToolPolicies,
  evaluateToolPolicy,
  PLAN_MODE_HOLD_REASON,
} from "./evaluateToolPolicies";

const ASK = "allowedWithPermission" as const;
const ALLOW = "allowedWithoutPermission" as const;
const OFF = "disabled" as const;

function call(name: string) {
  return {
    toolCallId: `id-${name}`,
    toolCall: {
      id: "x",
      type: "function",
      function: { name, arguments: "{}" },
    },
    parsedArgs: {},
    status: "generated",
  } as any;
}

const mcpTool = {
  function: { name: "github_create_issue" },
  group: "github",
  readonly: false,
} as any;
const readTool = {
  function: { name: "read_file" },
  group: "Built-In",
  readonly: true,
} as any;

async function run(
  name: string,
  reply: any,
  mode: "plan" | "agent",
  { auto = false, toolPolicies = {} as Record<string, any> } = {},
) {
  const ide = new MockIdeMessenger();
  ide.responseHandlers["tools/evaluatePolicy"] = async () => reply;
  const review = vi.fn(async () => ({
    decision: "allow",
    by: "model",
    reason: "looks fine",
  }));
  ide.responseHandlers["tools/autoReview"] = review as any;
  const dispatch = vi.fn();
  const [result] = await evaluateToolPolicies(
    dispatch as any,
    ide,
    [mcpTool, readTool],
    [call(name)],
    toolPolicies,
    auto
      ? { sessionId: "s", history: { userMessages: [], toolCalls: [] } }
      : undefined,
    undefined,
    mode,
  );
  return { result, dispatch, review };
}

describe("Plan mode holds tools that may make changes", () => {
  it("asks before an MCP tool set to run on its own", async () => {
    const { result, dispatch } = await run(
      "github_create_issue",
      { policy: ALLOW },
      "plan",
      { toolPolicies: { github_create_issue: ALLOW } },
    );
    expect(result.policy).toBe(ASK);
    expect(result.source).toBe("plan-mode");
    // The prompt says why a tool set to run on its own is waiting
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ note: PLAN_MODE_HOLD_REASON }),
      }),
    );
  });

  it("asks even when the user's allow rule or approval mode allowed it", async () => {
    for (const source of ["allow-rule", "permissive"]) {
      const { result } = await run(
        "github_create_issue",
        { policy: ALLOW, source },
        "plan",
        { toolPolicies: { github_create_issue: ALLOW } },
      );
      expect(result.policy).toBe(ASK);
    }
  });

  async function planCall(level: "permissive" | "idgaf") {
    const ide = new MockIdeMessenger();
    ide.responseHandlers["tools/evaluatePolicy"] = async () =>
      ({ policy: ALLOW, source: level }) as any;
    return evaluateToolPolicy(
      ide,
      [mcpTool],
      call("github_create_issue"),
      { github_create_issue: ALLOW },
      { levels: { ...DEFAULT_POLICY_LEVELS, tools: level } },
      "plan",
    );
  }

  it("IDGAF runs it: the level says everything runs", async () => {
    const result = await planCall("idgaf");
    expect(result.policy).toBe(ALLOW);
    expect(result.source).toBe("idgaf");
  });

  it("Permissive does not lift it: Plan mode changes nothing below IDGAF", async () => {
    const result = await planCall("permissive");
    expect(result.policy).toBe(ASK);
    expect(result.source).toBe("plan-mode");
  });

  it("leaves the hold to the user, not the Auto reviewer", async () => {
    const { result, review } = await run(
      "github_create_issue",
      { policy: ALLOW },
      "plan",
      { auto: true, toolPolicies: { github_create_issue: ALLOW } },
    );
    expect(result.policy).toBe(ASK);
    expect(review).not.toHaveBeenCalled();
  });

  it("lets read-only tools run on their own", async () => {
    const { result } = await run("read_file", { policy: ALLOW }, "plan", {
      toolPolicies: { read_file: ALLOW },
    });
    expect(result.policy).toBe(ALLOW);
  });

  it("keeps refusals", async () => {
    const { result } = await run(
      "github_create_issue",
      { policy: OFF, source: "deny-rule" },
      "plan",
    );
    expect(result.policy).toBe(OFF);
  });

  it("changes nothing outside Plan mode", async () => {
    const { result } = await run(
      "github_create_issue",
      { policy: ALLOW },
      "agent",
      { toolPolicies: { github_create_issue: ALLOW } },
    );
    expect(result.policy).toBe(ALLOW);
  });
});

describe("a command the parser vouched as only reading, in Plan mode", () => {
  it("runs: that is how a re-plan looks at the repository", async () => {
    const terminal = {
      ...mcpTool,
      function: { ...mcpTool.function, name: "run_terminal_command" },
    } as any;
    const ide = new MockIdeMessenger();
    ide.responseHandlers["tools/evaluatePolicy"] = async () =>
      ({
        policy: ALLOW,
        source: "permissive",
        readOnly: "only reads: ls",
      }) as any;
    const result = await evaluateToolPolicy(
      ide,
      [terminal],
      call("run_terminal_command"),
      { run_terminal_command: ALLOW },
      undefined,
      "plan",
    );
    expect(result.policy).toBe(ALLOW);
    expect(result.readOnly).toBe("only reads: ls");
  });

  it("a command that may write still waits", async () => {
    const terminal = {
      ...mcpTool,
      function: { ...mcpTool.function, name: "run_terminal_command" },
    } as any;
    const ide = new MockIdeMessenger();
    ide.responseHandlers["tools/evaluatePolicy"] = async () =>
      ({ policy: ALLOW, source: "permissive" }) as any;
    const result = await evaluateToolPolicy(
      ide,
      [terminal],
      call("run_terminal_command"),
      { run_terminal_command: ALLOW },
      undefined,
      "plan",
    );
    expect(result.policy).toBe(ASK);
    expect(result.source).toBe("plan-mode");
  });
});
