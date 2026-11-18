import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeOpenRouterCatalog } from "core/llm/modelCatalogStore.js";
import { OPENROUTER_MODELS_URL } from "core/llm/openRouterCatalog.js";
import { setOpenRouterCatalog } from "core/llm/utils/catalogPricing.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { priceSourceNote } from "./openRouterPrices.js";
import { startRunLimits, setActiveRunBudget } from "./runLimits.js";

vi.mock("../util/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const DAY = 86_400_000;
const MODEL = { provider: "openrouter", model: "zz/open-model" };

let dir: string;
let file: string;
let home: string;

function writeList(ageDays: number) {
  writeOpenRouterCatalog(
    {
      schemaVersion: 1,
      source: OPENROUTER_MODELS_URL,
      fetchedAt: new Date(Date.now() - ageDays * DAY).toISOString(),
      models: [
        {
          id: MODEL.model,
          name: "ZZ Open Model",
          supportsTools: true,
          pricing: { prompt: 0.000001, completion: 0.000002 },
        },
      ],
    },
    file,
  );
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-orbudget-"));
  file = path.join(dir, "model-catalog", "openrouter.json");
  home = path.join(dir, "home");
  fs.mkdirSync(home);
});
afterEach(() => {
  setActiveRunBudget(undefined);
  setOpenRouterCatalog(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

const start = (
  flags: Record<string, unknown>,
  warn: (m: string) => void = () => {},
  model = MODEL,
) => startRunLimits(flags, model, { homeDir: home, priceFile: file, warn });

describe("--max-budget-usd on an OpenRouter model", () => {
  it("is refused with no downloaded list, and says how to get one", () => {
    expect(() => start({ maxBudgetUsd: "1" })).toThrow(
      /no downloaded OpenRouter price list.*continuous models refresh/s,
    );
  });

  it("--budget-allow-unpriced still runs without the cap", () => {
    expect(() =>
      start({ maxBudgetUsd: "1", budgetAllowUnpriced: true }),
    ).not.toThrow();
  });

  it("is held on a model priced by the downloaded list, with no override flag", () => {
    writeList(2);
    const budget = start({ maxBudgetUsd: "1" });
    expect(budget?.dollarCapActive).toBe(true);
    expect(budget?.priceNote).toMatch(
      /^prices from openrouter\.ai as of \d{4}-\d{2}-\d{2}$/,
    );
    // a request of 1,000,000 input tokens: 1e6 * $1/MTok = $1 + output estimate
    // 1024 * $2/MTok = $0.002048, over the $1 cap, so it is refused up front
    expect(budget?.beforeCall(1_000_000)?.reason).toBe("budget");
    setActiveRunBudget(undefined);
    const ok = start({ maxBudgetUsd: "1" });
    // 1000 * 1e-6 + 1024 * 2e-6 = 0.003048, well under the cap
    expect(ok?.beforeCall(1000)).toBeUndefined();
    expect(ok?.estimateUsd(1000)).toBeCloseTo(0.003048, 9);
  });

  it("warns, but still runs, when the list is over 30 days old", () => {
    writeList(45);
    const warn = vi.fn();
    const budget = start({ maxBudgetUsd: "1" }, warn);
    expect(budget?.dollarCapActive).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(
      /prices may be out of date.*45 days ago.*continuous models refresh/,
    );
  });

  it("does not warn for a fresh list", () => {
    writeList(5);
    const warn = vi.fn();
    start({ maxBudgetUsd: "1" }, warn);
    expect(warn).not.toHaveBeenCalled();
  });

  it("never leans on a list over 90 days old: unpriced, with a clear message", () => {
    writeList(100);
    expect(() => start({ maxBudgetUsd: "1" })).toThrow(
      /100 days old.*older than 90 days.*continuous models refresh/s,
    );
    // ...and the old list does not price anything for a budgeted run
    expect(priceSourceNote(MODEL)).toBeUndefined();
  });

  it("a list of exactly 90 days still holds a cap", () => {
    writeList(90);
    expect(start({ maxBudgetUsd: "1" })?.dollarCapActive).toBe(true);
  });

  it("without a dollar cap an old list is used for display and not refused", () => {
    writeList(400);
    expect(() => start({ maxTurns: "5" })).not.toThrow();
    expect(priceSourceNote(MODEL)).toMatch(
      /^prices from openrouter\.ai as of /,
    );
  });

  it("names the missing price when the list has the model's neighbours only", () => {
    writeList(2);
    expect(() =>
      start({ maxBudgetUsd: "1" }, () => {}, {
        provider: "openrouter",
        model: "zz/not-listed",
      }),
    ).toThrow(/has no price for this model id/);
  });

  it("other providers are unaffected by the list", () => {
    writeList(2);
    expect(() =>
      start({ maxBudgetUsd: "1" }, () => {}, {
        provider: "ollama",
        model: "llama3",
      }),
    ).toThrow(/the cost table has no price for it/);
  });
});
