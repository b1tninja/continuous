import fs from "node:fs";
import path from "node:path";
import type {
  SettingChangeKind,
  SettingChangeSource,
  SettingInput,
} from "./audit/record";
import type { AuditTrail } from "./audit/trail";
import {
  POLICY_AREAS,
  POLICY_LEVELS,
  presetOf,
  type PolicyLevel,
  type PolicyLevels,
} from "./policy";
import type { PolicyFileSettings } from "./settingsFile";

/**
 * Changes to the permission settings that are not rules (plans/research/
 * product-review-controls-and-roadmap.md, CO6): the levels, the preset they
 * add up to, floor rules, built-in rules switched off, trusted MCP servers.
 * `diffPolicySettings` is pure; `recordSettingChanges` writes what it found to
 * the audit trail. Nothing here reads or stores file contents: a change names
 * the setting and its old and new value.
 */
export interface SettingChange {
  kind: SettingChangeKind;
  op: SettingInput["op"];
  name: string;
  from?: string;
  to?: string;
  loosens: boolean;
}

const RANK = new Map<string, number>(POLICY_LEVELS.map((l, i) => [l, i]));

/** The levels from which a raise asks for confirmation: Automatic and above. */
const CONFIRM_FROM_RANK = RANK.get("automatic") ?? 2;

const rank = (level: string | undefined): number =>
  (level === undefined ? undefined : RANK.get(level)) ?? -1;

export interface RaisedLevel {
  area: string;
  from: PolicyLevel;
  to: PolicyLevel;
}

/**
 * The areas a change moves to Automatic, Permissive or IDGAF from a lower
 * level. Lowering, and moving between Manual and Cautious, is not listed.
 */
export function raisedLevels(
  before: PolicyLevels,
  after: PolicyLevels,
): RaisedLevel[] {
  const out: RaisedLevel[] = [];
  for (const area of POLICY_AREAS) {
    const b = before[area];
    const a = after[area];
    if (rank(a) > rank(b) && rank(a) >= CONFIRM_FROM_RANK) {
      out.push({ area, from: b, to: a });
    }
  }
  return out;
}

/**
 * The one-line question asked before a raise takes effect, or undefined when
 * nothing needs asking. It names every area and both levels.
 */
export function raiseConfirmation(
  before: PolicyLevels,
  after: PolicyLevels,
): string | undefined {
  const raised = raisedLevels(before, after);
  if (raised.length === 0) return undefined;
  const parts = raised.map((r) => `${r.area} ${r.from} to ${r.to}`);
  const idgaf = raised.some((r) => r.to === "idgaf");
  return `Permission levels: ${parts.join(", ")}. Fewer calls will ask first${
    idgaf ? " (idgaf lasts this session only)" : ""
  }.`;
}

function presetName(levels: PolicyLevels): string {
  return presetOf(levels) ?? "custom";
}

/**
 * What changed between two settings. Levels come with the preset they add up
 * to (when it differs), built-in rules as on or off, floor rules as added or
 * removed text, MCP servers as trusted or not.
 */
export function diffPolicySettings(
  before: PolicyFileSettings,
  after: PolicyFileSettings,
): SettingChange[] {
  const out: SettingChange[] = [];
  let levelChanged = false;
  for (const area of POLICY_AREAS) {
    const b = before.levels[area];
    const a = after.levels[area];
    if (a === b) continue;
    levelChanged = true;
    out.push({
      kind: "level",
      op: "set",
      name: area,
      from: b,
      to: a,
      loosens: rank(a) > rank(b),
    });
  }
  if (levelChanged) {
    const b = presetName(before.levels);
    const a = presetName(after.levels);
    if (a !== b) {
      out.push({
        kind: "preset",
        op: "set",
        name: "preset",
        from: b,
        to: a,
        loosens: POLICY_AREAS.some(
          (area) => rank(after.levels[area]) > rank(before.levels[area]),
        ),
      });
    }
  }

  const builtinOf = (s: PolicyFileSettings) =>
    (s.builtin ?? {}) as Record<string, boolean>;
  const ids = new Set([
    ...Object.keys(builtinOf(before)),
    ...Object.keys(builtinOf(after)),
  ]);
  for (const id of [...ids].sort()) {
    const was = builtinOf(before)[id] !== false;
    const now = builtinOf(after)[id] !== false;
    if (was === now) continue;
    out.push({
      kind: "builtin",
      op: "set",
      name: id,
      from: was ? "on" : "off",
      to: now ? "on" : "off",
      loosens: !now,
    });
  }

  const floorBefore = new Set(before.floor ?? []);
  const floorAfter = new Set(after.floor ?? []);
  for (const rule of floorAfter) {
    if (!floorBefore.has(rule)) {
      out.push({
        kind: "floor",
        op: "add",
        name: rule,
        to: "denied",
        loosens: false,
      });
    }
  }
  for (const rule of floorBefore) {
    if (!floorAfter.has(rule)) {
      out.push({
        kind: "floor",
        op: "remove",
        name: rule,
        from: "denied",
        loosens: true,
      });
    }
  }

  const trustBefore = new Set(Object.keys(before.mcpServers ?? {}));
  const trustAfter = new Set(Object.keys(after.mcpServers ?? {}));
  for (const name of trustAfter) {
    if (!trustBefore.has(name)) {
      out.push({
        kind: "mcp-trust",
        op: "grant",
        name,
        to: "trusted",
        loosens: true,
      });
    }
  }
  for (const name of trustBefore) {
    if (!trustAfter.has(name)) {
      out.push({
        kind: "mcp-trust",
        op: "revoke",
        name,
        from: "trusted",
        loosens: false,
      });
    }
  }

  const tb = before.planAllowTerminal === true;
  const ta = after.planAllowTerminal === true;
  if (tb !== ta) {
    out.push({
      kind: "plan-terminal",
      op: "set",
      name: "plan.allowTerminal",
      from: tb ? "on" : "off",
      to: ta ? "on" : "off",
      loosens: ta,
    });
  }
  return out;
}

