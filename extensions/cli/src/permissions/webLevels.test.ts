import fs from "fs";
import os from "os";
import path from "path";

import {
  DEFAULT_POLICY_LEVELS,
  POLICY_PRESETS,
  presetOf,
  type PolicyLevels,
} from "core/tools/permissions/policy.js";
import { readPolicyFile } from "core/tools/permissions/settingsFile.js";
import {
  resetWebGrantsForTests,
  WebGrantStore,
} from "core/tools/permissions/webGrants.js";
import { afterEach, describe, expect, it } from "vitest";

import { announceHeadlessPolicy } from "../flags/flagProcessor.js";
import { capAtDefaults } from "../safeMode.js";

import { evaluateWithCoreRules, setAutoReviewEnabled } from "./coreRules.js";
import { headlessPolicyNotice } from "./headlessPolicy.js";
import {
  describePolicy,
  effectiveLevels,
  getPolicyLevels,
  loadPolicyFile,
  parsePolicySpec,
  policyIsDefault,
  resetPolicyLevels,
  savePolicyFile,
  setPolicyLevels,
} from "./policyLevels.js";

/**
 * WB45 in the CLI: the Web level through the existing `--policy area=level`
 * plumbing, the headless start-up line, and core's engine deciding a Fetch.
 * (`--web` and `/policy web=` are WB48.)
 */

afterEach(() => {
  resetPolicyLevels();
  setAutoReviewEnabled(false);
  resetWebGrantsForTests();
});

const careful = DEFAULT_POLICY_LEVELS;

describe("--policy web=<level>", () => {
  it("sets Web alone, Off and Listed included", () => {
    for (const level of [
      "off",
      "manual",
      "cautious",
      "listed",
      "automatic",
      "permissive",
      "idgaf",
    ] as const) {
      const r = parsePolicySpec(`web=${level}`, careful);
      expect(r.ok && r.levels).toEqual({ ...careful, web: level });
    }
  });

  it("combines with the other areas", () => {
    const r = parsePolicySpec("tools=permissive,web=listed", careful);
    expect(r.ok && r.levels.tools).toBe("permissive");
    expect(r.ok && r.levels.web).toBe("listed");
  });

  it("Off and Listed are Web levels only, and an unknown level is refused", () => {
    const tools = parsePolicySpec("tools=listed", careful);
    expect(tools.ok).toBe(false);
    expect(!tools.ok && tools.error).toContain("Web level only");
    const odd = parsePolicySpec("web=sometimes", careful);
    expect(odd.ok).toBe(false);
    expect(!odd.ok && odd.error).toContain("listed, automatic");
  });

  it("a preset clears a Web level set before: Web follows Tool use again", () => {
    const listed = { ...careful, web: "listed" as const };
    const r = parsePolicySpec("handsOff", listed);
    expect(r.ok && r.levels.web).toBeUndefined();
    expect(r.ok && presetOf(r.levels)).toBe("handsOff");
    const bare = parsePolicySpec("permissive", listed);
    expect(bare.ok && bare.levels.web).toBeUndefined();
  });

  it("Off and Listed make the preset Custom in /policy", () => {
    const lines = describePolicy({ ...careful, web: "listed" });
    expect(lines[0]).toBe("Preset: Custom");
    expect(lines.join("\n")).toMatch(/Web\s+Listed\s+Only domains you allowed/);
  });

  it("/policy says when Web follows Tool use", () => {
    const text = describePolicy(careful).join("\n");
    expect(text).toMatch(/Web\s+Cautious .*\(follows Tool use\)/);
    expect(describePolicy(careful)[0]).toBe("Preset: Careful");
  });
});

