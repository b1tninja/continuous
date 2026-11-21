import { describe, expect, it } from "vitest";
import { propose, type Proposal } from "./decisionTimer";
import { holdProposal, type Scheduler } from "./holdProposal";

/** A clock the test moves by hand; timers fire only when it passes them. */
function fakeClock(start = 0) {
  let now = start;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const scheduler: Scheduler = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (h) => {
      timers.delete(h as number);
    },
  };
  /** Moves time forward, firing every timer that falls due, in order. */
  const advance = async (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
      await Promise.resolve();
    }
    now = target;
    await Promise.resolve();
  };
  return { scheduler, advance, pending: () => timers.size };
}

const proposal = (
  proposed: "allow" | "ask",
  seconds: 5 | 10 | 15 | 30 = 10,
): Proposal =>
  propose(
    proposed === "allow"
      ? { policy: "allowedWithoutPermission", source: "allow-rule" }
      : { policy: "allowedWithPermission", source: "tool-setting" },
    {
      attended: true,
      level: "cautious",
      settings: { cautious: seconds },
      headsUp: { cautious: seconds as never },
      now: 0,
    },
  ) as Proposal;

const never = new Promise<"allow" | "deny">(() => undefined);

describe("holdProposal", () => {
  it("applies the proposal when the window ends with no answer", async () => {
    const c = fakeClock();
    let result: unknown = "pending";
    void holdProposal(proposal("allow"), {
      answered: never,
      scheduler: c.scheduler,
    }).then((r) => (result = r));
    await c.advance(9_999);
    expect(result).toBe("pending");
    await c.advance(1);
    expect(result).toEqual({ outcome: "default-applied", final: "allow" });
  });

  it("refuses an ask when the window ends", async () => {
    const c = fakeClock();
    const out = holdProposal(proposal("ask", 5), {
      answered: never,
      scheduler: c.scheduler,
    });
    await c.advance(5_000);
    expect(await out).toEqual({ outcome: "default-applied", final: "refuse" });
  });

  it("ticks once a second with the seconds left, ending at 0", async () => {
    const c = fakeClock();
    const ticks: number[] = [];
    const out = holdProposal(proposal("allow", 5), {
      answered: never,
      onTick: (s) => ticks.push(s),
      scheduler: c.scheduler,
    });
    await c.advance(5_000);
    await out;
    expect(ticks).toEqual([5, 4, 3, 2, 1, 0]);
  });

  it("the person's answer inside the window decides at once, with no further ticks", async () => {
    const c = fakeClock();
    const ticks: number[] = [];
    let answer!: (a: "allow" | "deny") => void;
    const answered = new Promise<"allow" | "deny">((r) => (answer = r));
    const out = holdProposal(proposal("allow"), {
      answered,
      onTick: (s) => ticks.push(s),
      scheduler: c.scheduler,
    });
    await c.advance(3_000);
    answer("deny");
    expect(await out).toEqual({ outcome: "overridden", final: "refuse" });
    const seen = ticks.length;
    await c.advance(20_000);
    expect(ticks.length).toBe(seen);
    expect(c.pending()).toBe(0);
  });

  it("confirming what was proposed is confirmed, not overridden", async () => {
    const c = fakeClock();
    const out = holdProposal(proposal("allow"), {
      answered: Promise.resolve("allow"),
      scheduler: c.scheduler,
    });
    expect(await out).toEqual({ outcome: "confirmed", final: "allow" });
  });

  it("allowing an ask inside the window overrides the proposed refusal", async () => {
    const c = fakeClock();
    const out = holdProposal(proposal("ask"), {
      answered: Promise.resolve("allow"),
      scheduler: c.scheduler,
    });
    expect(await out).toEqual({ outcome: "overridden", final: "allow" });
  });

  it("decides once: an answer after the window ended is ignored", async () => {
    const c = fakeClock();
    let answer!: (a: "allow" | "deny") => void;
    const answered = new Promise<"allow" | "deny">((r) => (answer = r));
    const out = holdProposal(proposal("allow", 5), {
      answered,
      scheduler: c.scheduler,
    });
    await c.advance(5_000);
    const first = await out;
    answer("deny");
    await Promise.resolve();
    expect(first).toEqual({ outcome: "default-applied", final: "allow" });
  });

  it("an aborted hold decides nothing and leaves no timer behind", async () => {
    const c = fakeClock();
    const ctl = new AbortController();
    const out = holdProposal(proposal("allow"), {
      answered: never,
      signal: ctl.signal,
      scheduler: c.scheduler,
    });
    await c.advance(2_000);
    ctl.abort();
    expect(await out).toBeUndefined();
    expect(c.pending()).toBe(0);
  });

  it("a hold that starts already aborted decides nothing", async () => {
    const c = fakeClock();
    const ctl = new AbortController();
    ctl.abort();
    expect(
      await holdProposal(proposal("allow"), {
        answered: never,
        signal: ctl.signal,
        scheduler: c.scheduler,
      }),
    ).toBeUndefined();
  });

  it("an answer that cannot arrive leaves the window to decide", async () => {
    const c = fakeClock();
    const out = holdProposal(proposal("ask", 5), {
      answered: Promise.reject(new Error("closed")),
      scheduler: c.scheduler,
    });
    await c.advance(5_000);
    expect(await out).toEqual({ outcome: "default-applied", final: "refuse" });
  });

  it("starts from the time the proposal was made, not from when the hold is called", async () => {
    const c = fakeClock(4_000);
    const late = { ...proposal("allow", 5), startedAt: 0 };
    const out = holdProposal(late, { answered: never, scheduler: c.scheduler });
    await c.advance(1_000);
    expect(await out).toEqual({ outcome: "default-applied", final: "allow" });
  });
});
