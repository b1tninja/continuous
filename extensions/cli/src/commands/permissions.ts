/**
 * `continuous permissions list [--area A] [--json]` and
 * `continuous permissions test <tool> <arg...>`: the same data as the
 * Permissions page in the IDE (core/tools/permissions/effectiveRules.ts and
 * testToolCall.ts). `list` and `test` write nothing, run nothing and ask no
 * model. `add`, `remove` and `adopt` change your own rules (permissionsEdit.ts).
 */

import path from "node:path";

import {
  listEffectiveRules,
  type EffectiveRule,
  type EffectiveRulesReport,
} from "core/tools/permissions/effectiveRules.js";
import {
  POLICY_AREAS,
  POLICY_LEVELS,
  type PolicyArea,
  type PolicyLevel,
  type PolicyLevels,
} from "core/tools/permissions/policy.js";
import { readRuleSources } from "core/tools/permissions/readRuleSources.js";
import {
  testToolCall,
  TESTABLE_TOOLS,
  type ToolCallTestResult,
} from "core/tools/permissions/testToolCall.js";
import { readUserEnvNames } from "core/tools/permissions/userEnvNames.js";

import { env } from "../env.js";
import { PERMISSIONS_YAML_PATH } from "../permissions/permissionsYamlLoader.js";

import { printBuiltins } from "./permissionsBuiltins.js";
import {
  addCommand,
  adoptCommand,
  removeCommand,
  type PermissionsEditOptions,
} from "./permissionsEdit.js";

export interface PermissionsCommandOptions extends PermissionsEditOptions {
  json?: boolean;
  area?: string;
  mode?: string;
  /** `area=level`, repeatable: levels to test with */
  level?: string[] | string;
  /** The text a tool returned, to see whether the injection notice applies */
  output?: string;
  /** Where the files are; default to the CLI's global directory */
  configFile?: string;
  permissionsFile?: string;
  cwd?: string;
}

const defaultOut = (line = ""): void => {
  process.stdout.write(`${line}\n`);
};
const defaultErr = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

export interface PermissionsIo {
  out?: (line: string) => void;
  err?: (line: string) => void;
}

function sources(options: PermissionsCommandOptions) {
  return readRuleSources({
    configFile:
      options.configFile ?? path.join(env.continueHome, "config.yaml"),
    permissionsFile: options.permissionsFile ?? PERMISSIONS_YAML_PATH,
    // The CLI's own assistant configuration is not loaded here: this command
    // reads files only, so an assistant's rules are not listed.
    withFolder: false,
  });
}

function ruleLine(r: EffectiveRule): string {
  const flags = [
    r.state === "ignored" ? "ignored" : undefined,
    r.locked ? "locked" : undefined,
  ].filter(Boolean);
  const dialect = r.dialect === "cli" && r.core ? ` = ${r.core}` : "";
  const cli = r.dialect === "core" && r.cli ? ` (CLI: ${r.cli})` : "";
  return `  ${r.decision.toUpperCase().padEnd(5)} ${r.raw}${dialect}${cli}  [${r.source}${flags.length ? `, ${flags.join(", ")}` : ""}]`;
}

function printRules(rules: EffectiveRule[], out: (line: string) => void): void {
  if (rules.length === 0) {
    out("  (no rules)");
    return;
  }
  for (const r of rules) {
    out(ruleLine(r));
    if (r.state === "ignored" && r.ignoredReason) {
      out(`        ignored: ${r.ignoredReason}`);
    }
    for (const w of r.warnings) out(`        warning: ${w}`);
  }
}

function listCommand(
  options: PermissionsCommandOptions,
  io: Required<PermissionsIo>,
): number {
  let area: PolicyArea | undefined;
  if (options.area !== undefined) {
    if (!POLICY_AREAS.includes(options.area as PolicyArea)) {
      io.err(`Unknown area "${options.area}". Use: ${POLICY_AREAS.join(", ")}`);
      return 1;
    }
    area = options.area as PolicyArea;
  }
  const report: EffectiveRulesReport = listEffectiveRules(sources(options));
  if (options.json) {
    io.out(
      JSON.stringify(
        area ? { area: report.areas[area], notices: report.notices } : report,
        null,
        2,
      ),
    );
    return 0;
  }
  for (const a of area ? [area] : POLICY_AREAS) {
    const r = report.areas[a];
    io.out(`${r.label}: ${r.levelLabel}`);
    if (a === "plan" || a === "questions") {
      io.out("  (a level and a few settings, not rules)");
      if (r.settings?.kind === "plan") {
        io.out(
          `  re-plan may add ${r.settings.maxNewItems} new to-dos at Permissive; keeps checks: ${r.settings.keepsChecks ? "on" : "off"}`,
        );
      }
      if (r.settings?.kind === "questions") {
        io.out(`  you decide: ${r.settings.youDecide.join(", ") || "none"}`);
        io.out(
          `  agent may decide: ${r.settings.agentDecides.join(", ") || "none"}`,
        );
      }
    } else {
      printRules(r.rules, io.out);
      printBuiltins(r.builtins, io.out);
    }
    io.out("");
  }
  if (!area && report.unscoped.length) {
    io.out("No area");
    printRules(report.unscoped, io.out);
    io.out("");
  }
  io.out(report.decisionOrder);
  for (const n of report.notices) io.out(`note: ${n}`);
  return 0;
}

