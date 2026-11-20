import { describe, expect, it } from "vitest";
import {
  CHECK_OF_PROTECTION,
  checkOfProtection,
  protectionsWithCheckOff,
} from "./checkOfProtection";
import { BUILTIN_RULES } from "./policy";
import { builtinForDegree } from "./safetyDegrees";

const ids = new Set(BUILTIN_RULES.map((r) => r.id));

describe("CHECK_OF_PROTECTION", () => {
  it("names only checks that exist", () => {
    for (const id of Object.values(CHECK_OF_PROTECTION)) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it("covers every protection kind the evaluator can produce", () => {
    expect(Object.keys(CHECK_OF_PROTECTION).sort()).toEqual(
      [
        "config",
        "dependency-change",
        "destructive-command",
        "env-assignment",
        "fetch-and-run",
        "file-deputy",
        "hidden-command",
        "large-change",
        "mcp-definition-changed",
        "network",
        "private-url",
        "secret",
        "unknown-host",
      ].sort(),
    );
  });

  it("is what the shield shows: an outside path is the outside-paths check", () => {
    expect(checkOfProtection("file-deputy")).toBe("ask-outside-paths");
    expect(checkOfProtection("secret")).toBe("protect-secrets");
    expect(checkOfProtection("nonsense")).toBeUndefined();
    expect(checkOfProtection(undefined)).toBeUndefined();
  });
});

describe("protectionsWithCheckOff", () => {
  it("skips nothing while every check is on", () => {
    expect(protectionsWithCheckOff(undefined)).toEqual([]);
    expect(protectionsWithCheckOff({ builtin: {} })).toEqual([]);
  });

  it("skips every protection when no check is on, as after the IDGAF preset", () => {
    const all = protectionsWithCheckOff({ builtin: builtinForDegree("none") });
    expect(all.sort()).toEqual(Object.keys(CHECK_OF_PROTECTION).sort());
  });

  it("skips only the protections of the checks that are off", () => {
    expect(
      protectionsWithCheckOff({ builtin: { "ask-outside-paths": false } }),
    ).toEqual(["file-deputy"]);
    expect(
      protectionsWithCheckOff({ builtin: { "protect-secrets": false } }).sort(),
    ).toEqual(["private-url", "secret"]);
  });

  it("keeps the hard protections at 'a few on' and drops the asks", () => {
    const skipped = protectionsWithCheckOff({
      builtin: builtinForDegree("few"),
    });
    expect(skipped).toContain("file-deputy");
    expect(skipped).toContain("large-change");
    expect(skipped).not.toContain("secret");
    expect(skipped).not.toContain("fetch-and-run");
  });
});
