import fs from "node:fs";
import path from "node:path";
import { maskForAudit } from "./mask";
import type { DecisionEvent } from "./record";

/**
 * Fake audit data for the tests of the audit index (ROADMAP B75, B69, B70).
 * Everything here is made up: no real trail is read.
 */
export const T0 = Date.parse("2026-11-01T09:00:00.000Z");

let seq = 0;
export const resetSeq = () => {
  seq = 0;
};

export function decisionEvent(
  callId: string,
  tool: string,
  args: unknown,
  over: Partial<DecisionEvent> = {},
): DecisionEvent {
  const masked = maskForAudit(JSON.stringify(args), 2000);
  return {
    v: 1,
    ev: "decision",
    ts: new Date(T0 + seq * 60_000).toISOString(),
    session: "s1",
    seq: seq++,
    callId,
    tool,
    argsMasked: masked.masked,
    argsHash: masked.hash,
    argsLen: masked.length,
    ...(masked.kinds.length ? { maskedKinds: masked.kinds } : {}),
    policy: "ask",
    by: "rules",
    source: "cautious",
    ...over,
  } as DecisionEvent;
}

/** An ask and the person's answer to it. */
export function askAndAnswer(
  tool: string,
  args: unknown,
  answer: "allow" | "deny",
  over: Partial<DecisionEvent> = {},
): DecisionEvent[] {
  const id = `c${seq}`;
  return [
    decisionEvent(id, tool, args, over),
    decisionEvent(id, tool, args, {
      ...over,
      policy: answer,
      by: "person",
      source: undefined,
      rule: undefined,
    }),
  ];
}

export const jsonl = (events: readonly unknown[]) =>
  events.map((e) => `${JSON.stringify(e)}\n`).join("");

/** The path of a session's file in the audit folder layout (`yyyy-mm/session.jsonl`). */
export function sessionFile(dir: string, month: string, session: string) {
  const d = path.join(dir, month);
  fs.mkdirSync(d, { recursive: true });
  return path.join(d, `${session}.jsonl`);
}