/** `area=level` pairs into the levels to test with, or a message about the first bad one. */
function parseLevels(
  raw: string[] | string | undefined,
): { levels: Partial<PolicyLevels> } | { error: string } {
  const levels: Partial<PolicyLevels> = {};
  for (const pair of Array.isArray(raw) ? raw : raw ? [raw] : []) {
    const [area, level] = pair.split("=");
    if (!POLICY_AREAS.includes(area as PolicyArea)) {
      return { error: `--level ${pair}: unknown area "${area}"` };
    }
    if (!POLICY_LEVELS.includes(level as PolicyLevel)) {
      return {
        error: `--level ${pair}: "${level}" is not a level (${POLICY_LEVELS.join(", ")})`,
      };
    }
    levels[area as PolicyArea] = level as PolicyLevel;
  }
  return { levels };
}

function printResult(r: ToolCallTestResult, out: (line: string) => void): void {
  out(`${r.decision.toUpperCase()}${r.source ? ` (${r.source})` : ""}`);
  out(r.reason);
  if (r.area) out(`Area: ${r.area}${r.level ? `, level ${r.level}` : ""}`);
  for (const m of r.matchedRules) {
    out(
      `Matches: ${m.decision} ${m.raw} [${m.source}]${m.deciding ? " <- decided" : ""}`,
    );
  }
  for (const f of r.lint) out(`Command check ${f.code}: ${f.message}`);
  out("Steps:");
  for (const s of r.steps) {
    out(`  ${s.label} - ${s.outcome}${s.detail ? `: ${s.detail}` : ""}`);
  }
  for (const n of r.notes) out(`note: ${n}`);
  if (r.injection) out(r.injection.notice);
}

function testCommand(
  args: string[],
  options: PermissionsCommandOptions,
  io: Required<PermissionsIo>,
): number {
  const [tool, ...rest] = args;
  if (!tool) {
    io.err(
      `Usage: continuous permissions test <tool> <arg...>\nTools: ${TESTABLE_TOOLS.join(", ")}`,
    );
    return 1;
  }
  const parsed = parseLevels(options.level);
  if ("error" in parsed) {
    io.err(parsed.error);
    return 1;
  }
  const text = rest.join(" ");
  const isMcp = tool.startsWith("mcp__");
  if (!text && !isMcp) {
    io.err(`Give the call's argument after the tool: ${tool} <arg...>`);
    return 1;
  }
  const lower = tool.toLowerCase();
  const byKind = /^(runterminalcommand|bash|command|shell)$/.test(lower)
    ? { command: text }
    : /^(fetchurl|fetch)$/.test(lower)
      ? { url: text }
      : /^(grepsearch|search|searchweb)$/.test(lower)
        ? { query: text }
        : { path: text };
  const mode = options.mode as "chat" | "plan" | "agent" | undefined;
  const result = testToolCall({
    tool,
    ...(isMcp ? {} : byKind),
    ...(mode ? { mode } : {}),
    levels: parsed.levels,
    sources: sources(options),
    envNames: readUserEnvNames(),
    cwd: options.cwd ?? process.cwd(),
    ...(options.output ? { outputText: options.output } : {}),
  });
  if (options.json) io.out(JSON.stringify(result, null, 2));
  else printResult(result, io.out);
  return 0;
}

export function permissionsCommand(
  action: string | undefined,
  args: string[] = [],
  options: PermissionsCommandOptions = {},
  io: PermissionsIo = {},
): number {
  const full = { out: io.out ?? defaultOut, err: io.err ?? defaultErr };
  switch (action ?? "list") {
    case "list":
      return listCommand(options, full);
    case "test":
      return testCommand(args, options, full);
    case "add":
      return addCommand(args, options, full);
    case "remove":
      return removeCommand(args, options, full);
    case "adopt":
      return adoptCommand(args, options, full);
    default:
      full.err(
        `Unknown action "${action}". Use: list, test, add, remove, adopt`,
      );
      return 1;
  }
}
