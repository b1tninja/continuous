import * as fs from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";
import { writeFileAtomicSync } from "../../util/atomicWrite.js";
import {
  BUILTIN_RULES,
  DEFAULT_POLICY_LEVELS,
  normalizePolicy,
  parsePolicyLevel,
  POLICY_AREAS,
  POLICY_PRESETS,
  type BuiltinRuleId,
  type PolicyArea,
  type PolicyLevels,
  type PolicyPresetName,
  type PolicySettings,
  type QuestionDelivery,
} from "./policy.js";
import { validateRuleText } from "./ruleAnalysis.js";

/**
 * The one settings file the IDE and the CLI both read: permissions.yaml in the
 * global directory (plans/policy-areas.md, "Settings"). It shares the file
 * with the CLI's own `allow`, `ask` and `exclude` lists, which this module
 * never touches.
 *
 * IDGAF is session-only: a saved `idgaf` (or `yolo`, which 2.14.x wrote for
 * it) is read as that area's default with a notice, and is never written.
 */
export interface PolicyFileSettings extends PolicySettings {
  /** Deny rules that bind at every level below IDGAF (recorded at IDGAF). */
  floor?: string[];
  /** MCP servers whose read-only hints the person trusts, by display name. */
  mcpServers?: Record<string, "trusted">;
  /**
   * MCP tools the person lets Plan mode use, whatever the server claims:
   * "server/tool", "server/*" or "server" (plans/research/tr-owner-decisions.md, 1).
   */
  planMcpTools?: string[];
  /** Offer the terminal in Plan mode (the CLI; it still asks). Default false. */
  planAllowTerminal?: boolean;
  /** The person's custom set of levels and the preset it started from (`levels.custom`). */
  custom?: StoredCustomSet;
}

/**
 * A custom set of the five levels, kept so it can be recalled after a preset
 * is chosen, and the preset it was made from, so the chip can say "Custom
 * (from Careful)". Provenance only: nothing reads it to decide a call.
 *
 * Stored at `levels.custom`, not at a new top-level key: every CLI and IDE
 * that reads permissions.yaml accepts `levels` and reads only the five area
 * names inside it, so an older build ignores this entry instead of treating
 * the whole file as broken (an unknown top-level key does that; see the CLI's
 * permissionsYamlProblem). Never holds IDGAF, which is for one session only.
 */
export interface StoredCustomSet {
  /** The preset the set was made from; absent when it was made from another custom set */
  from?: Exclude<PolicyPresetName, "idgaf">;
  levels: PolicyLevels;
}

/** Where the custom set lives in the file. */
export const CUSTOM_SET_PATH = ["levels", "custom"] as const;

export interface PolicyFileRead {
  settings: PolicyFileSettings;
  /** One line per value that could not be used or was changed on read. */
  notices: string[];
}

/** The keys of the file this module owns. The rest belongs to the CLI. */
export const POLICY_FILE_KEYS = [
  "levels",
  "plan",
  "questions",
  "builtin",
  "floor",
  "mcpServers",
  "sandbox",
] as const;

const BUILTIN_IDS = new Set<string>(BUILTIN_RULES.map((r) => r.id));

function asBool(value: unknown): boolean | undefined {
  if (value === true || value === "on") return true;
  if (value === false || value === "off") return false;
  return undefined;
}