describe("the levels in force", () => {
  it("a Web level of its own is not the defaults", () => {
    expect(policyIsDefault(careful)).toBe(true);
    expect(policyIsDefault({ ...careful, web: "cautious" })).toBe(false);
  });

  it("--auto-review makes a Cautious Web Automatic, as it does Tool use", () => {
    setAutoReviewEnabled(true);
    setPolicyLevels({ ...careful, web: "cautious" });
    expect(effectiveLevels("normal").web).toBe("automatic");
    setPolicyLevels({ ...careful, web: "listed" });
    expect(effectiveLevels("normal").web).toBe("listed");
  });

  it("--safe caps Web at Cautious and keeps Off and Listed", () => {
    expect(capAtDefaults({ ...careful, web: "permissive" }).web).toBe(
      "cautious",
    );
    expect(capAtDefaults({ ...careful, web: "listed" }).web).toBe("listed");
    expect(capAtDefaults({ ...careful, web: "off" }).web).toBe("off");
    expect(capAtDefaults(careful).web).toBeUndefined();
  });

  it("saves and loads levels.web; a preset saved afterwards clears it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-levels-"));
    try {
      const file = path.join(dir, "permissions.yaml");
      setPolicyLevels({ ...careful, web: "listed" });
      savePolicyFile(file);
      expect(readPolicyFile(file).settings.levels.web).toBe("listed");
      resetPolicyLevels();
      loadPolicyFile(file);
      expect(getPolicyLevels().web).toBe("listed");
      const preset = parsePolicySpec("careful");
      if (!preset.ok) throw new Error(preset.error);
      setPolicyLevels(preset.levels);
      savePolicyFile(file);
      expect(readPolicyFile(file).settings.levels.web).toBeUndefined();
      // IDGAF is never written
      setPolicyLevels({ ...careful, web: "idgaf" });
      savePolicyFile(file);
      expect(readPolicyFile(file).settings.levels.web).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the headless start-up line", () => {
  it("names the Web level and says Cautious runs only allowed domains", () => {
    const line = headlessPolicyNotice({ levels: careful });
    expect(line).toContain("Web Cautious (unattended: only allowed domains)");
  });

  it("says so when the CLI's own lists let Fetch run on any domain", () => {
    const line = headlessPolicyNotice({ levels: careful, fetchAllowed: true });
    expect(line).toContain(
      "Web Cautious (unattended: fetches run where your tool settings allow them; one that would ask is refused)",
    );
  });

  it("the start-up line of a real headless run names Web", () => {
    const out: string[] = [];
    announceHeadlessPolicy({}, (l) => out.push(l));
    expect(out[0]).toMatch(/; Web Cautious \(unattended: /);
  });

  it("says Off is locked by web.enabled", () => {
    const line = headlessPolicyNotice({ levels: careful, webEnabled: false });
    expect(line).toContain("Web Off (config.yaml: web.enabled)");
  });

  it("follows a Web level of its own", () => {
    const line = headlessPolicyNotice({
      levels: { ...POLICY_PRESETS.handsOff.levels, web: "listed" },
      source: "--policy tools=permissive,web=listed",
    });
    expect(line).toContain("Web Listed;");
  });
});

describe("core's engine decides a CLI Fetch", () => {
  const fetch = (
    url: string,
    levels: Partial<PolicyLevels>,
    extra: Partial<Parameters<typeof evaluateWithCoreRules>[0]> = {},
  ) =>
    evaluateWithCoreRules({
      cliToolName: "Fetch",
      args: { url },
      cliPermission: "ask",
      assistantPermissions: undefined,
      approval: { levels: { ...careful, ...levels } },
      isHeadless: false,
      ...extra,
    });

  it("Listed refuses a host nobody allowed", async () => {
    const v = await fetch("https://new.example/", { web: "listed" });
    expect(v?.decision).toBe("deny");
    expect(v?.reason).toContain("Web is Listed");
  });

  it("Off refuses a Fetch that still arrives", async () => {
    const v = await fetch("https://docs.example/", { web: "off" });
    expect(v?.decision).toBe("deny");
  });

  it("web.enabled: false refuses at IDGAF too", async () => {
    const v = await fetch(
      "https://docs.example/",
      POLICY_PRESETS.idgaf.levels,
      {
        web: { enabled: false },
      },
    );
    expect(v?.decision).toBe("deny");
  });

  it("Cautious asks for a new host, which a headless run refuses", async () => {
    const v = await fetch("https://new.example/", {}, { isHeadless: true });
    expect(v?.decision).toBe("ask");
  });

  it("a session grant runs at Cautious", async () => {
    const grants = new WebGrantStore();
    grants.allowOnce("granted.example");
    const v = await fetch("https://granted.example/x", {}, { web: { grants } });
    expect(v?.decision).toBe("allow");
  });

  it("the cloud metadata address is refused at IDGAF", async () => {
    const v = await fetch(
      "http://169.254.169.254/latest/meta-data/",
      POLICY_PRESETS.idgaf.levels,
    );
    expect(v?.decision).toBe("deny");
    expect(v?.reason).toContain("cloud metadata");
  });
});
