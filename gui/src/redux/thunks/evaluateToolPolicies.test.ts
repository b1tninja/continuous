import { describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { evaluateToolPolicies, refusalMessage } from "./evaluateToolPolicies";

const ASK = "allowedWithPermission" as const;
const ALLOW = "allowedWithoutPermission" as const;
const OFF = "disabled" as const;

function call(name: string, parsedArgs: Record<string, unknown> = {}) {
  return {
    toolCallId: `id-${name}`,
    toolCall: {
      id: "x",
      type: "function",
      function: { name, arguments: "{}" },
    },
    parsedArgs,
    status: "generated",
  } as any;
}

async function run(
  name: string,
  reply: any,
  toolPolicies: Record<string, any> = {},
  activeTools: any[] = [],
) {
  const ide = new MockIdeMessenger();
  ide.responseHandlers["tools/evaluatePolicy"] = async () => reply;
  const dispatch = vi.fn();
  const [result] = await evaluateToolPolicies(
    dispatch as any,
    ide,
    activeTools,
    [call(name)],
    toolPolicies,
  );
  return { result, dispatch };
}

describe("refusalMessage", () => {
  it("names the user's rule and tells the model not to route around it", () => {
    const m = refusalMessage(
      "terraform apply",
      "deny-rule",
      "Blocked by your rule runTerminalCommand(terraform apply*).",
    );
    expect(m.description).toBe("Blocked by your rule");
    expect(m.content).toContain("runTerminalCommand(terraform apply*)");
    expect(m.content).toContain("terraform apply");
    expect(m.content).toMatch(/Do not retry/);
  });

  it("passes a shell-hint parse failure through, and does not say to stop", () => {
    const reason =
      "The command was not run: Windows PowerShell 5.1 cannot parse it. && is not a statement separator in Windows PowerShell 5.1: the whole command fails to parse and nothing runs. Instead: echo A; if ($?) { echo B } Fix it and call again.";
    const m = refusalMessage("echo A && echo B", "shell-hint", reason);
    expect(m.description).toBe("Command was not run");
    expect(m.content).toBe(reason);
    expect(m.content).toContain("Instead:");
    expect(m.content).toContain("Fix it and call again");
    expect(m.content).toContain("Windows PowerShell 5.1");
    expect(m.content).not.toMatch(/security policy/i);
    expect(m.content).not.toMatch(/Do not retry/);
  });

  it("says a tool was turned off by the user", () => {
    const m = refusalMessage("run_terminal_command", "tool-setting", undefined);
    expect(m.description).toBe("Tool turned off");
    expect(m.content).toMatch(/turned off/);
  });

  it("names the safety floor for it and for no source, and says to carry on", () => {
    for (const source of ["safety-floor", undefined] as const) {
      const m = refusalMessage("rm -rf /", source, undefined);
      expect(m.description).toBe("Command Disabled");
      expect(m.content).toContain("disabled by security policy");
      expect(m.content).toMatch(/Do what else the request needs/);
    }
  });

  it("never tells the model to stop and ask: the refusal cap decides that", () => {
    for (const source of [
      "deny-rule",
      "tool-setting",
      "auto",
      undefined,
    ] as const) {
      const m = refusalMessage("x", source, "why");
      expect(m.content).not.toMatch(/ask how they want to proceed/);
      expect(m.content).toMatch(/say what you could not do/);
    }
  });
});

describe("evaluateToolPolicies: rules from core", () => {
  it("an allow rule may loosen a tool set to ask (the user chose it)", async () => {
    const { result } = await run(
      "run_terminal_command",
      {
        policy: ALLOW,
        source: "allow-rule",
        rule: "runTerminalCommand(npm test*)",
      },
      { run_terminal_command: ASK },
    );
    expect(result.policy).toBe(ALLOW);
  });

  it("without an allow-rule source, a tool set to ask is still not loosened", async () => {
    const { result } = await run(
      "run_terminal_command",
      { policy: ALLOW },
      { run_terminal_command: ASK },
    );
    expect(result.policy).toBe(ASK);
  });

  it("a tool switched off stays off even if core says allow", async () => {
    const { result } = await run(
      "run_terminal_command",
      { policy: ALLOW, source: "allow-rule" },
      { run_terminal_command: OFF },
    );
    expect(result.policy).toBe(OFF);
  });

  it("a deny rule errors the call and shows the rule, not the generic text", async () => {
    const { result, dispatch } = await run("run_terminal_command", {
      policy: OFF,
      source: "deny-rule",
      reason: "Blocked by your rule runTerminalCommand(rm*).",
      displayValue: "rm -rf build",
    });
    expect(result.policy).toBe(OFF);
    const text = JSON.stringify(dispatch.mock.calls);
    expect(text).toContain("Blocked by your rule runTerminalCommand(rm*).");
    expect(text).toContain("rm -rf build");
    expect(text).not.toContain("may pose a security risk");
  });
});

describe("evaluateToolPolicies: notes for calls that wait", () => {
  it("records the reason for a protected-path wait and an ask rule", async () => {
    for (const source of ["protected-path", "ask-rule"] as const) {
      const { dispatch } = await run("read_file", {
        policy: ASK,
        source,
        reason: `because ${source}`,
      });
      expect(JSON.stringify(dispatch.mock.calls)).toContain(
        `because ${source}`,
      );
    }
  });

  it("records nothing for an ordinary wait or a refusal", async () => {
    for (const reply of [
      { policy: ASK, source: "tool-setting", reason: "x" },
      { policy: OFF, source: "deny-rule", reason: "y" },
    ]) {
      const { dispatch } = await run("read_file", reply);
      expect(JSON.stringify(dispatch.mock.calls)).not.toContain("policyNote");
      expect(JSON.stringify(dispatch.mock.calls)).not.toContain(
        "setToolCallPolicyNote",
      );
    }
  });
});

describe("evaluateToolPolicies: edit tools", () => {
  it("are still allowed without asking when no rule objects", async () => {
    const { result } = await run("edit_existing_file", {
      policy: ALLOW,
    });
    expect(result.policy).toBe(ALLOW);
  });

  it("an ordinary ask or allow rule on an edit does not change the diff review flow", async () => {
    for (const reply of [
      { policy: ASK, source: "ask-rule" },
      { policy: ALLOW, source: "allow-rule" },
    ]) {
      const { result } = await run("multi_edit", reply);
      expect(result.policy).toBe(ALLOW);
    }
  });

  it("an edit to a protected file is held for approval, not applied on diff", async () => {
    const { result } = await run("edit_existing_file", {
      policy: ASK,
      source: "protected-path",
      reason:
        "This touches .github/workflows/ci.yml, which can change what runs later, so it always asks first.",
    });
    expect(result.policy).toBe(ASK);
    expect(result.source).toBe("protected-path");
  });

  it("the protected reason survives, so the prompt can show it", async () => {
    const { result } = await run("create_new_file", {
      policy: ASK,
      source: "protected-path",
      reason: "touches .env",
    });
    expect(result.reason).toBe("touches .env");
  });

  it("a deny rule refuses an edit and says which rule", async () => {
    const { result, dispatch } = await run("create_new_file", {
      policy: OFF,
      source: "deny-rule",
      reason: "Blocked by your rule writeFile(.github/**).",
    });
    expect(result.policy).toBe(OFF);
    expect(JSON.stringify(dispatch.mock.calls)).toContain(
      "writeFile(.github/**)",
    );
  });

  it("if core cannot be reached, the edit waits instead of being applied", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ide = new MockIdeMessenger();
    ide.responseHandlers["tools/evaluatePolicy"] = async () => {
      throw new Error("down");
    };
    const [result] = await evaluateToolPolicies(
      vi.fn() as any,
      ide,
      [],
      [call("edit_existing_file")],
      {},
    );
    expect(result.policy).toBe(ASK);
    expect(result.reason).toMatch(/waits for you/);
    spy.mockRestore();
  });

  it("a request that returns an error status also holds the edit", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ide = new MockIdeMessenger();
    vi.spyOn(ide, "request").mockResolvedValue({
      status: "error",
      error: "nope",
    } as any);
    const [result] = await evaluateToolPolicies(
      vi.fn() as any,
      ide,
      [],
      [call("single_find_and_replace")],
      {},
    );
    expect(result.policy).toBe(ASK);
    expect(result.reason).toMatch(/waits for you/);
    spy.mockRestore();
  });
});