/** Settings from the file's text. A missing or unreadable file is the defaults. */
export function parsePolicyFile(text: string | undefined): PolicyFileRead {
  const notices: string[] = [];
  let raw: Record<string, any> = {};
  if (text?.trim()) {
    try {
      const parsed = YAML.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        raw = parsed;
      } else {
        notices.push("permissions.yaml is not a mapping, so it was ignored.");
      }
    } catch (e) {
      notices.push(
        `permissions.yaml could not be read (${e instanceof Error ? e.message : String(e)}), so the defaults apply.`,
      );
    }
  }

  // IDGAF is never read from disk; `yolo` is its old spelling
  const levelsIn: Record<string, unknown> = { ...(raw.levels ?? {}) };
  for (const area of POLICY_AREAS) {
    if (parsePolicyLevel(levelsIn[area]) === "idgaf") {
      delete levelsIn[area];
      notices.push(
        `levels.${area}: idgaf is for one session only, so ${DEFAULT_POLICY_LEVELS[area]} applies.`,
      );
    }
  }

  const { policy, problems } = normalizePolicy({
    levels: levelsIn,
    maxNewPlanItems: raw.plan?.maxNewItems,
    questions: {
      delivery: raw.questions?.delivery,
      youDecide: raw.questions?.youDecide,
      agentDecides: raw.questions?.agentDecides,
    },
  });
  notices.push(...problems.map((p) => `permissions.yaml: ${p}`));

  const settings: PolicyFileSettings = { ...policy };
  if (raw.builtin && typeof raw.builtin === "object") {
    const builtin: Partial<Record<BuiltinRuleId, boolean>> = {};
    for (const [id, value] of Object.entries(raw.builtin)) {
      const on = asBool(value);
      if (!BUILTIN_IDS.has(id)) {
        notices.push(`builtin.${id}: there is no built-in rule with that id.`);
      } else if (on === undefined) {
        notices.push(`builtin.${id}: use on or off.`);
      } else {
        builtin[id as BuiltinRuleId] = on;
      }
    }
    settings.builtin = builtin;
  }
  if (Array.isArray(raw.floor)) {
    settings.floor = raw.floor.filter((r: unknown) => typeof r === "string");
  }
  if (raw.mcpServers && typeof raw.mcpServers === "object") {
    const servers: Record<string, "trusted"> = {};
    for (const [name, value] of Object.entries(raw.mcpServers)) {
      if (value === "trusted") servers[name] = "trusted";
    }
    settings.mcpServers = servers;
  }
  if (Array.isArray(raw.plan?.mcpTools)) {
    settings.planMcpTools = raw.plan.mcpTools.filter(
      (t: unknown): t is string => typeof t === "string" && t.length > 0,
    );
  }
  const allowTerminal = asBool(raw.plan?.allowTerminal);
  if (allowTerminal !== undefined) settings.planAllowTerminal = allowTerminal;
  const rawCustom = raw.levels?.custom;
  if (rawCustom !== undefined) {
    const custom = readCustomSet(rawCustom);
    if (custom) settings.custom = custom;
    else {
      notices.push(
        "levels.custom: not a complete set of five levels, so it is not offered.",
      );
    }
  }
  return { settings, notices };
}

/** A stored custom set, or undefined when it is not one (missing area, IDGAF, unknown preset). */
export function readCustomSet(value: unknown): StoredCustomSet | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const { from, levels } = value as { from?: unknown; levels?: unknown };
  if (!levels || typeof levels !== "object" || Array.isArray(levels)) {
    return undefined;
  }
  const out: Partial<PolicyLevels> = {};
  for (const area of POLICY_AREAS) {
    const level = parsePolicyLevel((levels as Record<string, unknown>)[area]);
    if (!level || level === "idgaf") return undefined;
    out[area] = level;
  }
  if (from !== undefined && !isStorablePreset(from)) return undefined;
  return {
    ...(from === undefined ? {} : { from }),
    levels: out as PolicyLevels,
  };
}

function isStorablePreset(
  value: unknown,
): value is Exclude<PolicyPresetName, "idgaf"> {
  return (
    typeof value === "string" &&
    value !== "idgaf" &&
    Object.prototype.hasOwnProperty.call(POLICY_PRESETS, value)
  );
}

