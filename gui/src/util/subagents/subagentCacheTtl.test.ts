import type { ModelDescription } from "core";
import { describe, expect, it } from "vitest";
import {
  AUTO_ESCALATE_AT_REQUEST,
  AUTO_ESCALATE_MIN_GAP_MS,
} from "../promptCache";
import {
  DEFAULT_SUBAGENT_TTL,
  nextSubagentAutoTtl,
  subagentFirstCacheTtl,
  subagentTtlPolicy,
} from "./subagentCacheTtl";

const model = (subagentTtl?: unknown): ModelDescription => ({
  title: "Claude",
  model: "claude-sonnet-4-6",
  provider: "anthropic",
  underlyingProviderName: "anthropic",
  ...(subagentTtl === undefined
    ? {}
    : { cacheBehavior: { subagentTtl: subagentTtl as any } }),
});

describe("subagentTtlPolicy", () => {
  it("defaults to 5 minutes", () => {
    expect(DEFAULT_SUBAGENT_TTL).toBe("5m");
    expect(subagentTtlPolicy(model())).toBe("5m");
  });

  it.each(["5m", "1h", "auto", "inherit"])("reads %s", (value) => {
    expect(subagentTtlPolicy(model(value))).toBe(value);
  });

  it.each(["30m", "", 3600])("ignores %p", (value) => {
    expect(subagentTtlPolicy(model(value))).toBe("5m");
  });
});

describe("subagentFirstCacheTtl", () => {
  it.each([
    ["5m", "5m"],
    ["1h", "1h"],
    ["auto", "5m"],
    ["inherit", undefined],
  ] as const)("%s -> %s", (policy, ttl) => {
    expect(subagentFirstCacheTtl(policy)).toBe(ttl);
  });
});

describe("nextSubagentAutoTtl", () => {
  it("moves to 1 hour at the run's fifth request", () => {
    const m = model("auto");
    let state;
    const ttls: string[] = [];
    for (let i = 0; i < AUTO_ESCALATE_AT_REQUEST + 1; i++) {
      const next = nextSubagentAutoTtl(m, state, 1_000 + i * 1_000);
      state = next.nextState;
      ttls.push(next.ttl);
    }
    expect(ttls).toEqual([
      ...Array(AUTO_ESCALATE_AT_REQUEST - 1).fill("5m"),
      "1h",
      "1h",
    ]);
  });

  it("moves to 1 hour after a pause a 1-hour entry would have covered", () => {
    const m = model("auto");
    const first = nextSubagentAutoTtl(m, undefined, 0);
    expect(first.ttl).toBe("5m");
    const second = nextSubagentAutoTtl(
      m,
      first.nextState,
      AUTO_ESCALATE_MIN_GAP_MS + 1,
    );
    expect(second.ttl).toBe("1h");
  });
});
