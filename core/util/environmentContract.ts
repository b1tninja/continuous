/**
 * The environment data contract as data: one row per fact about this machine
 * or workspace that could be shown to a model, saying where it may appear,
 * how it is masked and capped, and at which detail level it is on
 * (plans/research/env-disclosure-master-plan.md, section 3.5, row ENV3).
 *
 * The renderer in ./environmentPrompt asks this registry before it writes any
 * value, so a fact that has no row, a fact marked `never`, or a fact headed
 * for a region its row does not list cannot be rendered: the call throws.
 * `checkPlacement` is the same rule over the whole table, for the test that
 * fails when a per-session or repository-controlled field is given a place
 * in the cached tools or system regions.
 *
 * Pure data and pure functions. Nothing here is wired into a prompt.
 */

export type Detail = "minimal" | "standard" | "full";

export type Surface =
  | "cli"
  | "headless"
  | "serve"
  | "acp"
  | "ide-chat"
  | "ide-agent"
  | "ide-plan"
  | "subagent"
  | "loop-worker";

/** The two shapes of text: an editor window with workspace folders, or a process with a working folder. */
export type SurfaceFamily = "cli" | "ide";

export function surfaceFamilyOf(surface: Surface): SurfaceFamily {
  return surface === "ide-chat" ||
    surface === "ide-agent" ||
    surface === "ide-plan"
    ? "ide"
    : "cli";
}

/**
 * How long a value stays true. S0: this install. S1: until a setting changes
 * (or, for the folder, for the whole session). S2: a snapshot taken at the
 * start of the session. S3: changes during a session, so only ever appended.
 * S4: read on demand, never pushed.
 */
export type Stability = "S0" | "S1" | "S2" | "S3" | "S4";

/** The part of a request a value may sit in. */
export type Region = "system" | "tools" | "firstUser" | "update" | "onDemand";

export type Mask =
  | "home"
  | "user"
  | "invisible"
  | "escape"
  | "secrets"
  | "urlCredentials"
  | "imageTail";

/** `masked`: sent with the home folder as `~` and the account name as `<user>` (or, for an image, its last segment only). */
export type FieldSetting = "on" | "masked" | "off";

export type EnvFieldId =
  | "platform"
  | "arch"
  | "osRelease"
  | "remoteKind"
  | "hostWsl"
  | "executionShell"
  | "container"
  | "wsl"
  | "userland"
  | "containerHint"
  | "roots"
  | "isGitRepo"
  | "date"
  | "timeZone"
  | "locale"
  | "gitBranch"
  | "gitStatus"
  | "gitRemote"
  | "dateUpdate"
  | "editorDelta"
  | "toolVersions"
  | "directoryListings"
  | "envVarNames"
  | "permissionLevel"
  | "userName"
  | "hostName"
  | "gitIdentity"
  | "networkAddresses"
  | "envVarValues";

export interface EnvFieldSpec {
  id: EnvFieldId;
  /** The name a person reads in the field report. */
  label: string;
  /** Where the value comes from. */
  source: string;
  /** True when a repository or a folder name decides the text. */
  attackerControlled: boolean;
  mask: readonly Mask[];
  /** Most characters of one value. */
  capChars: number;
  capLines?: number;
  /** Most values listed (workspace roots). */
  capItems?: number;
  /** Absent for a fact that is never sent. */
  stability?: Stability;
  /** Every region the value may appear in; empty for a fact that is never sent. */
  placement: readonly Region[];
  defaultAt: Record<Detail, FieldSetting>;
  /** The setting in an editor window when it differs from the CLI's. */
  ideDefaultAt?: Record<Detail, FieldSetting>;
  /** No setting sends it. */
  never?: true;
  /** A note for the field report when the row needs one. */
  note?: string;
}

const ON = { minimal: "on", standard: "on", full: "on" } as const;
const OFF = { minimal: "off", standard: "off", full: "off" } as const;
const FROM_STANDARD = { minimal: "off", standard: "on", full: "on" } as const;
const FULL_ONLY = { minimal: "off", standard: "off", full: "on" } as const;

function never(
  id: EnvFieldId,
  label: string,
  note = "no setting sends it",
): EnvFieldSpec {
  return {
    id,
    label,
    source: "-",
    attackerControlled: false,
    mask: [],
    capChars: 0,
    placement: [],
    defaultAt: OFF,
    never: true,
    note,
  };
}

