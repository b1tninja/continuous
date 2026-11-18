import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpendLedger } from "../audit/shadowLedger";
import { AuditTrail } from "../audit/trail";
import { ShadowReviewer, type ShadowCall } from "./shadow";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-spend-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const allow = JSON.stringify({ decision: "allow", reason: "Runs the tests." });
const call = (callId: string): ShadowCall => ({
  session: "s1",
  callId,
  toolName: "run_terminal_command",
  args: { command: "npm test" },
  history: { userMessages: ["run the tests"], toolCalls: [] },
  real: { policy: "allow", by: "rules" },
});

function client(
  reply: () => Promise<unknown> | unknown,
  model = "claude-haiku-4-5",
) {
  return {
    chat: vi.fn(async () => reply()),
    model,
    providerName: "anthropic",
  } as any;
}

const ok = () => ({
  role: "assistant",
  content: allow,
  usage: { promptTokens: 1000, completionTokens: 50 },
});

function reviewer(ledger: SpendLedger, c: ReturnType<typeof client>, cap = 1) {
  return new ShadowReviewer({
    trail: new AuditTrail({
      dir,
      enabled: true,
      now: () => new Date("2026-11-10T12:00:00Z"),
      syncImportant: false,
    }),
    settings: { budgetUsd: cap, timeoutMs: 200 },
    reviewer: () => c,
    environment: { workspaceDirs: ["/w"], os: "linux" },
    spentSoFar: () => 0,
    ledger,
    env: {},
  });
}

describe("ShadowReviewer with the spend ledger", () => {
  it("reserves before the call and settles with the real cost", async () => {
    const ledger = new SpendLedger({ dir: path.join(dir, "led") });
    let inFlight: { reservedUsd: number } | undefined;
    const c = client(() => {
      inFlight = ledger.summary();
      return ok();
    });
    expect(await reviewer(ledger, c).observe(call("c1"))).toBe("recorded");
    expect(inFlight?.reservedUsd).toBeGreaterThan(0);
    const after = ledger.summary();
    expect(after.reservedUsd).toBe(0);
    expect(after.reviews).toBe(1);
    expect(after.spentUsd).toBeGreaterThan(0);
    expect(after.spentUsd).toBeLessThan(0.01);
  });

  it("gives the reservation back when the request never produced a reply", async () => {
    const ledger = new SpendLedger({ dir: path.join(dir, "led") });
    const c = client(() => Promise.reject(new Error("network")));
    expect(await reviewer(ledger, c).observe(call("c1"))).toBe("dropped");
    expect(ledger.summary()).toEqual({
      spentUsd: 0,
      reservedUsd: 0,
      reviews: 0,
    });
  });

  it("stops at the cap that other processes already used", async () => {
    const led = path.join(dir, "led");
    const other = new SpendLedger({ dir: led, pid: 2 });
    const held = await other.reserve({
      callId: "x",
      estimateUsd: 0.995,
      capUsd: 1,
    });
    expect(held.ok).toBe(true);
    const c = client(ok);
    const status = await reviewer(
      new SpendLedger({ dir: led, pid: 1 }),
      c,
    ).observe(call("c1"));
    expect(status).toBe("over-budget");
    expect(c.chat).not.toHaveBeenCalled();
  });

  it("drops the review when the ledger cannot be used, without calling the model", async () => {
    const led = path.join(dir, "led");
    fs.mkdirSync(led);
    fs.writeFileSync(path.join(led, "shadow-spend.lock"), "1:0:alive");
    const ledger = new SpendLedger({ dir: led, lockWaitMs: 50 });
    const c = client(ok);
    expect(await reviewer(ledger, c).observe(call("c1"))).toBe("dropped");
    expect(c.chat).not.toHaveBeenCalled();
  });

  it("two reviewers on one ledger spend no more than the cap plus one call each", async () => {
    const led = path.join(dir, "led");
    const cap = 0.0125;
    const a = reviewer(new SpendLedger({ dir: led, pid: 1 }), client(ok), cap);
    const b = reviewer(new SpendLedger({ dir: led, pid: 2 }), client(ok), cap);
    for (let i = 0; i < 12; i++) {
      await Promise.all([a.observe(call(`a${i}`)), b.observe(call(`b${i}`))]);
    }
    const spent = new SpendLedger({ dir: led }).summary();
    expect(spent.reviews).toBeGreaterThan(0);
    // Each review costs the same here, so the reservations never let it past the cap
    expect(spent.spentUsd).toBeLessThanOrEqual(cap + 0.001);
  });
});
