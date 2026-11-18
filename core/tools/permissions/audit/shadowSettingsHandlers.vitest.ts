import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpendLedger } from "./shadowLedger";
import {
  registerShadowSettingsHandlers,
  type ShadowSettingsHost,
} from "./shadowSettingsHandlers";

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-handlers-"));
  file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, "name: Mine\nversion: 1.0.0\n");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function setup(host: Partial<ShadowSettingsHost> = {}) {
  const handlers = new Map<string, (m: { data: any }) => Promise<any>>();
  registerShadowSettingsHandlers((name, h) => handlers.set(name, h), {
    file,
    dir: path.join(dir, "audit"),
    trailEnabled: true,
    ...host,
  });
  return (name: string, data?: unknown) => handlers.get(name)!({ data });
}

describe("shadow settings messages", () => {
  it("reports the saved form and the ledger spend", async () => {
    const ledger = new SpendLedger({ dir: path.join(dir, "audit") });
    const r = await ledger.reserve({
      callId: "a",
      estimateUsd: 0.01,
      capUsd: 1,
    });
    if (r.ok) await ledger.settle(r.reservation, 0.004);
    const call = setup();
    const v = await call("audit/shadowSettings");
    expect(v.form).toEqual({ enabled: false, timeoutMs: 5000 });
    expect(v).toMatchObject({ spentUsd: 0.004, reviews: 1, reservedUsd: 0 });
  });

  it("asks in the IDE dialog before enabling, and says what is sent", async () => {
    const confirm = vi.fn(async (_text: string) => true);
    const call = setup({ confirm });
    const res = await call("audit/setShadowSettings", {
      enabled: true,
      budgetUsd: 0.5,
    });
    expect(res.result).toBe("saved");
    expect(confirm).toHaveBeenCalledOnce();
    const text = confirm.mock.calls[0][0];
    expect(text).toMatch(/sent to your reviewer model/);
    expect(text).toMatch(/\$0\.5/);
    expect(fs.readFileSync(file, "utf8")).toContain("enabled: true");
    expect(res.view.form.enabled).toBe(true);
  });

  it.each([
    ["declines", async () => false],
    ["throws", async () => Promise.reject(new Error("x"))],
  ])("writes nothing when the dialog %s", async (_n, confirm) => {
    const before = fs.readFileSync(file, "utf8");
    const call = setup({ confirm });
    const res = await call("audit/setShadowSettings", {
      enabled: true,
      budgetUsd: 1,
    });
    expect(res.result).toBe("refused");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("refuses to enable where the host cannot ask", async () => {
    const call = setup();
    const res = await call("audit/setShadowSettings", {
      enabled: true,
      budgetUsd: 1,
    });
    expect(res.result).toBe("refused");
    expect(fs.readFileSync(file, "utf8")).not.toContain("shadowReviewer");
  });

  it("does not ask to turn off or to change the budget while off", async () => {
    const confirm = vi.fn(async () => true);
    const call = setup({ confirm });
    expect(
      (await call("audit/setShadowSettings", { enabled: false })).result,
    ).toBe("unchanged");
    expect(
      (await call("audit/setShadowSettings", { budgetUsd: 2 })).result,
    ).toBe("saved");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("refuses a bad budget before asking", async () => {
    const confirm = vi.fn(async () => true);
    const call = setup({ confirm });
    for (const budgetUsd of [0, -3, 1e9, Number.NaN]) {
      const res = await call("audit/setShadowSettings", {
        enabled: true,
        budgetUsd,
      });
      expect(res.result).toBe("refused");
    }
    expect(confirm).not.toHaveBeenCalled();
  });
});
