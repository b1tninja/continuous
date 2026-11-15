import * as fs from "node:fs";
import { diffLines } from "diff";
import { convertMyersChangeToDiffLines } from "../../diff/myers.js";
import {
  BUILTIN_RULES,
  POLICY_AREA_LABELS,
  POLICY_AREAS,
  POLICY_LEVELS,
  parsePolicyLevel,
  policyLevelLabel,
} from "./policy.js";
import {
  applyPolicyUpdate,
  parsePolicyFile,
  policyUpdateProblem,
  writePolicyFile,
  type PolicyFileSettings,
  type PolicyFileUpdate,
} from "./settingsFile.js";

/**
 * A `policy/save` that loosens waits for the IDE's own dialog, which the page
 * cannot click (plans/research/custom-policy.md, F10). The same rule as the
 * rule editor's: a change in the page is a request; the confirmation is the
 * host's.
 */

/** One thing a save lets through that was stopped before. */
export interface PolicyLoosening {
  /** The permissions.yaml key */
  key: string;
  /** In words, for the dialog and the review step */
  text: string;
}

const rank = (level: unknown): number => {
  const parsed = parsePolicyLevel(level);
  return parsed ? POLICY_LEVELS.indexOf(parsed) : -1;
};

/**
 * What the update loosens against the file as it is: an area's level raised
 * (IDGAF counts, though it is never written: it is the session's), a built-in
 * rule switched off, a `floor:` rule removed, an MCP server trusted, an entry
 * added to `plan.mcpTools`, the terminal offered in Plan mode. A tightening,
 * a key the update leaves out, and `levels.custom` (provenance only) are not.
 */
export function policySaveLoosenings(
  before: PolicyFileSettings,
  update: PolicyFileUpdate,
): PolicyLoosening[] {
  const out: PolicyLoosening[] = [];
  for (const area of POLICY_AREAS) {
    const after = update.levels?.[area];
    if (after === undefined) continue;
    const was = before.levels[area];
    if (rank(after) > rank(was)) {
      const level = parsePolicyLevel(after)!;
      out.push({
        key: `levels.${area}`,
        text: `${POLICY_AREA_LABELS[area]}: ${policyLevelLabel(area, was)} → ${policyLevelLabel(area, level)}${level === "idgaf" ? " (this session only; nothing is refused or asked, the Always-on Never list included)" : ""}`,
      });
    }
  }
  for (const rule of BUILTIN_RULES) {
    const after = update.builtin?.[rule.id];
    if (after !== false) continue;
    if (before.builtin?.[rule.id] === false) continue;
    out.push({
      key: `builtin.${rule.id}`,
      text: `Switch off the built-in rule "${rule.label}"`,
    });
  }
  if (update.floor) {
    const kept = new Set(update.floor.map((r) => r.trim()));
    for (const rule of before.floor ?? []) {
      if (!kept.has(rule.trim())) {
        out.push({
          key: "floor",
          text: `Remove the Always-on Never rule ${rule}`,
        });
      }
    }
  }
  if (update.trustedMcpServers) {
    const was = new Set(Object.keys(before.mcpServers ?? {}));
    for (const name of update.trustedMcpServers) {
      if (!was.has(name.trim())) {
        out.push({
          key: "mcpServers",
          text: `Trust the read-only hints of the MCP server ${name.trim()}`,
        });
      }
    }
  }
  if (update.planMcpTools) {
    const was = new Set(before.planMcpTools ?? []);
    for (const entry of update.planMcpTools) {
      if (!was.has(entry.trim())) {
        out.push({
          key: "plan.mcpTools",
          text: `Let Plan mode use the MCP tool ${entry.trim()}`,
        });
      }
    }
  }
  if (update.planAllowTerminal === true && before.planAllowTerminal !== true) {
    out.push({
      key: "plan.allowTerminal",
      text: "Offer the terminal in Plan mode (it still asks)",
    });
  }
  return out;
}

/** The native dialog's text. */
export function policySaveConfirmText(loosens: PolicyLoosening[]): string {
  return [
    "Save these permission changes?",
    "",
    ...loosens.map((l) => `• ${l.text}`),
    "",
    "This lets something run without asking that did not before. Settings are saved to permissions.yaml, which the CLI reads too.",
  ].join("\n");
}

export const POLICY_SAVE_NOT_CONFIRMED =
  "Not confirmed in the editor's own dialog, so nothing was saved.";

export interface PolicySaveHost {
  /**
   * Ask in the IDE's own dialog. Resolves true only on an explicit yes; a
   * throw, a close or an IDE that cannot ask is a no.
   */
  confirm: (text: string) => Promise<boolean>;
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return undefined;
    throw e;
  }
}

/**
 * Write the update, after the IDE's own confirmation when it loosens. An
 * update the writer would refuse is refused before anything is asked; a "no"
 * writes nothing. Returns what was loosened (and confirmed).
 */
export async function savePolicyWithConfirmation(
  file: string,
  update: PolicyFileUpdate,
  host: PolicySaveHost,
): Promise<PolicyLoosening[]> {
  const problem = policyUpdateProblem(update);
  if (problem) throw new Error(`Not saved: ${problem}`);
  const before = parsePolicyFile(readText(file)).settings;
  const loosens = policySaveLoosenings(before, update);
  if (loosens.length > 0) {
    const yes = await host
      .confirm(policySaveConfirmText(loosens))
      .catch(() => false);
    if (!yes) throw new Error(POLICY_SAVE_NOT_CONFIRMED);
  }
  writePolicyFile(file, update);
  return loosens;
}

/** One line of the preview: kept, removed or added. */
export interface PolicyDiffLine {
  type: "same" | "old" | "new";
  line: string;
}

/** What `policy/preview` answers: the file before and after, and what the save would ask about. */
export interface PolicySavePreview {
  /** The text the save would write; equal to `before` when nothing changes */
  before: string;
  after: string;
  changed: boolean;
  diff: PolicyDiffLine[];
  /** What the native dialog would ask about */
  loosens: PolicyLoosening[];
  /** Why the writer would refuse the update; nothing would be written */
  problem?: string;
}

/**
 * The save, dry-run: the exact text core's writer would produce from the file
 * as it is now, line by line. Nothing is written and nothing is asked.
 */
export function previewPolicySave(
  file: string,
  update: PolicyFileUpdate,
): PolicySavePreview {
  return previewPolicyText(readText(file) ?? "", update);
}

/** previewPolicySave on the file's text: a missing file is "". */
export function previewPolicyText(
  text: string,
  update: PolicyFileUpdate,
): PolicySavePreview {
  const problem = policyUpdateProblem(update);
  const loosens = policySaveLoosenings(parsePolicyFile(text).settings, update);
  if (problem) {
    return {
      before: text,
      after: text,
      changed: false,
      diff: [],
      loosens,
      problem,
    };
  }
  const after = applyPolicyUpdate(text, update);
  const changed = after !== text;
  return {
    before: text,
    after,
    changed,
    // jsdiff's lines as they are: no merging of lines equal after trimming,
    // so an indentation change shows
    diff: changed
      ? diffLines(text, after)
          .flatMap(convertMyersChangeToDiffLines)
          .map((d) => ({ type: d.type, line: d.line }))
      : [],
    loosens,
  };
}
