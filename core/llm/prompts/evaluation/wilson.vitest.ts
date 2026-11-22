import { describe, expect, it } from "vitest";
import { wilsonInterval } from "./wilson";

describe("wilsonInterval", () => {
  // Reference values: Newcombe 1998 (method 3) gives 81/263 as 0.2553 to
  // 0.3662; the others are the closed form worked by hand.
  it.each([
    [81, 263, 0.2553, 0.3662],
    [0, 10, 0, 0.2775],
    [10, 10, 0.7225, 1],
    [5, 10, 0.2366, 0.7634],
    [1, 8, 0.0224, 0.4709],
    [9, 27, 0.1864, 0.5218],
  ])("%i of %i is %f to %f", (k, n, low, high) => {
    const [lo, hi] = wilsonInterval(k, n);
    expect(lo).toBeCloseTo(low, 4);
    expect(hi).toBeCloseTo(high, 4);
  });

  it("stays inside 0..1 and has width at the ends, where the normal approximation has none", () => {
    for (const n of [1, 3, 10, 33]) {
      const [lo0, hi0] = wilsonInterval(0, n);
      const [lo1, hi1] = wilsonInterval(n, n);
      expect(lo0).toBe(0);
      expect(hi0).toBeGreaterThan(0);
      expect(hi1).toBe(1);
      expect(lo1).toBeLessThan(1);
    }
  });

  it("narrows as trials grow and says nothing with none", () => {
    const width = (k: number, n: number) => {
      const [lo, hi] = wilsonInterval(k, n);
      return hi - lo;
    };
    expect(width(30, 100)).toBeLessThan(width(3, 10));
    expect(wilsonInterval(0, 0)).toEqual([0, 1]);
  });

  it("takes another z", () => {
    // 90%: z = 1.6449
    const [lo, hi] = wilsonInterval(5, 10, 1.6449);
    expect(lo).toBeCloseTo(0.2693, 3);
    expect(hi).toBeCloseTo(0.7307, 3);
  });
});
