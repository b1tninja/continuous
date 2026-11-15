import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { setProjectConfigTrustedForRun } from "core/config/projectTrust.js";
import { DEFAULT_POLICY_LEVELS } from "core/tools/permissions/policy.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadLocalModelFiles } from "./localModelFiles.js";
import {
  getPolicyLevels,
  loadPolicyFile,
  resetPolicyLevels,
  setPolicyLevels,
} from "./permissions/policyLevels.js";
import {
  applySafeMode,
  capAtDefaults,
  isSafeMode,
  safeModeNotice,
  setSafeMode,
} from "./safeMode.js";
import { loadMarkdownSkills } from "./util/loadMarkdownSkills.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-safe-"));
});

afterEach(() => {
  setSafeMode(false);
  resetPolicyLevels();
  setProjectConfigTrustedForRun(false);
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("applySafeMode", () => {
  it("does nothing without --safe", () => {
    const lines: string[] = [];
    const options = { auto: true, allow: ["Bash"] };
    applySafeMode(options, (l) => lines.push(l));
    expect(isSafeMode()).toBe(false);
    expect(options).toEqual({ auto: true, allow: ["Bash"] });
    expect(lines).toEqual([]);
  });

  it("drops the flags that widen access and prints one line", () => {
    const lines: string[] = [];
    const options = {
      safe: true,
      auto: true,
      autoReview: true,
      allow: ["Bash"],
      agent: "owner/agent",
      mcp: ["owner/server"],
      trustProjectHooks: true,
      trustProjectConfig: true,
      ask: ["Write"],
      exclude: ["Fetch"],
    };
    applySafeMode(options, (l) => lines.push(l));
    expect(isSafeMode()).toBe(true);
    expect(options).toMatchObject({
      auto: false,
      autoReview: false,
      allow: [],
      agent: undefined,
      mcp: [],
      trustProjectHooks: false,
      trustProjectConfig: false,
      // Tightening flags are kept
      ask: ["Write"],
      exclude: ["Fetch"],
      // The headless broken-file check continues instead of refusing
      ignoreBrokenConfig: true,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      safeModeNotice([
        "--auto",
        "--auto-review",
        "--allow",
        "--agent",
        "--mcp",
        "--trust-project-hooks",
        "--trust-project-config",
      ]),
    );
    expect(lines[0]).toMatch(/^Safe mode: started without project/);
    expect(lines[0]).toContain("continuous doctor config");
  });

  it("does not list ignored flags when none were given", () => {
    expect(safeModeNotice([])).not.toContain("Ignored");
  });
});

describe("permission levels in safe mode", () => {
  it("caps each area at its default", () => {
    expect(
      capAtDefaults({
        context: "idgaf",
        tools: "permissive",
        edits: "manual",
        plan: "manual",
        questions: "automatic",
      }),
    ).toEqual({
      context: DEFAULT_POLICY_LEVELS.context,
      tools: DEFAULT_POLICY_LEVELS.tools,
      edits: "manual",
      plan: "manual",
      questions: DEFAULT_POLICY_LEVELS.questions,
    });
  });

  it("keeps the file's levels when they ask more, caps the rest", () => {
    const file = path.join(dir, "permissions.yaml");
    fs.writeFileSync(file, "levels:\n  tools: permissive\n  plan: manual\n");
    setSafeMode(true);
    loadPolicyFile(file);
    expect(getPolicyLevels().tools).toBe(DEFAULT_POLICY_LEVELS.tools);
    expect(getPolicyLevels().plan).toBe("manual");
  });

  it("caps --policy and /policy too", () => {
    setSafeMode(true);
    setPolicyLevels({ ...DEFAULT_POLICY_LEVELS, edits: "idgaf" });
    expect(getPolicyLevels().edits).toBe(DEFAULT_POLICY_LEVELS.edits);
    setSafeMode(false);
    setPolicyLevels({ ...DEFAULT_POLICY_LEVELS, edits: "idgaf" });
    expect(getPolicyLevels().edits).toBe("idgaf");
  });
});

describe("files safe mode does not read", () => {
  it("skills folders", async () => {
    const skill = path.join(dir, ".continuous", "skills", "s");
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(
      path.join(skill, "SKILL.md"),
      "---\nname: s\ndescription: d\n---\nbody\n",
    );
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    expect((await loadMarkdownSkills()).skills.map((s) => s.name)).toContain(
      "s",
    );
    setSafeMode(true);
    expect(await loadMarkdownSkills()).toEqual({ skills: [], errors: [] });
  });

  it("the project's providers.yaml, even when trusted", async () => {
    fs.mkdirSync(path.join(dir, ".continue"));
    fs.writeFileSync(
      path.join(dir, ".continue", "providers.yaml"),
      "providers:\n  - { name: projectone, provider: openai, apiBase: 'http://127.0.0.1:9/v1/' }\n",
    );
    setProjectConfigTrustedForRun(true);
    const names = () => loadLocalModelFiles(dir).providers.map((p) => p.name);
    expect(names()).toContain("projectone");
    setSafeMode(true);
    expect(names()).not.toContain("projectone");
  });
});