/** What `save` is given: the parts of the settings a person can change. */
export interface PolicyFileUpdate {
  levels?: PolicyLevels;
  maxNewPlanItems?: number;
  questions?: {
    delivery?: QuestionDelivery;
    youDecide?: string[];
    agentDecides?: string[];
  };
  builtin?: Partial<Record<BuiltinRuleId, boolean>>;
  /** The whole `floor:` list as it should be; each entry a valid rule */
  floor?: string[];
  /** The servers whose read-only hints are trusted; every other entry is removed */
  trustedMcpServers?: string[];
  /** The whole `plan.mcpTools` list: "server/tool", "server/*" or "server" */
  planMcpTools?: string[];
  /** `plan.allowTerminal` */
  planAllowTerminal?: boolean;
  /** `levels.custom`: the set to keep for recall; null removes it, absent keeps what the file has */
  custom?: StoredCustomSet | null;
}

/** Why an update cannot be written, or undefined. Nothing is written when it cannot. */
export function policyUpdateProblem(
  update: PolicyFileUpdate,
): string | undefined {
  for (const rule of update.floor ?? []) {
    const why = validateRuleText(rule, "deny");
    if (why) return `floor: ${JSON.stringify(rule)}: ${why}`;
  }
  for (const name of update.trustedMcpServers ?? []) {
    if (typeof name !== "string" || !name.trim() || hasControl(name)) {
      return `mcpServers: ${JSON.stringify(name)} is not a server name.`;
    }
  }
  for (const entry of update.planMcpTools ?? []) {
    if (!isPlanMcpTool(entry)) {
      return `plan.mcpTools: ${JSON.stringify(entry)}: write server/tool, server/* or server.`;
    }
  }
  if (update.custom && !readCustomSet(update.custom)) {
    return "levels.custom: a custom set needs all five levels, none of them IDGAF, and a preset name in from.";
  }
  return undefined;
}

const hasControl = (text: string) =>
  [...text].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

/** "server", "server/*" or "server/tool": one slash at most, no empty part, no control characters. */
function isPlanMcpTool(entry: unknown): boolean {
  if (typeof entry !== "string" || entry !== entry.trim() || !entry) {
    return false;
  }
  if (hasControl(entry)) return false;
  const parts = entry.split("/");
  return parts.length <= 2 && parts.every((p) => p.length > 0);
}

/**
 * Make the list at `at` hold exactly `list`, editing the existing sequence in
 * place: kept entries keep their comments and place, removed ones go, new
 * ones are added at the end. An empty list removes the key.
 */
function setStringList(
  doc: YAML.Document,
  at: (string | number)[],
  list: readonly string[],
): void {
  const wanted = list.map((v) => v.trim()).filter(Boolean);
  if (wanted.length === 0) {
    if (doc.hasIn(at)) doc.deleteIn(at);
    return;
  }
  const node = doc.getIn(at, true);
  if (!YAML.isSeq(node)) {
    doc.setIn(at, wanted);
    return;
  }
  const valueOf = (item: unknown) =>
    String(YAML.isScalar(item) ? item.value : item).trim();
  const kept = node.items.filter((item) => wanted.includes(valueOf(item)));
  // An empty `[]` written in flow style reads better one entry per line
  if (kept.length === 0) node.flow = false;
  node.items = kept;
  const present = new Set(node.items.map(valueOf));
  for (const value of wanted) {
    if (!present.has(value)) {
      node.items.push(doc.createNode(value));
      present.add(value);
    }
  }
}

/** Remove an empty mapping left behind at `key`. */
function dropEmptyMap(doc: YAML.Document, key: string): void {
  const node = doc.get(key, true);
  if (YAML.isMap(node) && node.items.length === 0) doc.delete(key);
}

/**
 * The file's text with the update applied, keeping every other key and
 * comment. Levels at IDGAF are not written: the area keeps what the file had.
 */
