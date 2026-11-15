import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { trackSessionUsage } from "../session.js";

import { RunBudget, unpricedBudgetProblem } from "./runBudget.js";
import { setActiveRunBudget, startRunLimits } from "./runLimits.js";

/**
 * A model's own price (`pricing:` in config.yaml) lets a dollar budget run on
 * a model no price table knows: a local or unlisted one.
 */
const local = { provider: "ollama", model: "llama3" };
const price = { input: 2, output: 10 };

describe("a dollar budget on a model with a price in its config", () => {
  it("is held instead of refused", () => {
    expect(unpricedBudgetProblem({ maxBudgetUsd: 1 }, local, false)).toMatch(
      /pricing: input and output/,
    );
    expect(
      unpricedBudgetProblem(
        { maxBudgetUsd: 1 },
        local,
        false,
        undefined,
        price,
      ),
    ).toBeUndefined();
  });

  it("estimates a request at the configured rates and names the source", () => {
    const budget = new RunBudget({
      limits: { maxBudgetUsd: 1 },
      model: local,
      userPrice: price,
      spentUsd: () => 0,
    });
    expect(budget.dollarCapActive).toBe(true);
    // 100k input at $2/M + 1024 assumed output at $10/M
    expect(budget.estimateUsd(100_000)).toBeCloseTo(0.2 + 0.01024, 8);
    expect(budget.priceNote).toBe("prices from your config");
  });

  it("refuses a request whose estimate would pass the cap", () => {
    const budget = new RunBudget({
      limits: { maxBudgetUsd: 0.1 },
      model: local,
      userPrice: price,
      spentUsd: () => 0.05,
    });
    expect(budget.beforeCall(100_000)?.reason).toBe("budget");
  });

  it("a zero price is a price: the cap is held and never reached", () => {
    const budget = new RunBudget({
      limits: { maxBudgetUsd: 1 },
      model: local,
      userPrice: { input: 0, output: 0 },
      spentUsd: () => 0,
    });
    expect(budget.dollarCapActive).toBe(true);
    expect(budget.estimateUsd(1_000_000)).toBe(0);
  });

  it("without a price the model stays unpriced", () => {
    const budget = new RunBudget({
      limits: { maxBudgetUsd: 1 },
      model: local,
      spentUsd: () => 0,
    });
    expect(budget.dollarCapActive).toBe(false);
  });
});

describe("startRunLimits with the model's pricing", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "runlimits-price-"));
    fs.mkdirSync(path.join(home, ".continuous"), { recursive: true });
  });
  afterEach(() => {
    setActiveRunBudget(undefined);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("starts, and counts this run's spend at the configured price", () => {
    const budget = startRunLimits(
      { maxBudgetUsd: "0.5" },
      { ...local, pricing: price },
      { homeDir: home },
    );
    expect(budget?.dollarCapActive).toBe(true);
    expect(budget?.beforeCall(1000)).toBeUndefined();
    // 100k in ($0.20) + 40k out ($0.40) = $0.60, past the $0.50 cap
    trackSessionUsage(
      0,
      { promptTokens: 100_000, completionTokens: 40_000 },
      local.provider,
      local.model,
    );
    const stop = budget?.afterCall(40_000);
    expect(stop?.reason).toBe("budget");
    expect(stop?.spentUsd).toBeCloseTo(0.6, 8);
  });

  it("still refuses without a price", () => {
    expect(() =>
      startRunLimits({ maxBudgetUsd: "0.5" }, local, { homeDir: home }),
    ).toThrow(/--budget-allow-unpriced/);
  });

  it("ignores an unusable price rather than holding a cap on it", () => {
    expect(() =>
      startRunLimits(
        { maxBudgetUsd: "0.5" },
        { ...local, pricing: { input: -1, output: 2 } },
        { homeDir: home },
      ),
    ).toThrow(/--budget-allow-unpriced/);
  });
});