export interface RecordContext {
  source: SettingChangeSource;
  confirmed?: SettingInput["confirmed"];
  /** The session the change was made in */
  session?: string;
}

/** Write each change to the trail. Returns false if any write failed. Never throws. */
export function recordSettingChanges(
  trail: AuditTrail,
  changes: readonly SettingChange[],
  ctx: RecordContext,
): boolean {
  let ok = true;
  for (const c of changes) {
    try {
      const written = trail.setting({
        ...c,
        source: ctx.source,
        ...(ctx.confirmed ? { confirmed: ctx.confirmed } : {}),
        ...(ctx.session ? { viaSession: ctx.session } : {}),
      });
      ok &&= written;
    } catch {
      ok = false;
    }
  }
  return ok;
}

/** A grant or withdrawal of trust for a project's configuration or hooks. */
export function trustChange(
  kind: "project-trust" | "hook-trust",
  op: "grant" | "revoke",
  scope: string,
): SettingChange {
  return {
    kind,
    op,
    name: scope,
    ...(op === "grant" ? { to: "trusted" } : { from: "trusted" }),
    loosens: op === "grant",
  };
}

/** What the snapshot keeps: only what `diffPolicySettings` reads. */
interface Snapshot {
  levels: PolicyLevels;
  builtin?: Record<string, boolean>;
  floor?: string[];
  mcpServers?: Record<string, "trusted">;
  planAllowTerminal?: boolean;
}

const SNAPSHOT_FILE = "settings-seen.json";

function snapshotOf(s: PolicyFileSettings): Snapshot {
  return {
    levels: { ...s.levels },
    ...(s.builtin
      ? { builtin: { ...(s.builtin as Record<string, boolean>) } }
      : {}),
    ...(s.floor ? { floor: [...s.floor] } : {}),
    ...(s.mcpServers ? { mcpServers: { ...s.mcpServers } } : {}),
    ...(s.planAllowTerminal === undefined
      ? {}
      : { planAllowTerminal: s.planAllowTerminal }),
  };
}

function readSnapshot(file: string): Snapshot | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw && typeof raw === "object" && raw.levels) return raw as Snapshot;
  } catch {
    // no snapshot, or one that cannot be read: treated as the first run
  }
  return undefined;
}

function writeSnapshot(trail: AuditTrail, current: PolicyFileSettings): void {
  fs.mkdirSync(trail.dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(trail.dir, SNAPSHOT_FILE),
    JSON.stringify(snapshotOf(current)),
    { encoding: "utf8", mode: 0o600 },
  );
}

/**
 * Settings edited in the file since this process last looked. The audit
 * directory keeps the last settings it saw (`settings-seen.json`); at load the
 * file is compared with it and each difference is recorded with source
 * "file". The first run only records the baseline, because nothing is known
 * to have changed. A change this process wrote itself is kept in step by
 * `rememberSettings`, so it is not reported twice. Never throws.
 */
export function recordFileEdits(
  trail: AuditTrail,
  current: PolicyFileSettings,
): SettingChange[] {
  try {
    if (!trail.enabled || !trail.dir) return [];
    const seen = readSnapshot(path.join(trail.dir, SNAPSHOT_FILE));
    const changes = seen
      ? diffPolicySettings(seen as PolicyFileSettings, current)
      : [];
    if (changes.length > 0) {
      recordSettingChanges(trail, changes, { source: "file" });
    }
    writeSnapshot(trail, current);
    return changes;
  } catch {
    return [];
  }
}

/** Keep the snapshot in step after this process wrote the file itself. */
export function rememberSettings(
  trail: AuditTrail,
  current: PolicyFileSettings,
): void {
  try {
    if (!trail.enabled || !trail.dir) return;
    writeSnapshot(trail, current);
  } catch {
    // the snapshot is a nicety
  }
}
