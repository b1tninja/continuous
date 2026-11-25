import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  POLICY_AREA_LABELS,
  POLICY_AREAS,
  policyLevelLabel,
  presetOf,
  POLICY_PRESETS,
  type PolicyLevels,
} from "core/tools/permissions/policy.js";
import type { WebLevel } from "core/tools/permissions/policy.js";
import {
  effectiveWebLevel,
  webHeadlessLine,
} from "core/tools/permissions/webPolicy.js";

/**
 * The headless policy (plans/ROADMAP.md, CO2; plans/decisions-2026-11-15.md,
 * decision 1). A headless run (`cn -p`, `cn serve`) runs at the person's own
 * levels, the ones in their permissions.yaml or the defaults, and the CLI's
 * interactive default lists (Bash and unlisted tools ask). Nobody can be
 * asked, so a call that would ask is refused with a tool result that says how
 * to allow it, and one stderr line per tool says the same to whoever runs
 * the script. `--auto` or `--policy` opts in to more, explicitly.
 *
 * Before 2.18.0 the headless default lists allowed Bash and every unlisted
 * tool (MCP tools included). `CONTINUOUS_HEADLESS_LEGACY_ALLOW=1` brings those
 * lists back for one release; it is removed in the release after.
 */

export const HEADLESS_LEGACY_ENV = "CONTINUOUS_HEADLESS_LEGACY_ALLOW";

