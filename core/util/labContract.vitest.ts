import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as contract from "./labContract";

const read = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, name), "utf8"));
const golden = read("labContract.golden.json");
const pin = read("labContract.pin.json");

/** Exports, function arities and constant values: what a lab build depends on. */
function surface(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(contract).sort()) {
    const v = (contract as Record<string, unknown>)[key];
    out[key] = typeof v === "function" ? { function: v.length } : { value: v };
  }
  return out;
}

const close = (a: number, b: number) => Math.abs(a - b) < 1e-12;

describe("lab contract pin", () => {
  it("the pinned version is the exported version", () => {
    expect(pin.version).toBe(contract.LAB_CONTRACT_VERSION);
    expect(golden.contractVersion).toBe(contract.LAB_CONTRACT_VERSION);
  });

  it("the exported surface matches the pin; changing it means bumping LAB_CONTRACT_VERSION and regenerating labContract.pin.json and labContract.golden.json", () => {
    expect(JSON.parse(JSON.stringify(surface()))).toEqual(pin.surface);
  });
});

describe("lab contract golden vectors", () => {
  it("wilson and formatRate", () => {
    for (const v of golden.wilson) {
      const r = contract.wilson(v.k, v.n);
      expect(r.k).toBe(v.rate.k);
      expect(r.n).toBe(v.rate.n);
      for (const f of ["rate", "lo", "hi"] as const) {
        expect(close(r[f], v.rate[f])).toBe(true);
      }
      expect(contract.formatRate(r)).toBe(v.text);
    }
  });

  it("wilson rejects impossible counts", () => {
    expect(() => contract.wilson(4, 3)).toThrow(RangeError);
    expect(() => contract.wilson(-1, 3)).toThrow(RangeError);
    expect(() => contract.wilson(1.5, 3)).toThrow(RangeError);
  });

  it("slug and captureFixtureId", () => {
    for (const v of golden.slug) expect(contract.slug(v.input)).toBe(v.output);
    for (const v of golden.fixtureId) {
      expect(contract.captureFixtureId(v.input)).toBe(v.output);
    }
  });

  it("validateProbeResult", () => {
    for (const v of golden.validateProbeResult) {
      expect(contract.validateProbeResult(v.input)).toEqual(v.problems);
    }
  });

  it("validateServerIdentity and serverIdentityLabel", () => {
    for (const v of golden.validateServerIdentity) {
      expect(contract.validateServerIdentity(v.input)).toEqual(v.problems);
    }
    for (const v of golden.serverIdentityLabel) {
      expect(contract.serverIdentityLabel(v.input)).toBe(v.output);
    }
  });

  it("is pure: the module imports nothing", () => {
    const src = fs.readFileSync(path.join(__dirname, "labContract.ts"), "utf8");
    expect(src).not.toMatch(/^\s*(import|export\s.*\sfrom)\s/m);
  });
});
