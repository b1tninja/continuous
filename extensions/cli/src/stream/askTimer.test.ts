import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearCountdown,
  getCountdown,
  keepWaitingFor,
  proposalForAsk,
  resetTurnBudget,
  setCountdownAvailable,
} from "../permissions/askCountdown.js";
import { toolPermissionManager } from "../permissions/permissionManager.js";
import {
  loadPolicyFile,
  resetPolicyLevels,
} from "../permissions/policyLevels.js";

import {
  askResult,
  requestUserPermissionTimed,
} from "./streamChatResponse.helpers.js";

/**
 * The decision timer on a CLI ask: the prompt shows a countdown, and the ask
 * is refused when it runs out, as the policy does when nobody can answer.
 */
let dir: string;

const bash = () =>
  ({
    id: "call-1",
    name: "Bash",
    arguments: { command: "npm test" },
    argumentsStr: '{"command":"npm test"}',
    startNotified: false,
    tool: {} as any,
  }) as any;

function setTimer(yaml: string) {
  const file = path.join(dir, "permissions.yaml");
  fs.writeFileSync(file, yaml);
  loadPolicyFile(file);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-timer-"));
  resetPolicyLevels();
  resetTurnBudget();
  setCountdownAvailable(true);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  setCountdownAvailable(false);
  resetPolicyLevels();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Shows the prompt and returns its request id. */
function show() {
  const shown: string[] = [];
  const callbacks = {
    onToolPermissionRequest: vi.fn((_n: string, _a: unknown, id: string) =>
      shown.push(id),
    ),
  };
  return { callbacks, shown };
}

const TIMER_10 = "levels:\n  tools: cautious\n  timer:\n    cautious: 10\n";

describe("requestUserPermissionTimed", () => {
  it("with no window set, it is the ask it always was", async () => {
    setTimer("levels:\n  tools: cautious\n");
    const { callbacks, shown } = show();
    const asked = requestUserPermissionTimed(bash(), callbacks);
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    toolPermissionManager.approveRequest(shown[0]);
    expect(await asked).toEqual({ approved: true });
  });

  it("shows a countdown from the window and refuses when it runs out", async () => {
    setTimer(TIMER_10);
    const { callbacks, shown } = show();
    const asked = requestUserPermissionTimed(bash(), callbacks);
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    const id = shown[0];
    expect(getCountdown(id)).toMatchObject({
      secondsLeft: 10,
      seconds: 10,
      proposed: "refuse",
    });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(getCountdown(id)?.secondsLeft).toBe(6);
    await vi.advanceTimersByTimeAsync(6_000);
    const result = await asked;
    expect(result.approved).toBe(false);
    expect(result.timer).toEqual({
      resolved: { outcome: "default-applied", final: "refuse" },
      held: { proposed: "refuse", seconds: 10 },
    });
    // the prompt is gone from the manager and the countdown is cleared
    expect(toolPermissionManager.getPendingRequestIds()).not.toContain(id);
    expect(getCountdown(id)).toBeUndefined();
  });

  it("an answer inside the window decides: allowing overrides the proposed refusal", async () => {
    setTimer(TIMER_10);
    const { callbacks, shown } = show();
    const asked = requestUserPermissionTimed(bash(), callbacks);
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(3_000);
    toolPermissionManager.approveRequest(shown[0]);
    const result = await asked;
    expect(result.approved).toBe(true);
    expect(result.timer?.resolved).toEqual({
      outcome: "overridden",
      final: "allow",
    });
  });

  it("declining inside the window confirms the proposed refusal, by the person", async () => {
    setTimer(TIMER_10);
    const { callbacks, shown } = show();
    const asked = requestUserPermissionTimed(bash(), callbacks);
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(2_000);
    toolPermissionManager.rejectRequest(shown[0]);
    const result = await asked;
    expect(result.approved).toBe(false);
    expect(result.timer?.resolved).toEqual({
      outcome: "confirmed",
      final: "refuse",
    });
  });

  it("keep waiting stops the countdown and the ask waits for an answer, with no timer", async () => {
    setTimer(TIMER_10);
    const { callbacks, shown } = show();
    const asked = requestUserPermissionTimed(bash(), callbacks);
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(2_000);
    keepWaitingFor(shown[0]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(toolPermissionManager.getPendingRequestIds()).toContain(shown[0]);
    toolPermissionManager.approveRequest(shown[0]);
    expect(await asked).toEqual({ approved: true });
  });

  it("an ask a rule raised keeps waiting: no countdown, no timer", async () => {
    setTimer(TIMER_10);
    const { callbacks, shown } = show();
    const asked = requestUserPermissionTimed(bash(), callbacks, {
      verdictSource: "ask-rule",
    });
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    expect(getCountdown(shown[0])).toBeUndefined();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(toolPermissionManager.getPendingRequestIds()).toContain(shown[0]);
    toolPermissionManager.rejectRequest(shown[0]);
    expect(await asked).toEqual({ approved: false });
  });

  it("an ask from a protected path or a floor keeps waiting too", async () => {
    setTimer(TIMER_10);
    for (const source of [
      "protected-path",
      "floor",
      "tainted-session",
      "secret-egress",
    ]) {
      expect(
        proposalForAsk(
          { name: "Bash", arguments: { command: "x" } },
          "normal",
          source,
        ),
        source,
      ).toBeUndefined();
    }
  });

  it("a process with no screen to draw it on never holds an ask", async () => {
    setTimer(TIMER_10);
    setCountdownAvailable(false);
    const { callbacks, shown } = show();
    const asked = requestUserPermissionTimed(bash(), callbacks);
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(300_000);
    expect(toolPermissionManager.getPendingRequestIds()).toContain(shown[0]);
    toolPermissionManager.approveRequest(shown[0]);
    expect(await asked).toEqual({ approved: true });
  });

  it("the window is the one set for the call's level", async () => {
    setTimer(
      "levels:\n  tools: permissive\n  timer:\n    cautious: 30\n    permissive: 5\n",
    );
    expect(
      proposalForAsk(
        { name: "Bash", arguments: { command: "x" } },
        "normal",
        undefined,
        0,
      )?.seconds,
    ).toBe(5);
  });

  it("another level's window does not apply", async () => {
    setTimer("levels:\n  tools: cautious\n  timer:\n    permissive: 5\n");
    expect(
      proposalForAsk(
        { name: "Bash", arguments: { command: "x" } },
        "normal",
        undefined,
      ),
    ).toBeUndefined();
  });

  it("two asks in a row each get their own window, starting when each is shown", async () => {
    setTimer(TIMER_10);
    const { callbacks, shown } = show();
    const first = requestUserPermissionTimed(bash(), callbacks);
    const second = requestUserPermissionTimed(
      { ...bash(), id: "call-2" },
      callbacks,
    );
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await first).timer?.resolved.outcome).toBe("default-applied");
    await vi.waitFor(() => expect(shown).toHaveLength(2));
    // the second has its full window, not what was left behind the first
    expect(getCountdown(shown[1])?.secondsLeft).toBe(10);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await second).timer?.resolved.outcome).toBe("default-applied");
  });
});