export function applyPolicyUpdate(
  text: string | undefined,
  update: PolicyFileUpdate,
): string {
  const doc = YAML.parseDocument(text?.trim() ? text : "{}");
  if (!YAML.isMap(doc.contents)) doc.contents = doc.createNode({}) as any;

  if (update.levels) {
    for (const area of POLICY_AREAS as readonly PolicyArea[]) {
      const level = update.levels[area];
      if (parsePolicyLevel(level) === "idgaf") continue;
      doc.setIn(["levels", area], level);
    }
  }
  if (update.maxNewPlanItems !== undefined) {
    doc.setIn(["plan", "maxNewItems"], update.maxNewPlanItems);
  }
  if (update.questions?.delivery) {
    doc.setIn(["questions", "delivery"], update.questions.delivery);
  }
  if (update.questions?.youDecide) {
    doc.setIn(["questions", "youDecide"], update.questions.youDecide);
  }
  if (update.questions?.agentDecides) {
    doc.setIn(["questions", "agentDecides"], update.questions.agentDecides);
  }
  if (update.builtin) {
    for (const [id, on] of Object.entries(update.builtin)) {
      if (!BUILTIN_IDS.has(id)) continue;
      // Stored as a switch by id, and only when off: absent means on
      if (on === false) doc.setIn(["builtin", id], "off");
      else doc.deleteIn(["builtin", id]);
    }
    const builtin = doc.get("builtin") as YAML.YAMLMap | undefined;
    if (builtin && builtin.items.length === 0) doc.delete("builtin");
  }
  if (update.floor) setStringList(doc, ["floor"], update.floor);
  if (update.planMcpTools) {
    setStringList(doc, ["plan", "mcpTools"], update.planMcpTools);
    dropEmptyMap(doc, "plan");
  }
  if (update.planAllowTerminal !== undefined) {
    if (update.planAllowTerminal) doc.setIn(["plan", "allowTerminal"], true);
    else if (doc.hasIn(["plan", "allowTerminal"])) {
      doc.deleteIn(["plan", "allowTerminal"]);
      dropEmptyMap(doc, "plan");
    }
  }
  if (update.custom === null) {
    if (doc.hasIn([...CUSTOM_SET_PATH])) doc.deleteIn([...CUSTOM_SET_PATH]);
    dropEmptyMap(doc, "levels");
  } else if (update.custom) {
    const custom = readCustomSet(update.custom);
    if (custom) {
      doc.setIn(
        [...CUSTOM_SET_PATH],
        doc.createNode({
          ...(custom.from ? { from: custom.from } : {}),
          levels: { ...custom.levels },
        }),
      );
    }
  }
  if (update.trustedMcpServers) {
    const wanted = new Set(update.trustedMcpServers.map((n) => n.trim()));
    const servers = doc.get("mcpServers", true);
    if (YAML.isMap(servers)) {
      servers.items = servers.items.filter((pair) => {
        const name = String(
          YAML.isScalar(pair.key) ? pair.key.value : pair.key,
        );
        const value = YAML.isScalar(pair.value) ? pair.value.value : pair.value;
        return value !== "trusted" || wanted.has(name);
      });
    }
    for (const name of wanted) {
      if (doc.getIn(["mcpServers", name]) !== "trusted") {
        doc.setIn(["mcpServers", name], "trusted");
      }
    }
    dropEmptyMap(doc, "mcpServers");
  }
  return String(doc);
}

export function readPolicyFile(file: string): PolicyFileRead {
  try {
    return parsePolicyFile(fs.readFileSync(file, "utf-8"));
  } catch (e: any) {
    if (e?.code === "ENOENT") return parsePolicyFile(undefined);
    return {
      settings: parsePolicyFile(undefined).settings,
      notices: [`permissions.yaml could not be read: ${e?.message ?? e}`],
    };
  }
}

export function writePolicyFile(file: string, update: PolicyFileUpdate): void {
  const problem = policyUpdateProblem(update);
  if (problem) throw new Error(`Not saved: ${problem}`);
  let existing: string | undefined;
  try {
    existing = fs.readFileSync(file, "utf-8");
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Temp file and rename: a kill during the write cannot leave half a
  // permissions.yaml, which would read as "no rules".
  writeFileAtomicSync(file, applyPolicyUpdate(existing, update));
}