/** Section 3.5 of the master plan, row for row. */
export const ENV_FIELDS: readonly EnvFieldSpec[] = [
  {
    id: "platform",
    label: "platform",
    source: "the OS family of process.platform",
    attackerControlled: false,
    mask: [],
    capChars: 40,
    stability: "S0",
    placement: ["system"],
    defaultAt: ON,
  },
  {
    id: "arch",
    label: "arch",
    source: "os.arch()",
    attackerControlled: false,
    mask: [],
    capChars: 16,
    stability: "S0",
    placement: ["system"],
    defaultAt: FROM_STANDARD,
  },
  {
    id: "osRelease",
    label: "OS release",
    source: "os.release(), major version only",
    attackerControlled: false,
    mask: [],
    capChars: 40,
    stability: "S0",
    placement: ["system"],
    defaultAt: FULL_ONLY,
  },
  {
    id: "remoteKind",
    label: "remote window kind",
    source: "the editor's remote name, kind only",
    attackerControlled: false,
    mask: [],
    capChars: 24,
    stability: "S1",
    placement: ["system", "tools"],
    defaultAt: ON,
  },
  {
    id: "hostWsl",
    label: "running inside WSL",
    source: "WSL_DISTRO_NAME or /proc/version",
    attackerControlled: false,
    mask: [],
    capChars: 40,
    stability: "S0",
    placement: ["system", "tools"],
    defaultAt: ON,
  },
  {
    id: "executionShell",
    label: "terminal shell",
    source: "the shell the terminal tool starts",
    attackerControlled: false,
    mask: ["home", "user"],
    capChars: 900,
    stability: "S1",
    placement: ["tools"],
    defaultAt: ON,
  },
  {
    id: "container",
    label: "container executor",
    source: "the container options in force",
    attackerControlled: false,
    mask: ["urlCredentials", "imageTail"],
    capChars: 160,
    stability: "S1",
    placement: ["tools"],
    defaultAt: { minimal: "masked", standard: "masked", full: "on" },
  },
  {
    id: "wsl",
    label: "WSL executor",
    source: "the WSL preference and whether Windows programs start from it",
    attackerControlled: false,
    mask: [],
    capChars: 40,
    stability: "S1",
    placement: ["tools"],
    defaultAt: ON,
  },
  {
    id: "userland",
    label: "tool family (GNU, BSD)",
    source: "the platform and Alpine or busybox markers",
    attackerControlled: false,
    mask: [],
    capChars: 40,
    stability: "S0",
    placement: ["tools"],
    defaultAt: ON,
  },
  {
    id: "containerHint",
    label: "container marker",
    source: "/.dockerenv and similar markers",
    attackerControlled: false,
    mask: [],
    capChars: 80,
    stability: "S0",
    placement: ["tools"],
    defaultAt: FROM_STANDARD,
  },
  {
    id: "roots",
    label: "working folder",
    source: "the working folder (CLI) or the workspace folders (editor)",
    attackerControlled: true,
    mask: ["home", "user", "invisible", "escape"],
    capChars: 260,
    capItems: 8,
    stability: "S1",
    placement: ["firstUser"],
    defaultAt: { minimal: "off", standard: "masked", full: "on" },
  },
  {
    id: "isGitRepo",
    label: "git repository",
    source: "git rev-parse --is-inside-work-tree",
    attackerControlled: false,
    mask: [],
    capChars: 5,
    stability: "S1",
    placement: ["firstUser"],
    defaultAt: FROM_STANDARD,
  },
  {
    id: "date",
    label: "date",
    source: "the person's local calendar day",
    attackerControlled: false,
    mask: [],
    capChars: 10,
    stability: "S2",
    placement: ["firstUser"],
    defaultAt: ON,
  },
  {
    id: "timeZone",
    label: "time zone",
    source: "Intl resolved options",
    attackerControlled: false,
    mask: [],
    capChars: 40,
    stability: "S2",
    placement: ["firstUser"],
    defaultAt: FULL_ONLY,
  },
  {
    id: "locale",
    label: "locale",
    source: "Intl resolved options",
    attackerControlled: false,
    mask: [],
    capChars: 16,
    stability: "S2",
    placement: ["firstUser"],
    defaultAt: FULL_ONLY,
  },
  {
    id: "gitBranch",
    label: "git branch",
    source: "git branch --show-current at the start",
    attackerControlled: true,
    mask: ["user", "invisible", "escape", "secrets"],
    capChars: 120,
    stability: "S2",
    placement: ["firstUser"],
    defaultAt: FROM_STANDARD,
  },
  {
    id: "gitStatus",
    label: "git status",
    source: "git status --porcelain -z",
    attackerControlled: true,
    mask: ["home", "user", "invisible", "escape"],
    capChars: 4000,
    capLines: 40,
    stability: "S2",
    placement: ["firstUser"],
    defaultAt: FROM_STANDARD,
    ideDefaultAt: FULL_ONLY,
  },
  {
    id: "gitRemote",
    label: "git remote",
    source: "git remote get-url origin, as host/owner/repository",
    attackerControlled: true,
    mask: ["urlCredentials", "secrets", "escape"],
    capChars: 200,
    stability: "S2",
    placement: ["firstUser"],
    defaultAt: FULL_ONLY,
  },
  {
    id: "dateUpdate",
    label: "date change",
    source: "the local day changed since the snapshot",
    attackerControlled: false,
    mask: [],
    capChars: 80,
    stability: "S3",
    placement: ["update"],
    defaultAt: ON,
    note: "only when the local day changes",
  },
  {
    id: "editorDelta",
    label: "editor changes",
    source: "active file, selection range, problem and tab counts",
    attackerControlled: true,
    mask: ["home", "user", "invisible", "escape"],
    capChars: 600,
    stability: "S3",
    placement: ["update"],
    defaultAt: OFF,
    note: "not built yet (2.20.0)",
  },
  {
    id: "toolVersions",
    label: "tool versions",
    source: "the terminal tool, when the model asks",
    attackerControlled: false,
    mask: [],
    capChars: 0,
    stability: "S4",
    placement: ["onDemand"],
    defaultAt: OFF,
    note: "only when the model runs a command",
  },
  {
    id: "directoryListings",
    label: "directory listings",
    source: "the terminal and file tools, when the model asks",
    attackerControlled: true,
    mask: [],
    capChars: 0,
    stability: "S4",
    placement: ["onDemand"],
    defaultAt: OFF,
    note: "only when the model runs a command",
  },
  {
    id: "envVarNames",
    label: "environment variable names",
    source: "the terminal tool, when the model asks",
    attackerControlled: false,
    mask: [],
    capChars: 0,
    stability: "S4",
    placement: ["onDemand"],
    defaultAt: OFF,
    note: "only when the model runs a command",
  },
  never("permissionLevel", "permission level", "not disclosed"),
  never("userName", "user name"),
  never("hostName", "host name"),
  never("gitIdentity", "git user name and email"),
  never("networkAddresses", "network addresses"),
  never("envVarValues", "environment variable values"),
];

