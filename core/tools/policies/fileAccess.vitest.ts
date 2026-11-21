import { describe, expect, it } from "vitest";
import { evaluateFileAccessPolicy } from "./fileAccess";

const ASK = "allowedWithPermission" as const;
const RUN = "allowedWithoutPermission" as const;
const OFF = "disabled" as const;

describe("evaluateFileAccessPolicy", () => {
  it("keeps the base policy for a file inside the workspace", () => {
    expect(evaluateFileAccessPolicy(RUN, true)).toBe(RUN);
    expect(evaluateFileAccessPolicy(ASK, true)).toBe(ASK);
  });

  it("asks for a file outside the workspace by default", () => {
    expect(evaluateFileAccessPolicy(RUN, false)).toBe(ASK);
    expect(evaluateFileAccessPolicy(RUN, false, {})).toBe(ASK);
    expect(
      evaluateFileAccessPolicy(RUN, false, { outsideCheckOff: false }),
    ).toBe(ASK);
  });

  it("leaves it to the tool's own setting when the outside check is off", () => {
    expect(
      evaluateFileAccessPolicy(RUN, false, { outsideCheckOff: true }),
    ).toBe(RUN);
    expect(
      evaluateFileAccessPolicy(ASK, false, { outsideCheckOff: true }),
    ).toBe(ASK);
  });

  it("never enables a tool that is switched off, whatever the check says", () => {
    expect(evaluateFileAccessPolicy(OFF, true)).toBe(OFF);
    expect(evaluateFileAccessPolicy(OFF, false)).toBe(OFF);
    expect(
      evaluateFileAccessPolicy(OFF, false, { outsideCheckOff: true }),
    ).toBe(OFF);
  });
});
