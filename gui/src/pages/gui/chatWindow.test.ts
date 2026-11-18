import { describe, expect, it } from "vitest";
import { chatWindowRange } from "./chatWindow";

const flat = (count: number, height: number) =>
  Array.from({ length: count }, () => height);

describe("chatWindowRange", () => {
  it("mounts everything until the box has a height", () => {
    const range = chatWindowRange({
      count: 40,
      scrollTop: 0,
      viewport: 0,
      heights: flat(40, 100),
    });
    expect(range).toMatchObject({ start: 0, end: 40, top: 0, bottom: 0 });
  });

  it("mounts a short conversation in full", () => {
    const range = chatWindowRange({
      count: 2,
      scrollTop: 0,
      viewport: 500,
      heights: flat(2, 100),
    });
    expect(range).toMatchObject({
      start: 0,
      end: 2,
      top: 0,
      bottom: 0,
      total: 200,
    });
  });

  it("drops rows above and below a scrolled viewport", () => {
    const range = chatWindowRange({
      count: 20,
      scrollTop: 1000,
      viewport: 250,
      heights: flat(20, 100),
      estimate: 100,
      overscan: 1,
    });
    expect(range.start).toBe(9);
    expect(range.end).toBe(14);
    expect(range.top).toBe(900);
    expect(range.bottom).toBe(600);
    expect(range.top + (range.end - range.start) * 100 + range.bottom).toBe(
      range.total,
    );
    expect(range.end - range.start).toBeLessThan(20);
  });

  it("follows the end while the reply is streaming", () => {
    const range = chatWindowRange({
      count: 20,
      scrollTop: 0,
      viewport: 250,
      heights: flat(20, 100),
      estimate: 100,
      overscan: 1,
      stickToEnd: true,
    });
    expect(range.end).toBe(20);
    expect(range.start).toBe(15);
    expect(range.bottom).toBe(0);
    expect(range.top).toBe(1500);
  });

  it("uses a measured empty row as zero height without stalling the scan", () => {
    const heights = [100, 0, 0, 100, 100];
    const range = chatWindowRange({
      count: heights.length,
      scrollTop: 0,
      viewport: 150,
      heights,
      estimate: 100,
      overscan: 0,
    });
    expect(range.start).toBe(0);
    expect(range.end).toBeLessThan(heights.length);
    expect(range.total).toBe(300);
    expect(range.top + range.bottom).toBeGreaterThan(0);
  });
});
