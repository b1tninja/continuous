import type { ModelConfig } from "@continuedev/config-yaml";
import { describe, expect, it } from "vitest";

import type { AuthConfig } from "./auth/workos.js";
import { createLlmApi, subagentCacheModel } from "./config.js";

const claude = (cacheBehavior?: ModelConfig["cacheBehavior"]): ModelConfig =>
  ({
    name: "Claude",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    apiKey: "k",
    roles: ["subagent"],
    ...(cacheBehavior ? { cacheBehavior } : {}),
  }) as ModelConfig;

describe("subagentCacheModel (cacheBehavior.subagentTtl)", () => {
  it("puts a subagent on 5 minutes by default, over the model's 1h", () => {
    expect(subagentCacheModel(claude()).cacheBehavior?.ttl).toBe("5m");
    expect(subagentCacheModel(claude({ ttl: "1h" })).cacheBehavior?.ttl).toBe(
      "5m",
    );
  });

  it.each(["1h", "auto", "5m"] as const)("uses subagentTtl %s", (ttl) => {
    expect(
      subagentCacheModel(claude({ ttl: "5m", subagentTtl: ttl })).cacheBehavior
        ?.ttl,
    ).toBe(ttl);
  });

  it("inherit leaves the model as it is", () => {
    const model = claude({ ttl: "1h", subagentTtl: "inherit" });
    expect(subagentCacheModel(model)).toBe(model);
  });

  it("keeps the other cache settings", () => {
    const out = subagentCacheModel(
      claude({ cacheConversation: false, cacheSystemMessage: true }),
    );
    expect(out.cacheBehavior).toEqual({
      cacheConversation: false,
      cacheSystemMessage: true,
      ttl: "5m",
    });
  });

  it("reaches the Anthropic adapter as its lifetime", () => {
    const api = createLlmApi(
      subagentCacheModel(claude({ ttl: "1h" })),
      null as AuthConfig,
    ) as any;
    expect(api.config.cacheBehavior).toEqual({ ttl: "5m" });
  });
});
