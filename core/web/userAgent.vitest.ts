import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BROWSER_USER_AGENT_PRESETS,
  GENERIC_AGENT_USER_AGENT,
  isKnownUserAgentPreset,
  majorMinor,
  USER_AGENT_PRESETS_FILE,
  userAgentFor,
  WEB_AGENT_INFO_URL,
} from "./userAgent";

describe("userAgentPresets.json", () => {
  const raw = JSON.parse(
    fs.readFileSync(path.join(__dirname, "userAgentPresets.json"), "utf8"),
  );

  it("has a checkedAt date and a non-empty preset list", () => {
    expect(raw.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(raw.checkedAt))).toBe(false);
    expect(Array.isArray(raw.presets)).toBe(true);
    expect(raw.presets.length).toBeGreaterThan(0);
  });

  it("gives every preset a unique id, a label and a plausible header value", () => {
    const ids = new Set<string>();
    for (const p of raw.presets) {
      expect(Object.keys(p).sort()).toEqual(["id", "label", "userAgent"]);
      expect(p.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(ids.has(p.id)).toBe(false);
      ids.add(p.id);
      expect(p.label.trim()).not.toBe("");
      // A header value: visible ASCII and spaces only, no line breaks
      expect(p.userAgent).toMatch(/^Mozilla\/5\.0 \([\x20-\x7e]+$/);
    }
  });

  it("never reuses a built-in preset name", () => {
    for (const id of ["continuous", "generic-agent", "custom"]) {
      expect(raw.presets.some((p: { id: string }) => p.id === id)).toBe(false);
    }
  });

  it("covers Chrome, Edge and Firefox on Windows, macOS and Linux, and Safari on macOS", () => {
    for (const browser of ["chrome", "edge", "firefox"]) {
      for (const os of ["windows", "macos", "linux"]) {
        expect(isKnownUserAgentPreset(`${browser}-${os}`)).toBe(true);
      }
    }
    expect(isKnownUserAgentPreset("safari-macos")).toBe(true);
  });

  it("is the data the module serves", () => {
    expect(USER_AGENT_PRESETS_FILE.checkedAt).toBe(raw.checkedAt);
    expect(BROWSER_USER_AGENT_PRESETS).toEqual(raw.presets);
  });
});

describe("userAgentFor", () => {
  it("sends the product token with major.minor and the info URL by default", () => {
    expect(
      userAgentFor(undefined, { purpose: "user", version: "2.15.3" }),
    ).toBe(`Continuous-User/2.15 (+${WEB_AGENT_INFO_URL})`);
    expect(
      userAgentFor(
        { preset: "continuous" },
        { purpose: "crawler", version: "2.15.3" },
      ),
    ).toBe(`Continuous-Crawler/2.15 (+${WEB_AGENT_INFO_URL})`);
  });

  it("never leaks more than major.minor of the version", () => {
    expect(majorMinor("2.15.3-beta.4+abc")).toBe("2.15");
    expect(majorMinor(undefined)).toBe("0.0");
    expect(majorMinor("garbage")).toBe("0.0");
  });

  it("serves the other presets", () => {
    const o = { purpose: "user" as const, version: "1.2.3" };
    expect(userAgentFor({ preset: "generic-agent" }, o)).toBe(
      GENERIC_AGENT_USER_AGENT,
    );
    expect(userAgentFor({ preset: "custom", custom: "Me/1" }, o)).toBe("Me/1");
    expect(userAgentFor({ preset: "custom" }, o)).toBe("");
    expect(userAgentFor({ preset: "firefox-linux" }, o)).toContain("Firefox/");
    expect(userAgentFor({ preset: "unknown" }, o)).toMatch(
      /^Continuous-User\/1\.2 /,
    );
  });
});
