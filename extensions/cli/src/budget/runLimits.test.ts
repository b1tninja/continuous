import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  COMMUNITY_CATALOG_SCHEMA_VERSION,
  MODELS_DEV_URL,
  parseModelsDev,
} from "core/llm/communityCatalog.js";
import { MODELS_DEV_TRIMMED } from "core/llm/communityCatalogFixtures.js";
import { writeCommunityCatalog } from "core/llm/communityCatalogStore.js";
import { setCommunityCatalog } from "core/llm/utils/communityPricing.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RUN_STOP_EXIT_CODE } from "./runBudget.js";
import {
  limitsFromFlags,
  loadConfiguredLimits,
  reportRunStop,
  startRunLimits,
} from "./runLimits.js";

describe("limitsFromFlags", () => {
  it("parses the flags", () => {
    expect(
      limitsFromFlags({
        maxBudgetUsd: "1.5",
        maxTurns: "4",
        maxDuration: "10",
      }),
    ).toEqual({ maxBudgetUsd: 1.5, maxTurns: 4, maxDurationMinutes: 10 });
  });
  it("rejects zero, negatives, text and fractional turns", () => {
    expect(() => limitsFromFlags({ maxBudgetUsd: "0" })).toThrow(/positive/);
    expect(() => limitsFromFlags({ maxTurns: "2.5" })).toThrow(/whole/);
    expect(() => limitsFromFlags({ maxDuration: "abc" })).toThrow(/positive/);
  });
});

describe("user settings", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "runlimits-"));
    fs.mkdirSync(path.join(home, ".continuous"), { recursive: true });
    delete process.env.CONTINUE_GLOBAL_DIR;
    delete process.env.CONTINUOUS_GLOBAL_DIR;
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const write = (runLimits: unknown) =>
    fs.writeFileSync(
      path.join(home, ".continuous", "settings.json"),
      JSON.stringify({ runLimits }),
    );

  it("reads caps from the user settings file", () => {
    write({ maxBudgetUsd: 3, maxTurns: 20, maxDurationMinutes: 15 });
    expect(loadConfiguredLimits(process.cwd(), home)).toEqual({
      maxBudgetUsd: 3,
      maxTurns: 20,
      maxDurationMinutes: 15,
    });
  });

  it("ignores bad values", () => {
    write({ maxBudgetUsd: "lots", maxTurns: -1 });
    expect(loadConfiguredLimits(process.cwd(), home)).toEqual({});
  });

  it("a flag tightens the configured cap but never loosens it", () => {
    write({ maxTurns: 10 });
    const warnings: string[] = [];
    const model = { provider: "anthropic", model: "claude-sonnet-5-5" };
    const tight = startRunLimits({ maxTurns: "4" }, model, { homeDir: home });
    expect(tight?.limits.maxTurns).toBe(4);
    const loose = startRunLimits({ maxTurns: "50" }, model, {
      homeDir: home,
      warn: (m) => warnings.push(m),
    });
    expect(loose?.limits.maxTurns).toBe(10);
    expect(warnings[0]).toMatch(/looser/);
  });

  it("refuses a dollar budget on an unpriced model unless allowed", () => {
    const local = { provider: "ollama", model: "llama3" };
    expect(() =>
      startRunLimits({ maxBudgetUsd: "1" }, local, { homeDir: home }),
    ).toThrow(/--budget-allow-unpriced/);
    expect(
      startRunLimits({ maxBudgetUsd: "1", budgetAllowUnpriced: true }, local, {
        homeDir: home,
      }),
    ).toBeDefined();
  });

  describe("a model only the community catalogue prices", () => {
    const mistral = { provider: "mistral", model: "mistral-large-latest" };
    let communityFile: string;
    const saved = process.env.CONTINUOUS_MODEL_INFO_UPDATES;
    beforeEach(() => {
      communityFile = path.join(home, "models-dev.json");
      writeCommunityCatalog(
        {
          schemaVersion: COMMUNITY_CATALOG_SCHEMA_VERSION,
          source: MODELS_DEV_URL,
          fetchedAt: "2026-11-10T08:00:00.000Z",
          prices: parseModelsDev(MODELS_DEV_TRIMMED),
        },
        communityFile,
      );
    });
    afterEach(() => {
      if (saved === undefined) delete process.env.CONTINUOUS_MODEL_INFO_UPDATES;
      else process.env.CONTINUOUS_MODEL_INFO_UPDATES = saved;
      setCommunityCatalog(undefined);
    });

    it("refuses --max-budget-usd on the community price, allows it with the flag", () => {
      process.env.CONTINUOUS_MODEL_INFO_UPDATES = "automatic";
      expect(() =>
        startRunLimits({ maxBudgetUsd: "1" }, mistral, {
          homeDir: home,
          communityFile,
        }),
      ).toThrow(/community catalogue \(models\.dev, 2026-11-10\)/);
      const b = startRunLimits(
        { maxBudgetUsd: "1", budgetAllowUnpriced: true },
        mistral,
        { homeDir: home, communityFile },
      );
      expect(b?.dollarCapActive).toBe(true);
    });

    it("with model information updates off the copy is not read at all", () => {
      process.env.CONTINUOUS_MODEL_INFO_UPDATES = "off";
      expect(() =>
        startRunLimits({ maxBudgetUsd: "1" }, mistral, {
          homeDir: home,
          communityFile,
        }),
      ).toThrow(/the cost table has no price for it/);
      const b = startRunLimits(
        { maxBudgetUsd: "1", budgetAllowUnpriced: true },
        mistral,
        { homeDir: home, communityFile },
      );
      expect(b?.dollarCapActive).toBe(false);
    });
  });
});

describe("reportRunStop", () => {
  it("returns the distinct exit code and says the reason once", () => {
    const out: string[] = [];
    const code = reportRunStop(
      { reason: "turns", phase: "before-call", detail: "Stopped: turns." },
      (t) => out.push(t),
    );
    expect(code).toBe(RUN_STOP_EXIT_CODE.turns);
    expect(out.join("")).toContain("Stopped: turns.");
  });
  it("writes JSON with --format json", () => {
    const out: string[] = [];
    reportRunStop(
      { reason: "budget", phase: "after-call", detail: "d", spentUsd: 1 },
      (t) => out.push(t),
      "json",
    );
    expect(JSON.parse(out.join(""))).toMatchObject({
      status: "stopped",
      reason: "budget",
      exitCode: RUN_STOP_EXIT_CODE.budget,
    });
  });
  it("uses three distinct non-zero codes", () => {
    const codes = Object.values(RUN_STOP_EXIT_CODE);
    expect(new Set(codes).size).toBe(3);
    expect(codes.every((c) => c > 3)).toBe(true);
  });
});
