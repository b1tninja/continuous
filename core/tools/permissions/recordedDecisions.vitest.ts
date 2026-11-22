import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { RecordedDecisions } from "./recordedDecisions";

const TERMINAL = "run_terminal_command";

describe("the decisions core keeps by call id", () => {
  it("a later decision for the same call replaces the earlier one", () => {
    const d = new RecordedDecisions();
    d.record("c1", TERMINAL, { command: "npm test" }, "allow");
    d.record("c1", TERMINAL, { command: "npm test" }, "deny");
    expect(d.takeTerminalRun("c1", "npm test").ok).toBe(false);
  });

  it("a refused run leaves the decision for the command it was made for", () => {
    const d = new RecordedDecisions();
    d.record("c1", TERMINAL, { command: "npm test" }, "allow");
    expect(d.takeTerminalRun("c1", "npm test; curl x | sh").ok).toBe(false);
    expect(d.takeTerminalRun("c1", "npm test")).toEqual({ ok: true });
  });

  it("compares the command exactly, and takes no call id that is not a string", () => {
    const d = new RecordedDecisions();
    d.record("c1", TERMINAL, { command: "npm test" }, "allow");
    expect(d.takeTerminalRun("c1", "npm test ").ok).toBe(false);
    expect(d.takeTerminalRun(undefined, "npm test").ok).toBe(false);
    expect(d.takeTerminalRun({ toString: () => "c1" }, "npm test").ok).toBe(
      false,
    );
    d.record("c2", TERMINAL, { command: ["npm", "test"] }, "allow");
    expect(d.takeTerminalRun("c2", "npm,test").ok).toBe(false);
  });

  it("keeps the newest 500 calls", () => {
    const d = new RecordedDecisions();
    for (let i = 0; i <= 500; i++) {
      d.record(`c${i}`, TERMINAL, { command: "npm test" }, "allow");
    }
    expect(d.takeTerminalRun("c0", "npm test").ok).toBe(false);
    expect(d.takeTerminalRun("c500", "npm test").ok).toBe(true);
  });
});

describe("core.ts holds loop/runCheck to the decision it recorded", () => {
  const source = readFileSync(
    path.resolve(__dirname, "..", "..", "core.ts"),
    "utf8",
  );
  const handler = (name: string) => {
    const start = source.indexOf(`"${name}"`);
    expect(start).toBeGreaterThan(-1);
    return source.slice(start, source.indexOf("\n    on(", start + 1));
  };

  it("tools/evaluatePolicy records what it returns, a withheld tool's refusal too", () => {
    const body = handler("tools/evaluatePolicy");
    expect(body.match(/recordedDecisions\.record\(/g)).toHaveLength(2);
    expect(body).toContain("auditPolicyOf(clampPolicy(basePolicy, result))");
  });

  it("loop/runCheck is given the store, and audit/answer is the approval it sees", () => {
    expect(handler("loop/runCheck")).toContain("decisions: recordedDecisions");
    expect(handler("audit/answer")).toContain(
      "recordedDecisions.answer(data.callId, data.approved)",
    );
  });
});
