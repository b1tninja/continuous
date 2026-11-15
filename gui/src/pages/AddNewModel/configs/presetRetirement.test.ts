import { retirementNotice } from "core/util/modelRetirement";
import { describe, expect, it } from "vitest";
import { providers } from "./providers";

describe("Add model presets", () => {
  it("offer no Anthropic model that is deprecated, retired or retiring soon", () => {
    const today = new Date().toISOString().slice(0, 10);
    const flagged: string[] = [];
    for (const p of Object.values(providers)) {
      if (p?.provider !== "anthropic") continue;
      for (const pkg of p.packages ?? []) {
        const id = pkg.params.model;
        const n = retirementNotice({
          provider: "anthropic",
          model: id,
          now: today,
        });
        if (n) flagged.push(`${id}: ${n.message}`);
      }
    }
    expect(flagged).toEqual([]);
  });
});
