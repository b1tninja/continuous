import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  trail: {
    enabled: true,
    decision: undefined as any,
    answer: undefined as any,
    outcome: undefined as any,
  },
}));

vi.mock("core/tools/permissions/audit/global.js", () => ({
  getAuditTrail: () => state.trail,
}));

import { StreamJsonRun } from "../headless/streamJsonRun.js";
import { printIdgafObjections } from "../util/exit.js";

import { recordCliDecision } from "./cliAudit.js";
import {
  idgafObjectionCount,
  idgafObjectionLine,
  resetIdgafObjections,
} from "./idgafObjections.js";

const call = { id: "c1", name: "Bash", arguments: { command: "rm -rf /" } };
const floorObjection = {
  decision: "allow" as const,
  by: "rules" as const,
  source: "idgaf",
  reason: "Allowed at IDGAF. Below IDGAF this call would have been refused.",
  idgafOverride: {
    policy: "disabled" as const,
    source: "floor" as const,
    rule: "runTerminalCommand(rm -rf*)",
    reason: "Blocked by your floor rule runTerminalCommand(rm -rf*).",
  },
};

beforeEach(() => {
  resetIdgafObjections();
  state.trail = {
    enabled: true,
    decision: vi.fn(),
    answer: vi.fn(),
    outcome: vi.fn(),
  };
});
afterEach(() => vi.restoreAllMocks());

describe("a call IDGAF ran past an objection", () => {
  it("is written to the audit trail with what would have stopped it, and counted", () => {
    recordCliDecision(call, { verdict: floorObjection }, { approved: true });
    expect(state.trail.decision.mock.calls[0][0]).toMatchObject({
      policy: "allow",
      level: "idgaf",
      wouldHave: { policy: "deny", source: "floor" },
    });
    expect(idgafObjectionCount()).toBe(1);
  });

  it("a Never (exclude) entry of the CLI's lists counts; the catch-all ask does not", () => {
    recordCliDecision(call, { idgafLifted: "exclude" }, { approved: true });
    expect(state.trail.decision.mock.calls[0][0].wouldHave).toMatchObject({
      policy: "deny",
      source: "cli-policy",
    });
    recordCliDecision(call, { idgafLifted: "ask" }, { approved: true });
    expect(state.trail.decision.mock.calls[1][0].wouldHave).toBeUndefined();
    expect(idgafObjectionCount()).toBe(1);
  });

  it("nothing is counted or recorded when nothing objected", () => {
    recordCliDecision(
      call,
      { verdict: { decision: "allow", by: "rules", source: "idgaf" } },
      { approved: true },
    );
    expect(state.trail.decision.mock.calls[0][0].wouldHave).toBeUndefined();
    expect(idgafObjectionCount()).toBe(0);
    expect(idgafObjectionLine()).toBeUndefined();
  });

  it("is still counted when the audit trail is off or fails", () => {
    state.trail.enabled = false;
    recordCliDecision(call, { verdict: floorObjection }, { approved: true });
    state.trail.enabled = true;
    state.trail.decision = vi.fn(() => {
      throw new Error("disk full");
    });
    expect(() =>
      recordCliDecision(call, { verdict: floorObjection }, { approved: true }),
    ).not.toThrow();
    expect(idgafObjectionCount()).toBe(2);
  });
});

describe("where the count is shown", () => {
  it("one stderr line at the end of the run, none when there were none", () => {
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    printIdgafObjections();
    expect(write).not.toHaveBeenCalled();
    recordCliDecision(call, { verdict: floorObjection }, { approved: true });
    recordCliDecision(call, { verdict: floorObjection }, { approved: true });
    printIdgafObjections();
    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0][0])).toContain("IDGAF ran 2 calls");
  });

  it("the stream-json result event carries numIdgafObjections", () => {
    const lines: string[] = [];
    const run = new StreamJsonRun({
      write: (l: string) => lines.push(l),
    } as any);
    recordCliDecision(call, { verdict: floorObjection }, { approved: true });
    run.finish({ status: "success", exitCode: 0 });
    const result = JSON.parse(lines[lines.length - 1]);
    expect(result.type).toBe("result");
    expect(result.numIdgafObjections).toBe(1);
  });
});
