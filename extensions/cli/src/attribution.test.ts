import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  attributionInstructions,
  DEFAULT_ATTRIBUTION_TEXT,
  loadAttributionSettings,
} from "./attribution.js";

describe("attribution (opt-in, user settings only)", () => {
  let dir: string;
  let prior: string | undefined;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "attr-"));
    prior = process.env.CONTINUOUS_GLOBAL_DIR;
    process.env.CONTINUOUS_GLOBAL_DIR = dir;
  });
  afterEach(() => {
    if (prior === undefined) delete process.env.CONTINUOUS_GLOBAL_DIR;
    else process.env.CONTINUOUS_GLOBAL_DIR = prior;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const write = (v: unknown) =>
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(v));

  it("is off with no settings file, and adds nothing to the prompt", () => {
    const s = loadAttributionSettings(process.cwd());
    expect(s).toMatchObject({ commit: false, pullRequest: false });
    expect(attributionInstructions(s)).toBe("");
  });

  it("never names the upstream project or its address by default", () => {
    expect(DEFAULT_ATTRIBUTION_TEXT).not.toMatch(/continue\.dev/i);
    expect(DEFAULT_ATTRIBUTION_TEXT).not.toMatch(/Continue </);
    expect(DEFAULT_ATTRIBUTION_TEXT).toContain("Continuous");
  });

  it("turns on only what the user switched on", () => {
    write({ attribution: { commit: true } });
    const text = attributionInstructions(loadAttributionSettings());
    expect(text).toContain("commit messages");
    expect(text).not.toContain("pull request");
    expect(text).toContain(DEFAULT_ATTRIBUTION_TEXT);
  });

  it("uses the user's own text", () => {
    write({
      attribution: { commit: true, pullRequest: true, text: " Me <a@b.c> " },
    });
    const text = attributionInstructions(loadAttributionSettings());
    expect(text).toContain("commit messages and pull request descriptions");
    expect(text).toContain("\nMe <a@b.c>\n");
  });

  it("treats malformed settings as off", () => {
    fs.writeFileSync(path.join(dir, "settings.json"), "{nope");
    expect(loadAttributionSettings().commit).toBe(false);
    write({ attribution: { commit: "yes" } });
    expect(loadAttributionSettings().commit).toBe(false);
  });
});