describe("the turn budget on asks", () => {
  const TIMER_30 = "levels:\n  tools: cautious\n  timer:\n    cautious: 30\n";
  const probe = () =>
    proposalForAsk(
      { name: "Bash", arguments: { command: "x" } },
      "normal",
      undefined,
    );

  /** Shows an ask and lets its window run out; returns the window it had. */
  async function lapse(id: string) {
    const { callbacks, shown } = show();
    const asked = requestUserPermissionTimed({ ...bash(), id }, callbacks);
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    const window = getCountdown(shown[0])?.seconds;
    await vi.advanceTimersByTimeAsync((window ?? 0) * 1000);
    await asked;
    return window;
  }

  it("asks in one turn use two windows of 30 s and the rest wait", async () => {
    setTimer(TIMER_30);
    expect(await lapse("a1")).toBe(30);
    expect(await lapse("a2")).toBe(30);
    // the 60 s of this turn are spent: later asks wait for an answer, as with no timer
    expect(probe()).toBeUndefined();
  });

  it("an ask answered at once costs the turn almost nothing", async () => {
    setTimer(TIMER_30);
    const { callbacks, shown } = show();
    const asked = requestUserPermissionTimed(bash(), callbacks);
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(2_000);
    toolPermissionManager.approveRequest(shown[0]);
    await asked;
    expect(probe()?.seconds).toBe(30);
  });

  it("a later ask gets only what the turn has left", async () => {
    setTimer(TIMER_30);
    const { callbacks, shown } = show();
    const first = requestUserPermissionTimed(bash(), callbacks);
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(30_000);
    await first;
    // 30 s spent; the next is answered at 20 s, leaving 10 s of the 60
    const second = requestUserPermissionTimed(
      { ...bash(), id: "b" },
      callbacks,
    );
    await vi.waitFor(() => expect(shown).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(20_000);
    toolPermissionManager.approveRequest(shown[1]);
    await second;
    // 10 s left, less the few polls vi.waitFor adds to the fake clock; rounded down
    const left = probe()?.seconds ?? 0;
    expect(left).toBeGreaterThanOrEqual(9);
    expect(left).toBeLessThanOrEqual(10);
  });

  it("a new request to the model starts a new turn", async () => {
    setTimer(TIMER_30);
    await lapse("c1");
    await lapse("c2");
    expect(probe()).toBeUndefined();
    resetTurnBudget();
    expect(probe()?.seconds).toBe(30);
  });

  it("an ask that is not held does not spend the budget", async () => {
    setTimer(TIMER_30);
    const { callbacks, shown } = show();
    const asked = requestUserPermissionTimed(bash(), callbacks, {
      verdictSource: "ask-rule",
    });
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(200_000);
    toolPermissionManager.approveRequest(shown[0]);
    await asked;
    expect(probe()?.seconds).toBe(30);
  });
});

describe("askResult: what the model is told", () => {
  const resolved = (
    outcome: "default-applied" | "overridden" | "confirmed",
  ) => ({
    outcome,
    final: "refuse" as const,
  });
  const held = { proposed: "refuse" as const, seconds: 15 };

  it("an allowed ask is allowed", () => {
    expect(askResult(bash(), { approved: true }, {})).toEqual({
      approved: true,
    });
  });

  it("a refusal with no timer is the person's, as before", () => {
    expect(askResult(bash(), { approved: false }, {})).toEqual({
      approved: false,
      denialReason: "user",
    });
  });

  it("a window that ran out says nobody answered, not that the person refused", () => {
    const r = askResult(
      bash(),
      {
        approved: false,
        timer: { resolved: resolved("default-applied"), held },
      },
      {},
    );
    expect(r.denialReason).toBe("timer");
    expect(r.denialMessage).toContain("No answer to Bash within 15 s");
    expect(r.denialMessage).toContain("did not refuse it");
    expect(r.denialMessage).not.toMatch(
      /Permission denied by user|alternative approach|security policy/i,
    );
  });

  it("a decline inside the window says the person declined", () => {
    const r = askResult(
      bash(),
      { approved: false, timer: { resolved: resolved("confirmed"), held } },
      {},
    );
    expect(r.denialMessage).toContain("The person declined Bash");
    expect(r.denialMessage).not.toContain("No answer");
  });

  it("records the timer on the audit trace", () => {
    const trace: Record<string, unknown> = {};
    askResult(
      bash(),
      {
        approved: false,
        timer: { resolved: resolved("default-applied"), held },
      },
      trace as never,
    );
    expect(trace.timer).toBeDefined();
  });
});

describe("the countdown state", () => {
  it("clearing a request that has none does nothing", () => {
    expect(() => clearCountdown("nope")).not.toThrow();
  });
});