/** The caps on each rendered piece, in characters. */
export const ENV_BLOCK_CAPS = {
  /** The `<env>` lines of the system message. */
  systemEnv: 200,
  toolSentence: 900,
  firstUser: 6000,
} as const;

/** The regions whose bytes are cached across folders and sessions. */
export const SHARED_PREFIX_REGIONS: readonly Region[] = ["system", "tools"];

export class EnvContractError extends Error {}

export function fieldSpec(
  id: EnvFieldId,
  specs: readonly EnvFieldSpec[] = ENV_FIELDS,
): EnvFieldSpec {
  const spec = specs.find((s) => s.id === id);
  if (!spec) {
    throw new EnvContractError(`environment field ${id} has no contract row`);
  }
  return spec;
}

/** The setting of a field for a detail level and a surface. */
export function fieldSetting(
  spec: EnvFieldSpec,
  detail: Detail,
  surface: Surface,
): FieldSetting {
  if (spec.never) return "off";
  const table =
    surfaceFamilyOf(surface) === "ide" && spec.ideDefaultAt
      ? spec.ideDefaultAt
      : spec.defaultAt;
  return table[detail];
}

/**
 * The gate every rendered value passes: throws when the field is never sent
 * or when `region` is not one its row lists. Returns the row.
 */
export function assertMayRender(
  id: EnvFieldId,
  region: Region,
  specs: readonly EnvFieldSpec[] = ENV_FIELDS,
): EnvFieldSpec {
  const spec = fieldSpec(id, specs);
  if (spec.never) {
    throw new EnvContractError(`environment field ${id} is never sent`);
  }
  if (!spec.placement.includes(region)) {
    throw new EnvContractError(
      `environment field ${id} may not appear in the ${region} region`,
    );
  }
  return spec;
}

/**
 * Every way a table breaks the placement rules, as sentences; empty when it
 * keeps them. The cached regions (tools and system) may hold only S0 and S1
 * facts that no repository controls, and a never-sent fact has no place and
 * no level that turns it on.
 */
export function checkPlacement(
  specs: readonly EnvFieldSpec[] = ENV_FIELDS,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    if (seen.has(spec.id)) problems.push(`${spec.id} has two rows`);
    seen.add(spec.id);
    const settings = [
      ...Object.values(spec.defaultAt),
      ...Object.values(spec.ideDefaultAt ?? {}),
    ];
    if (spec.never) {
      if (spec.placement.length > 0) {
        problems.push(`${spec.id} is never sent but has a placement`);
      }
      if (settings.some((s) => s !== "off")) {
        problems.push(`${spec.id} is never sent but a level turns it on`);
      }
      continue;
    }
    if (!spec.stability) problems.push(`${spec.id} has no stability class`);
    if (spec.placement.length === 0) problems.push(`${spec.id} has no place`);
    for (const region of spec.placement) {
      if (!SHARED_PREFIX_REGIONS.includes(region)) continue;
      if (spec.attackerControlled) {
        problems.push(
          `${spec.id} is repository-controlled and may not be in ${region}`,
        );
      }
      if (spec.stability !== "S0" && spec.stability !== "S1") {
        problems.push(
          `${spec.id} is ${spec.stability ?? "unclassed"} and may not be in ${region}`,
        );
      }
    }
  }
  return problems;
}
