import { describe, expect, it } from "vitest";

import { commandMeterText, METER_MIN_BYTES } from "./commandMeter";

describe("commandMeterText", () => {
  it("says nothing for small output, or none", () => {
    expect(commandMeterText(undefined, true)).toBeUndefined();
    expect(
      commandMeterText(
        { bytes: METER_MIN_BYTES - 1, lines: 10, bytesPerSecond: 5 },
        true,
      ),
    ).toBeUndefined();
  });

  it("gives size, lines and, while running, the rate", () => {
    const stats = {
      bytes: 38_200_000,
      lines: 912_400,
      bytesPerSecond: 3_400_000,
    };
    expect(commandMeterText(stats, true)).toBe(
      "38.2 MB · 912k lines · 3.4 MB/s",
    );
    expect(commandMeterText(stats, false)).toBe("38.2 MB · 912k lines");
  });

  it("leaves the rate out when nothing came in the last second", () => {
    expect(
      commandMeterText(
        { bytes: 70_000, lines: 1_234, bytesPerSecond: 0 },
        true,
      ),
    ).toBe("70 KB · 1,234 lines");
  });

  it("counts millions of lines and gigabytes", () => {
    expect(
      commandMeterText(
        { bytes: 2_100_000_000, lines: 4_200_000, bytesPerSecond: 0 },
        false,
      ),
    ).toBe("2.1 GB · 4.2M lines");
  });
});
