import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectStuck } from "../../../util/stuckSignals";
import { decisionDraft, outcomeDraft } from "./record";
import { auditToSteps } from "./steps";
import { AuditWriter, readAuditFile } from "./writer";

/**
 * A command a signal ended (the time limit, a stop) has no exit code. The
 * stuck detection must still see it as a failed call, or an agent that keeps
 * running a command that keeps timing out looks like one that is making
 * progress. Before commands killed by a signal recorded an outcome at all, they
 * were not seen in the audit.
 */
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-signal-steps-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

type Ending = {
  exit?: number;
  signal?: string;
  timedOut?: true;
  error?: string;
};

/** Each ending is one step with one call to the same command. */
function stepsFor(command: string, endings: Ending[]) {
  const w = new AuditWriter({
    dir,
    now: () => new Date("2026-11-10T12:00:00Z"),
  });
  endings.forEach((ending, i) => {
    const callId = `c${i + 1}`;
    w.write(
      decisionDraft({
        session: "s",
        turn: i + 1,
        callId,
        tool: "Bash",
        args: JSON.stringify({ command }),
        policy: "allow",
        by: "rules",
      }),
    );
    w.write(
      outcomeDraft({
        session: "s",
        turn: i + 1,
        callId,
        tool: "Bash",
        ran: true,
        output: "",
        ...ending,
      }),
    );
  });
  return auditToSteps(readAuditFile(path.join(dir, "2026-11", "s.jsonl")));
}

describe("a command ended by a signal, in the stuck detection", () => {
  it("is a failed call, with the way it ended as its result", () => {
    const steps = stepsFor("npm test", [
      { signal: "SIGTERM", timedOut: true, error: "timed out" },
    ]);
    expect(steps).toHaveLength(1);
    const call = steps[0].calls[0];
    expect(call.error).toBe(true);
    expect(call.result).toBe("timed out");
  });

  it("is a failed call when it was stopped and printed something", () => {
    const steps = stepsFor("npm test", [
      { signal: "SIGKILL", error: "Killed" },
    ]);
    expect(steps[0].calls[0].error).toBe(true);
    expect(steps[0].calls[0].result).toBe("Killed");
  });

  it("an agent that keeps running a command that keeps timing out is seen to repeat itself", () => {
    const timeout: Ending = {
      signal: "SIGTERM",
      timedOut: true,
      error: "timed out",
    };
    const steps = stepsFor("npm test", [timeout, timeout, timeout, timeout]);
    const verdict = detectStuck(steps);
    expect(verdict.signals.length).toBeGreaterThan(0);
    expect(verdict.level).not.toBe("none");
  });

  it("sees the same repetition as when the command fails with an exit code", () => {
    const signalled = stepsFor("npm test", [
      { signal: "SIGTERM", timedOut: true, error: "timed out" },
      { signal: "SIGTERM", timedOut: true, error: "timed out" },
      { signal: "SIGTERM", timedOut: true, error: "timed out" },
      { signal: "SIGTERM", timedOut: true, error: "timed out" },
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const coded = stepsFor("npm test", [
      { exit: 1, error: "timed out" },
      { exit: 1, error: "timed out" },
      { exit: 1, error: "timed out" },
      { exit: 1, error: "timed out" },
    ]);
    const a = detectStuck(signalled);
    const b = detectStuck(coded);
    expect(a.level).toBe(b.level);
    expect(a.signals.map((s) => [s.kind, s.level])).toEqual(
      b.signals.map((s) => [s.kind, s.level]),
    );
  });

  it("a command that succeeds between failures is not a failure", () => {
    const steps = stepsFor("npm test", [
      { signal: "SIGTERM", timedOut: true, error: "timed out" },
      { exit: 0 },
    ]);
    expect(steps[0].calls[0].error).toBe(true);
    expect(steps[1].calls[0].error).toBeUndefined();
  });

  it("a command with no outcome at all (the old behaviour for a kill) leaves no step result", () => {
    const w = new AuditWriter({
      dir,
      now: () => new Date("2026-11-10T12:00:00Z"),
    });
    w.write(
      decisionDraft({
        session: "s",
        turn: 1,
        callId: "lost",
        tool: "Bash",
        args: JSON.stringify({ command: "npm test" }),
        policy: "allow",
        by: "rules",
      }),
    );
    const steps = auditToSteps(
      readAuditFile(path.join(dir, "2026-11", "s.jsonl")),
    );
    // nothing recorded how it ended, so there is nothing to compare
    expect(steps.flatMap((s) => s.calls)).toHaveLength(0);
  });
});
