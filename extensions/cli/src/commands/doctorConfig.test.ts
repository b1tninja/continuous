import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DEFAULT_POLICY_LEVELS } from "core/tools/permissions/policy.js";
import { writePolicyFile } from "core/tools/permissions/settingsFile.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as YAML from "yaml";

import {
  permissionsYamlProblem,
  readPermissionsYaml,
} from "../permissions/permissionsYamlLoader.js";

import { doctorCommand } from "./doctor.js";
import {
  collectDoctorConfig,
  DOCTOR_CONFIG_SCHEMA,
  doctorConfigCommand,
  renderDoctorConfig,
  type ControlReport,
  type DoctorConfigReport,
} from "./doctorConfig.js";
import {
  checkConfigYaml,
  checkHookSettings,
  checkPermissionsYaml,
  findJsonError,
} from "./doctorFiles.js";
import { checkMcpServers } from "./doctorMcp.js";

const SECRET = "sk-ant-api03-THISISASECRETVALUE1234567890abcdefghij";
const GLOBAL_VARS = ["CONTINUOUS_GLOBAL_DIR", "CONTINUE_GLOBAL_DIR"];

let root: string;
let home: string;
let globalDir: string;
let cwd: string;
let saved: Record<string, string | undefined>;

function write(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

const GOOD_CONFIG = `name: Mine
version: 0.0.1
schema: v1
models:
  - name: local
    provider: ollama
    model: qwen
`;

function collect(extra: Parameters<typeof collectDoctorConfig>[0] = {}) {
  return collectDoctorConfig({
    cwd,
    homeDir: home,
    globalDir,
    env: {},
    ...extra,
  });
}

function control(report: DoctorConfigReport, id: string): ControlReport {
  const found = report.controls.find((c) => c.id === id);
  if (!found) throw new Error(`no control ${id}`);
  return found;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-config-"));
  home = path.join(root, "home");
  globalDir = path.join(home, ".continuous");
  cwd = path.join(root, "project");
  fs.mkdirSync(globalDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  saved = {};
  for (const name of GLOBAL_VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of GLOBAL_VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("file checks", () => {
  it("finds the first JSON error without quoting the text", () => {
    expect(findJsonError('{"a": 1}')).toBeUndefined();
    const text = '{\n  "a": 1,\n  "b": }\n';
    const found = findJsonError(text);
    expect(found?.message).toBe("expected a value");
    expect(text.slice(0, found!.offset).split("\n").length).toBe(3);
  });

  it("reports a broken hook settings file by line and column, not by content", () => {
    const file = write(
      path.join(root, "settings.json"),
      `{\n  "hooks": {\n    "PreToolUse": [{ "hooks": [{ "type": "command", "command": "${SECRET}" ]\n  }\n}\n`,
    );
    const check = checkHookSettings(file);
    expect(check.state).toBe("broken");
    expect(check.errors[0].line).toBe(3);
    expect(check.errors[0].column).toBeGreaterThan(1);
    expect(JSON.stringify(check.errors)).not.toContain("sk-ant");
  });

  it("checks the shape of a hooks block", () => {
    const file = write(
      path.join(root, "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "(", hooks: [{ type: "command", command: "x" }] },
            { hooks: [{ type: "command" }] },
          ],
          NotAnEvent: [{ hooks: [{ type: "http", url: "http://h" }] }],
        },
      }),
    );
    const check = checkHookSettings(file);
    expect(check.state).toBe("broken");
    expect(check.errors.map((e) => e.key)).toEqual([
      "hooks.PreToolUse.0.matcher",
      "hooks.PreToolUse.1.hooks.0",
    ]);
    expect(check.warnings.map((w) => w.key)).toEqual(["hooks.NotAnEvent"]);
  });

  it("names the line of a YAML error and drops the quoted frame", () => {
    const file = write(
      path.join(root, "permissions.yaml"),
      `allow:\n  - Read\nfloor: [Bash(echo ${SECRET})\nask: []\n`,
    );
    const check = checkPermissionsYaml(file);
    expect(check.state).toBe("broken");
    expect(check.errors[0].line).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(check)).not.toContain("sk-ant");
  });

  it("says why the loader would skip a permissions.yaml that parses", () => {
    const file = write(
      path.join(root, "permissions.yaml"),
      "allow: Read\nexclude:\n  - Bash(\nfoo: 1\n",
    );
    const check = checkPermissionsYaml(file);
    expect(check.state).toBe("broken");
    expect(check.errors.map((e) => e.key).sort()).toEqual([
      "allow",
      "exclude.0",
      "foo",
    ]);
    expect(check.errors.find((e) => e.key === "exclude.0")?.line).toBe(3);
    expect(check.errors.find((e) => e.key === "foo")?.line).toBe(4);
  });

  it("reads a permissions.yaml holding a stored custom set (levels.custom) as a whole file", () => {
    // The Custom policy page keeps its set under levels, which every CLI
    // accepts, so this build and the ones before it read the allow list
    const file = write(
      path.join(root, "permissions.yaml"),
      "levels:\n  tools: cautious\nallow:\n  - Read\n",
    );
    writePolicyFile(file, {
      custom: {
        from: "careful",
        levels: { ...DEFAULT_POLICY_LEVELS, edits: "permissive" },
      },
    });
    expect(fs.readFileSync(file, "utf-8")).toContain("custom:");
    expect(checkPermissionsYaml(file).state).toBe("ok");
    const read = readPermissionsYaml(file);
    expect(read.status).toBe("ok");
    expect(read.status === "ok" && read.value.allow).toEqual(["Read"]);
    expect(
      permissionsYamlProblem(YAML.parse(fs.readFileSync(file, "utf-8"))),
    ).toBeUndefined();
  });

  it("points a config.yaml schema problem at its key and line", () => {
    const file = write(
      path.join(root, "config.yaml"),
      `name: Mine\nversion: 0.0.1\nschema: v1\nmodels:\n  - name: a\n    provider: openai\n    apiKey: ${SECRET}\n    model: 12\n`,
    );
    const check = checkConfigYaml(file);
    expect(check.state).toBe("broken");
    expect(check.errors.length).toBeGreaterThan(0);
    expect(check.errors.some((e) => e.line !== undefined)).toBe(true);
    expect(JSON.stringify(check.errors)).not.toContain("sk-ant");
  });

  it("accepts a good config.yaml and reports a missing one as absent", () => {
    const file = write(path.join(root, "config.yaml"), GOOD_CONFIG);
    expect(checkConfigYaml(file).state).toBe("ok");
    expect(checkConfigYaml(path.join(root, "none.yaml")).state).toBe("absent");
  });

  it("checks MCP entries and shows names, never arguments or values", () => {
    const servers = checkMcpServers({
      mcpServers: [
        {
          name: "files",
          command: "/usr/bin/npx",
          args: ["-y", "pkg", `--token=${SECRET}`],
          env: { API_TOKEN: SECRET },
        },
        { name: "remote", url: `https://user:${SECRET}@mcp.example.com/sse` },
        { name: "files", url: "ftp://x" },
        { command: "x", url: "http://y" },
        { uses: "owner/server" },
      ],
    });
    expect(servers.map((s) => s.state)).toEqual([
      "ok",
      "ok",
      "broken",
      "broken",
      "ok",
    ]);
    expect(servers[0]).toMatchObject({
      transport: "stdio",
      target: "npx",
      envNames: ["API_TOKEN"],
    });
    expect(servers[1].target).toBe("https://mcp.example.com");
    expect(JSON.stringify(servers)).not.toContain("sk-ant");
  });
});

describe("doctor config", () => {
  it("reports defaults when nothing is configured", () => {
    const report = collect();
    expect(report.schema).toBe(DOCTOR_CONFIG_SCHEMA);
    expect(report.ok).toBe(true);
    expect(report.files.map((f) => [f.id, f.state])).toEqual([
      ["config", "absent"],
      ["permissions", "absent"],
      ["hooks.user.claude", "absent"],
      ["hooks.user", "absent"],
    ]);
    expect(control(report, "level.tools")).toMatchObject({
      value: "cautious",
      source: "default",
    });
    expect(control(report, "preset")).toMatchObject({
      value: "Careful",
      source: "default",
    });
    expect(control(report, "protection.protect-secrets").value).toBe("on");
    expect(control(report, "taintedSessionRule").value).toBe("off");
    expect(control(report, "runLimit.maxTurns").value).toBeNull();
    expect(control(report, "hooks.project").value).toBe("none");
  });

  it("names the user file as the source of what it sets", () => {
    const permissions = write(
      path.join(globalDir, "permissions.yaml"),
      [
        "levels:",
        "  tools: permissive",
        "builtin:",
        "  ask-large-change: off",
        "floor:",
        "  - Bash(rm -rf *)",
        "allow:",
        "  - Read",
        "exclude:",
        "  - Fetch",
        "",
      ].join("\n"),
    );
    write(
      path.join(globalDir, "config.yaml"),
      `${GOOD_CONFIG}toolPermissions:\n  auto:\n    environment:\n      taintedSessionRule: ask\n`,
    );
    write(
      path.join(globalDir, "settings.json"),
      JSON.stringify({
        runLimits: { maxTurns: 40 },
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: "guard" }] }],
        },
      }),
    );
    const report = collect();
    expect(report.ok).toBe(true);
    expect(control(report, "level.tools")).toMatchObject({
      value: "permissive",
      source: "user-file",
      sourceDetail: permissions,
    });
    expect(control(report, "level.edits").source).toBe("default");
    expect(control(report, "preset")).toMatchObject({
      value: "Custom",
      source: "user-file",
    });
    expect(control(report, "protection.ask-large-change")).toMatchObject({
      value: "off",
      source: "user-file",
    });
    expect(control(report, "floor")).toMatchObject({
      value: 1,
      source: "user-file",
    });
    expect(control(report, "rules.allow").value).toBe(1);
    expect(control(report, "rules.exclude").value).toBe(1);
    expect(control(report, "taintedSessionRule")).toMatchObject({
      value: "ask",
      source: "user-file",
    });
    expect(control(report, "runLimit.maxTurns")).toMatchObject({
      value: 40,
      source: "user-file",
    });
    expect(control(report, "hooks.user")).toMatchObject({
      value: 1,
      source: "user-file",
    });
    // The floor rule's text is a rule, not a count: it is never printed.
    expect(JSON.stringify(report)).not.toContain("rm -rf");
  });

  it("names the flag when a flag decides", () => {
    write(
      path.join(globalDir, "permissions.yaml"),
      "levels:\n  tools: permissive\n  plan: manual\n",
    );
    write(
      path.join(globalDir, "settings.json"),
      JSON.stringify({ runLimits: { maxTurns: 40, maxBudgetUsd: 1 } }),
    );
    const report = collect({
      flags: {
        policy: "edits=cautious",
        maxTurns: "10",
        maxBudgetUsd: "5",
        exclude: ["Bash"],
      },
    });
    expect(control(report, "level.edits")).toMatchObject({
      value: "cautious",
      source: "flag",
      sourceDetail: "--policy",
    });
    expect(control(report, "level.tools").source).toBe("user-file");
    expect(control(report, "runLimit.maxTurns")).toMatchObject({
      value: 10,
      source: "flag",
    });
    // A flag cannot loosen a limit of yours, so the lower one is in force.
    expect(control(report, "runLimit.maxBudgetUsd")).toMatchObject({
      value: 1,
      source: "user-file",
    });
    expect(control(report, "rules.exclude")).toMatchObject({
      value: 1,
      source: "flag",
    });

    const auto = collect({ flags: { auto: true } });
    expect(control(auto, "level.tools")).toMatchObject({
      value: "idgaf",
      source: "flag",
      sourceDetail: "--auto",
    });
    expect(control(auto, "level.plan").sourceDetail).toBe("--auto");
  });

  it("reports the environment as a source", () => {
    const report = collect({ env: { CONTINUE_TERMINAL_ENV: "inherit" } });
    expect(control(report, "env.terminalEnvironment")).toMatchObject({
      source: "env",
      sourceDetail: "CONTINUE_TERMINAL_ENV",
    });
  });

  it("shows project hooks as held until trusted, and running with the flag", () => {
    write(
      path.join(cwd, ".continuous", "settings.json"),
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }] },
      }),
    );
    const held = collect();
    expect(held.files.some((f) => f.id === "hooks.project")).toBe(true);
    expect(control(held, "hooks.project")).toMatchObject({
      value: "1 not running (not trusted)",
      source: "default",
    });
    const trusted = collect({ flags: { trustProjectHooks: true } });
    expect(control(trusted, "hooks.project")).toMatchObject({
      value: "1 running (trusted)",
      source: "flag",
      sourceDetail: "--trust-project-hooks",
    });
  });

  it("shows project configuration files and whether they are trusted", () => {
    write(
      path.join(cwd, ".continuous", "mcpServers", "one.yaml"),
      "name: one\nversion: 0.0.1\nschema: v1\nmcpServers:\n  - name: one\n    command: npx\n",
    );
    const report = collect();
    expect(control(report, "project.mcp")).toMatchObject({
      value: "not trusted, not loaded",
      source: "default",
    });
    const flagged = collect({ flags: { trustProjectConfig: true } });
    expect(control(flagged, "project.mcp")).toMatchObject({
      value: "trusted, loaded",
      source: "flag",
    });
  });

  it("exits non-zero and never prints a secret when files are broken", async () => {
    write(
      path.join(globalDir, "config.yaml"),
      `name: Mine\nversion: 0.0.1\nschema: v1\nmodels:\n  - name: a\n    provider: anthropic\n    model: m\n    apiKey: ${SECRET}\n  bad indent: [\n`,
    );
    write(
      path.join(globalDir, "permissions.yaml"),
      `allow: [Bash(curl -H "Authorization: Bearer ${SECRET}")\n`,
    );
    write(
      path.join(globalDir, "settings.json"),
      `{ "hooks": { "PreToolUse": "${SECRET}" `,
    );
    for (const json of [false, true]) {
      const lines: string[] = [];
      const code = doctorConfigCommand({
        cwd,
        homeDir: home,
        globalDir,
        env: {},
        json,
        write: (line) => lines.push(line),
      });
      const text = lines.join("\n");
      expect(code).toBe(1);
      expect(text).not.toContain("sk-ant");
      expect(text).not.toContain("THISISASECRET");
      if (json) {
        const parsed = JSON.parse(text) as DoctorConfigReport;
        expect(parsed.ok).toBe(false);
        expect(parsed.problems).toBe(3);
        expect(
          parsed.files.filter((f) => f.state === "broken").map((f) => f.id),
        ).toEqual(["config", "permissions", "hooks.user"]);
        expect(parsed.files[0].errors[0].line).toBeGreaterThan(0);
      } else {
        expect(text).toMatch(/broken\s+config\.yaml \(user\)/);
        expect(text).toMatch(/line \d+, column \d+: not valid YAML/);
        expect(text).toContain("Result: 3 problems.");
      }
    }
  });

  it("keeps the JSON shape stable", () => {
    const report = collect();
    expect(Object.keys(report)).toEqual([
      "schema",
      "ok",
      "problems",
      "globalDir",
      "cwd",
      "files",
      "mcpServers",
      "controls",
    ]);
    expect(report.controls.map((c) => c.id)).toEqual([
      "config.file",
      "level.context",
      "level.tools",
      "level.edits",
      "level.plan",
      "level.questions",
      "preset",
      "floor",
      "rules.exclude",
      "rules.ask",
      "rules.allow",
      "protection.protect-secrets",
      "protection.protect-config",
      "protection.protect-network-paths",
      "protection.refuse-dangerous-commands",
      "protection.no-fetch-and-run",
      "protection.ask-destructive-commands",
      "protection.ask-large-change",
      "protection.ask-dependency-change",
      "protection.ask-unknown-host",
      "protection.ask-outside-paths",
      "protection.plan-keeps-checks",
      "taintedSessionRule",
      "hooks.user",
      "hooks.project",
      "hooks.disableAllHooks",
      "project.config",
      "env.globalDir",
      "env.terminalEnvironment",
      "runLimit.maxBudgetUsd",
      "runLimit.maxTurns",
      "runLimit.maxDurationMinutes",
    ]);
    for (const c of report.controls) {
      expect(["default", "user-file", "project-file", "flag", "env"]).toContain(
        c.source,
      );
    }
  });

  it("checks the file given to config check", () => {
    const file = write(path.join(root, "other.yaml"), "name: [\n");
    const report = collect({ configFile: file });
    expect(report.files[0]).toMatchObject({ path: file, state: "broken" });
    expect(control(report, "config.file").source).toBe("flag");
    expect(collect({ configFile: path.join(root, "gone.yaml") }).ok).toBe(
      false,
    );
  });

  it("renders one line per file and per control", () => {
    write(path.join(globalDir, "config.yaml"), GOOD_CONFIG);
    const lines = renderDoctorConfig(collect());
    expect(lines.some((l) => /^ {2}ok\s+config\.yaml \(user\)/.test(l))).toBe(
      true,
    );
    expect(lines.some((l) => /Tool use\s+cautious\s+default/.test(l))).toBe(
      true,
    );
    expect(lines.at(-1)).toBe("Result: every file that exists was read.");
  });
});

describe("doctor topics", () => {
  it("lists the topics when none or an unknown one is given", async () => {
    const lines: string[] = [];
    const code = await doctorCommand("nope", [], {
      write: (line) => lines.push(line),
    });
    expect(code).toBe(1);
    expect(lines[0]).toBe("Usage: continuous doctor <topic>");
    expect(lines.join("\n")).toMatch(/config\s/);
    expect(lines.join("\n")).toMatch(/network\s/);
  });
});