/** The escape hatch is on (`1`, `true` or `yes`). */
export function headlessLegacyAllow(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const v = env[HEADLESS_LEGACY_ENV]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** What a script is told to change, in one sentence. */
export const HEADLESS_ALLOW_HINT =
  "To allow it, run with --auto, --policy <preset|area=level|file> (for example --policy handsOff or --policy tools=permissive), or --allow <tool>.";

/**
 * The tool result for a call that would ask in a headless run. `reason` is
 * the rule's or the engine's own reason, when one decided.
 */
export function headlessAskRefusal(toolName: string, reason?: string): string {
  const why = reason?.trim() || `${toolName} needs approval at your levels.`;
  return `${why} Running headless, so it was refused: nobody can be asked in -p or serve. ${HEADLESS_ALLOW_HINT}`;
}

const announcedTools = new Set<string>();

/**
 * One stderr line per tool name per process: the script's operator sees what
 * was refused and how to allow it. stderr, so a JSON run's stdout is unchanged.
 */
export function noteHeadlessRefusal(
  toolName: string,
  write: (line: string) => void = (l) => process.stderr.write(l),
): void {
  if (announcedTools.has(toolName)) return;
  announcedTools.add(toolName);
  write(
    `continuous: refused ${toolName}: it would ask, and a headless run cannot. ${HEADLESS_ALLOW_HINT}\n`,
  );
}

/**
 * WB45, one-release transition. Interactive `cn` already lets the Web level
 * decide a Fetch that only the product's default list allowed. Headless runs
 * keep that default (public hosts run, as before) for this release and say
 * once per run that this changes.
 *
 * As of 2.38 this is true: headless Fetch follows the Web level
 * (Cautious runs only allowed domains). The transition line remains for a
 * caller that passes headlessFollows: false.
 */
export const HEADLESS_FETCH_FOLLOWS_WEB_LEVEL = true;

/** The one stderr line of the transition, given on the run's first such fetch. */
export const HEADLESS_FETCH_TRANSITION_NOTE =
  "Headless fetches follow your Web level from 2.38: keep this with --allow Fetch, --policy web=permissive, or allow the domains in permissions.yaml.";

/** The Web levels at which a default `Fetch: allow` gives way to the Web level. */
const FETCH_FOLLOWS_AT: ReadonlySet<WebLevel> = new Set([
  "off",
  "manual",
  "cautious",
  "listed",
]);

/**
 * What happens to a Fetch that only the product's default list allowed:
 * - "follow": the default is dropped and the Web level decides (it asks at
 *   Cautious for a host nobody allowed, refused when headless);
 * - "transition": headless before 2.38, the default stands and the
 *   transition line is given once;
 * - "keep": the level is looser than Cautious, so the default stands.
 */
export function webFetchDefault(args: {
  level: WebLevel;
  headless: boolean;
  /** HEADLESS_FETCH_FOLLOWS_WEB_LEVEL; a parameter so both settings are tested */
  headlessFollows?: boolean;
}): "follow" | "transition" | "keep" {
  if (!FETCH_FOLLOWS_AT.has(args.level)) return "keep";
  if (!args.headless) return "follow";
  return (args.headlessFollows ?? HEADLESS_FETCH_FOLLOWS_WEB_LEVEL)
    ? "follow"
    : "transition";
}

let fetchTransitionNoted = false;

/** The transition line, once per process, on stderr. */
export function noteHeadlessFetchTransition(
  write: (line: string) => void = (l) => process.stderr.write(l),
): void {
  if (fetchTransitionNoted) return;
  fetchTransitionNoted = true;
  write(`continuous: ${HEADLESS_FETCH_TRANSITION_NOTE}
`);
}

/** For tests: forget which tools were announced. */
export function resetHeadlessRefusalNotes(): void {
  announcedTools.clear();
  fetchTransitionNoted = false;
}

/** "Context Permissive, Tool use Cautious, ...", or the preset's name when the levels are one. */
export function describeLevels(levels: PolicyLevels): string {
  const preset = presetOf(levels);
  const list = POLICY_AREAS.map(
    (a) => `${POLICY_AREA_LABELS[a]} ${policyLevelLabel(a, levels[a])}`,
  ).join(", ");
  return preset ? `${POLICY_PRESETS[preset].label} (${list})` : list;
}

/**
 * The one start-up line of a headless run: the levels, where they came from,
 * and what happens to an ask. `source` is the flag that set them, or
 * undefined for the person's own file and the defaults.
 */
export function headlessPolicyNotice(args: {
  levels: PolicyLevels;
  /** "--auto" or "--policy <spec>" */
  source?: string;
  legacy?: boolean;
  /** `web.enabled` as resolved; false shows Web Off, locked by config.yaml */
  webEnabled?: boolean;
  /**
   * Headless Fetch is still in the transition (HEADLESS_FETCH_FOLLOWS_WEB_LEVEL
   * is false and the default list allows it): public hosts run at Cautious
   */
  fetchTransition?: boolean;
  /** No safety check is on (the IDGAF preset, `--auto`): said, since Permissive alone does not say it */
  noChecks?: boolean;
}): string {
  if (args.legacy) {
    return `continuous: ${HEADLESS_LEGACY_ENV}=1 is set in the environment: Bash and unlisted tools are allowed in every headless run while it is set, not only this one, as before 2.18.0. This switch is removed in the next release; pass --auto or --policy instead.`;
  }
  const where = args.source
    ? `at ${args.source}`
    : "at your levels (permissions.yaml, or the defaults)";
  const tail = args.source
    ? "a call that would still ask is refused."
    : "a call that would ask is refused; --auto or --policy allows more.";
  // WB45: the Web level, and what an ask becomes there (Cautious runs only allowed domains)
  const web = webHeadlessLine(
    effectiveWebLevel(args.levels, { enabled: args.webEnabled }),
    { transition: !!args.fetchTransition },
  );
  const checks = args.noChecks
    ? "; IDGAF: no safety check is on, so rules, protected files and locks stop nothing"
    : "";
  return `continuous: headless run ${where}: ${describeLevels(args.levels)}${checks}; ${web}; ${tail}`;
}

/**
 * A `--policy` value that names a file rather than a preset or levels: it
 * starts with `./`, `../`, `/`, `~` or a drive letter, or ends in `.yaml` or
 * `.yml`.
 */
export function isPolicyFileSpec(spec: string): boolean {
  const s = spec.trim();
  return (
    /^(\.{1,2}[\\/]|[\\/]|~([\\/]|$)|[A-Za-z]:[\\/])/.test(s) ||
    /\.ya?ml$/i.test(s)
  );
}

/** The absolute path of a `--policy` file, `~` expanded. */
export function resolvePolicyFile(spec: string, cwd = process.cwd()): string {
  const s = spec.trim();
  const expanded =
    s === "~" || s.startsWith("~/") || s.startsWith("~\\")
      ? path.join(os.homedir(), s.slice(1))
      : s;
  return path.resolve(cwd, expanded);
}

/** The file exists; otherwise the error `--policy` reports. */
export function checkPolicyFile(file: string): string | undefined {
  return existsSync(file) ? undefined : `no policy file at ${file}`;
}
