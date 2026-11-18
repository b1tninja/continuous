import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkShadowChange,
  MAX_SHADOW_BUDGET_USD,
  readShadowForm,
  writeShadowChange,
} from "./shadowConfig";
import { readShadowSettings } from "./shadowSettings";

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-config-"));
  file = path.join(dir, "config.yaml");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const BASE = `# my config
name: Mine
version: 1.0.0
models: []   # none yet

audit:
  # keep it short
  retentionDays: 10
rules:
  - be brief
`;

describe("checkShadowChange", () => {
  it("accepts a sane change and rounds the budget", () => {
    expect(
      checkShadowChange({
        enabled: true,
        budgetUsd: 0.123456,
        timeoutMs: 4000,
      }),
    ).toEqual({
      ok: true,
      change: { enabled: true, budgetUsd: 0.1235, timeoutMs: 4000 },
    });
  });

  it("ignores every other field the page sends", () => {
    const r = checkShadowChange({ enabled: false, models: [], audit: {} });
    expect(r).toEqual({ ok: true, change: { enabled: false } });
  });

  it.each([
    [0],
    [-1],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [MAX_SHADOW_BUDGET_USD + 1],
    ["5"],
    [0.00001],
  ])("refuses the budget %s", (budgetUsd) => {
    expect(checkShadowChange({ budgetUsd }).ok).toBe(false);
  });

  it.each([[100], [15_001], [1.5], [Number.NaN], ["5000"]])(
    "refuses the timeout %s",
    (timeoutMs) => {
      expect(checkShadowChange({ timeoutMs }).ok).toBe(false);
    },
  );

  it("refuses an empty change and a non-boolean switch", () => {
    expect(checkShadowChange({}).ok).toBe(false);
    expect(checkShadowChange(undefined).ok).toBe(false);
    expect(checkShadowChange({ enabled: "yes" }).ok).toBe(false);
  });
});

describe("writeShadowChange", () => {
  it("writes only the three keys, keeping comments and order", () => {
    fs.writeFileSync(file, BASE);
    const res = writeShadowChange(
      { enabled: true, budgetUsd: 0.25, timeoutMs: 4000 },
      file,
    );
    expect(res.result).toBe("saved");
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain("# my config");
    expect(text).toContain("# none yet");
    expect(text).toContain("# keep it short");
    expect(text).toContain("retentionDays: 10");
    expect(text).toContain("- be brief");
    expect(text.indexOf("name:")).toBeLessThan(text.indexOf("audit:"));
    expect(text.indexOf("audit:")).toBeLessThan(text.indexOf("rules:"));
    expect(readShadowSettings(file)).toEqual({
      budgetUsd: 0.25,
      timeoutMs: 4000,
    });
  });

  it("changes nothing outside audit.shadowReviewer", () => {
    fs.writeFileSync(file, BASE);
    writeShadowChange({ enabled: true, budgetUsd: 1 }, file);
    const strip = (t: string) =>
      t
        .split("\n")
        .filter((l) => !/shadowReviewer|enabled: true|budgetUsd/.test(l))
        .join("\n")
        .replace(/ +#/g, " #")
        .replace(/\n{2,}/g, "\n");
    expect(strip(fs.readFileSync(file, "utf8")).trim()).toBe(
      strip(BASE).trim(),
    );
  });

  it("creates the audit block when there is none", () => {
    fs.writeFileSync(file, "name: Mine\nversion: 1.0.0\n");
    writeShadowChange({ enabled: true, budgetUsd: 2 }, file);
    expect(readShadowForm(file)).toMatchObject({ enabled: true, budgetUsd: 2 });
  });

  it("turns off without touching the saved budget, and keeps unknown keys", () => {
    fs.writeFileSync(
      file,
      "audit:\n  shadowReviewer:\n    enabled: true\n    budgetUsd: 0.5\n    note: mine\n",
    );
    writeShadowChange({ enabled: false }, file);
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain("enabled: false");
    expect(text).toContain("budgetUsd: 0.5");
    expect(text).toContain("note: mine");
    expect(readShadowSettings(file)).toBeUndefined();
  });

  it("writes nothing to switch off a block that is not there", () => {
    fs.writeFileSync(file, BASE);
    expect(writeShadowChange({ enabled: false }, file).result).toBe(
      "unchanged",
    );
    expect(fs.readFileSync(file, "utf8")).toBe(BASE);
  });

  it("refuses to turn on without a budget anywhere", () => {
    fs.writeFileSync(file, BASE);
    const res = writeShadowChange({ enabled: true }, file);
    expect(res.result).toBe("refused");
    expect(fs.readFileSync(file, "utf8")).toBe(BASE);
  });

  it("turns on with the budget already saved", () => {
    fs.writeFileSync(
      file,
      "audit:\n  shadowReviewer:\n    enabled: false\n    budgetUsd: 0.5\n",
    );
    expect(writeShadowChange({ enabled: true }, file).result).toBe("saved");
    expect(readShadowSettings(file)?.budgetUsd).toBe(0.5);
  });

  it("leaves a file that does not exist or does not parse alone", () => {
    expect(
      writeShadowChange({ enabled: true, budgetUsd: 1 }, file).result,
    ).toBe("refused");
    expect(fs.existsSync(file)).toBe(false);
    fs.writeFileSync(file, "audit: [unclosed\n  x: : :");
    const bad = fs.readFileSync(file, "utf8");
    expect(
      writeShadowChange({ enabled: true, budgetUsd: 1 }, file).result,
    ).toBe("refused");
    expect(fs.readFileSync(file, "utf8")).toBe(bad);
  });

  it("refuses an audit key that is not a mapping, unchanged", () => {
    fs.writeFileSync(file, "audit: off\n");
    expect(
      writeShadowChange({ enabled: true, budgetUsd: 1 }, file).result,
    ).toBe("refused");
    expect(fs.readFileSync(file, "utf8")).toBe("audit: off\n");
  });
});
