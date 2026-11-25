import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateTerminalCommandSecurity } from "@continuedev/terminal-security";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateToolPolicyWithRules } from "../evaluate";
import { POLICY_PRESETS } from "../policy";
import { builtinForPreset } from "../safetyDegrees";
import { updateIndex } from "./auditIndex";
import {
  decisionEvent,
  jsonl,
  resetSeq,
  sessionFile,
  T0,
} from "./auditIndexFixtures";
import { auditOverview } from "./overviewHandler";
import { recordPolicyDecision } from "./hook";
import { decisionDraft } from "./record";

/**
 * Audit lines written by earlier versions carry `wouldHave`: the objection a
 * call was run past. Nothing writes it now (a check that is off does not run,
 * so there is nothing to record), but the line is still read, masked, indexed
 * and counted as a 30-day figure on the Permissions page's audit overview.
 */
const terminalTool = {
  group: "Built-In",
  evaluateToolCallPolicy: (base: any, args: Record<string, unknown>) =>
    evaluateTerminalCommandSecurity(base, args.command as string),
};
const FAKE = "sk-abcdefghijklmnopqrstuvwxyz0123456789";

const decide = (
  command: string,
  floor: string[] = [],
  builtin?: Record<string, boolean>,
) =>
  evaluateToolPolicyWithRules({
    tool: terminalTool as any,
    toolName: "run_terminal_command",
    basePolicy: "allowedWithPermission",
    parsedArgs: { command },
    permissions: undefined,
    shell: "bash",
    approval: {
      levels: POLICY_PRESETS.idgaf.levels,
      floor,
      ...(builtin ? { builtin } : {}),
    },
  });

const fakeTrail = () => ({
  enabled: true,
  decision: vi.fn(),
  answer: vi.fn(),
  outcome: vi.fn(),
});

describe("the decision line no longer records what a call ran past", () => {
  const record = (result: ReturnType<typeof decide>, callId: string) => {
    const trail = fakeTrail();
    recordPolicyDecision(
      trail as any,
      {
        session: "s",
        callId,
        toolName: "run_terminal_command",
        parsedArgs: {},
      },
      "allowedWithPermission",
      result,
    );
    return { trail, line: trail.decision.mock.calls[0][0] };
  };

  it("a floor rule that is read stops the call, and that is the decision", () => {
    const result = decide("terraform destroy", [
      "runTerminalCommand(terraform destroy*)",
    ]);
    expect(result.policy).toBe("disabled");
    const { line } = record(result, "c1");
    expect(line).toMatchObject({ policy: "deny", source: "floor" });
    expect(line.wouldHave).toBeUndefined();
  });

  it("with the preset's switches the rule is not read: the call runs and nothing is recorded", () => {
    const result = decide(
      "terraform destroy",
      ["runTerminalCommand(terraform destroy*)"],
      builtinForPreset("idgaf"),
    );
    expect(result.policy).toBe("allowedWithoutPermission");
    const { line, trail } = record(result, "c1b");
    expect(line).toMatchObject({ policy: "allow" });
    expect(line.wouldHave).toBeUndefined();
    expect(trail.outcome).not.toHaveBeenCalled();
  });

  it("has no wouldHave when nothing objected", () => {
    const trail = fakeTrail();
    recordPolicyDecision(
      trail as any,
      {
        session: "s",
        callId: "c2",
        toolName: "run_terminal_command",
        parsedArgs: {},
      },
      "allowedWithPermission",
      decide("npm test"),
    );
    expect(trail.decision.mock.calls[0][0].wouldHave).toBeUndefined();
  });

  it("masks a secret in what it records", () => {
    const draft = decisionDraft({
      session: "s",
      callId: "c3",
      tool: "run_terminal_command",
      args: "{}",
      policy: "allow",
      by: "rules",
      wouldHave: {
        policy: "ask",
        source: "protected-path",
        reason: `API_KEY=${FAKE} would be sent`,
      },
    });
    expect(JSON.stringify(draft)).not.toContain(FAKE);
  });

  it("a failing trail never stops the call", () => {
    const trail = {
      enabled: true,
      decision: () => {
        throw new Error("disk full");
      },
      outcome: vi.fn(),
    };
    expect(() =>
      recordPolicyDecision(
        trail as any,
        {
          session: "s",
          callId: "c4",
          toolName: "run_terminal_command",
          parsedArgs: {},
        },
        "allowedWithPermission",
        decide("rm -rf /"),
      ),
    ).not.toThrow();
  });
});

describe("the audit overview counts them", () => {
  let dir: string;
  beforeEach(() => {
    resetSeq();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-idgaf-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const host = () => ({
    sources: async () => ({}) as never,
    cwd: async () => "/home/dev/shop",
    dir: () => dir,
    now: () => new Date(T0 + 86_400_000),
  });

  it("says how many calls IDGAF ran that something would have objected to", async () => {
    const ran = (id: string) =>
      decisionEvent(id, "run_terminal_command", { command: "rm -rf /" }, {
        policy: "allow",
        source: "idgaf",
        wouldHave: { policy: "deny", source: "safety-floor" },
      } as never);
    fs.writeFileSync(
      sessionFile(dir, "2026-11", "s1"),
      jsonl([
        ran("a"),
        ran("b"),
        decisionEvent(
          "c",
          "run_terminal_command",
          { command: "ls" },
          {
            policy: "allow",
            source: "idgaf",
          },
        ),
      ]),
    );
    updateIndex(dir, { now: new Date(T0 + 86_400_000) });
    const o = await auditOverview({ rules: [] }, host());
    expect(o.idgafObjections).toBe(2);
  });

  it("has no count when nothing was objected to", async () => {
    fs.writeFileSync(
      sessionFile(dir, "2026-11", "s1"),
      jsonl([
        decisionEvent(
          "c",
          "run_terminal_command",
          { command: "ls" },
          {
            policy: "allow",
          },
        ),
      ]),
    );
    updateIndex(dir, { now: new Date(T0 + 86_400_000) });
    const o = await auditOverview({ rules: [] }, host());
    expect(o.idgafObjections).toBeUndefined();
  });
});
