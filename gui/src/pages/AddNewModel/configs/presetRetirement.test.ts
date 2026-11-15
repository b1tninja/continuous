import { retirementNotice } from "core/util/modelRetirement";
import { describe, expect, it } from "vitest";
import { providers } from "./providers";

/**
 * Providers whose presets carry Anthropic's own model ids and forward them to
 * Anthropic's API, so Anthropic's retirement dates apply to them as well.
 */
const PASSES_ANTHROPIC_IDS = new Set(["anthropic", "cometapi"]);

/**
 * Providers with a "claude" preset that Anthropic's dates do not cover:
 * Bedrock and Vertex set their own schedules, Ask Sage names its models with
 * its own aliases (e.g. "claude-4-opus", "google-claude-45-sonnet"), and
 * Replicate maps its preset to its own listing ("anthropic/claude-4-sonnet").
 */
const OWN_SCHEDULE = new Set([
  "bedrock",
  "bedrock-mantle",
  "vertexai",
  "askSage",
  "replicate",
]);

const presets = () =>
  Object.values(providers).flatMap((p) =>
    (p?.packages ?? []).map((pkg) => ({
      provider: p!.provider,
      model: pkg.params.model,
    })),
  );

describe("Add model presets", () => {
  it("offer no Anthropic model that is deprecated, retired or retiring soon, from Anthropic or a provider that forwards its ids", () => {
    const today = new Date().toISOString().slice(0, 10);
    const flagged: string[] = [];
    for (const { provider, model } of presets()) {
      if (!PASSES_ANTHROPIC_IDS.has(provider)) continue;
      const n = retirementNotice({ provider: "anthropic", model, now: today });
      if (n) flagged.push(`${provider}/${model}: ${n.message}`);
    }
    expect(flagged).toEqual([]);
  });

  it("place every provider with a Claude preset on one side or the other", () => {
    const unsorted = new Set<string>();
    for (const { provider, model } of presets()) {
      if (!/claude/i.test(model)) continue;
      if (PASSES_ANTHROPIC_IDS.has(provider) || OWN_SCHEDULE.has(provider)) {
        continue;
      }
      unsorted.add(provider);
    }
    expect(
      [...unsorted],
      "add the provider to PASSES_ANTHROPIC_IDS or OWN_SCHEDULE",
    ).toEqual([]);
  });
});
