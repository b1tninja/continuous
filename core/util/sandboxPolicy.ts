import * as posix from "node:path/posix";
import {
  CONFIG_BASENAMES,
  CONFIG_DIRS,
  CONFIG_DIR_PAIRS,
  HOME_SECRET_DIRS,
  HOME_SECRET_FILES,
  SECRET_BASENAMES,
  SECRET_EXTENSIONS,
  isConfigPath,
  isSecretPath,
} from "../tools/permissions/protectedPaths";
import {
  POLICY_AREAS,
  builtinRuleOn,
  parsePolicyLevel,
  type BuiltinRuleId,
} from "../tools/permissions/policy";
import { canonicalRuleName } from "../tools/permissions/names";
import { isDestinationPattern, parseRule } from "../tools/permissions/rules";
import { isNetSet } from "../tools/permissions/destinations";
import {
  parseEgressPolicy,
  parseHostRule,
  type HostRule,
} from "./egressPolicy";
import {
  BROAD_DENY_READ,
  CANONICAL_CASE,
  ENV_GLOBS,
  HOME_READ_ALLOWED,
  LINUX_HOME_SECRETS,
  MACOS_HOME_SECRETS,
  MACOS_PRIVATE_ALIASED,
  NARROWED_CONFIG_DIRS,
  OWN_HOME_DIRS,
  PRECREATE_SAFE,
  PROJECT_POLICY_DIRS,
  SYSTEM_DIRS,
  SYSTEM_SECRET_PATHS,
  SYSTEM_TEMP_ROOTS,
  notEnforcedItems,
} from "./sandboxPolicyData";
import {
  GLOB_META,
  TEMP_AREAS,
  conflict,
  dedupeSorted,
  put,
  underOrEqual,
  type Acc,
  type Ctx,
} from "./sandboxPolicyAcc";
import { addNetwork, type DestRule } from "./sandboxPolicyNet";
import type {
  EnforcedItem,
  SandboxCompileInput,
  SandboxCompileResult,
  SandboxConflict,
  SandboxEffect,
  SandboxPlan,
  SandboxSource,
} from "./sandboxPolicyTypes";

export type {
  SandboxCompileInput,
  SandboxCompileResult,
  SandboxPlan,
  SandboxPlanFailure,
} from "./sandboxPolicyTypes";
export {
  sandboxAutoApproval,
  type AreaDecision,
  type SandboxApprovalOptions,
  type SandboxApprovalResult,
} from "./sandboxApproval";
export { describeSandboxPlan } from "./sandboxPolicyDescribe";

/**
 * The policy to sandbox compiler (plans/ROADMAP.md W8a): pure data in, an srt
 * configuration out, with a list of what the OS layer now enforces, a list of
 * what it cannot, and a refusal when a rule cannot be expressed. No file is
 * read, no process is started, srt is not imported and nothing is applied.
 *
 * Mapping, each entry tagged with its source in `enforced`:
 * 1. A `deny` rule on a file tool with a path becomes `denyRead` and
 *    `denyWrite` (a `writeFile` deny: `denyWrite` only). Protected secrets
 *    (protectedPaths.ts, unless `protect-secrets` is off) and our own config
 *    directories become `denyRead` and `denyWrite`.
 * 2. "What runs later" (CONFIG_DIRS, CONFIG_BASENAMES, CONFIG_DIR_PAIRS,
 *    unless `protect-config` is off) and the locked paths become `denyWrite`
 *    only, at the root and in nested glob form. Reads stay allowed.
 * 3. `allowWrite` is the workspace, the temp dir and the extra writable dirs.
 * 4. Network: `none` gives no domains; `allowlist` gives the model host plus
 *    the egress policy's hosts (the resolver in egressPolicy.ts, presets
 *    included); `open` gives `*` and is reported as weakened; `host:` and
 *    `net:` deny rules and the egress deny list become `deniedDomains`.
 *
 * Fail closed: any input error or inexpressible rule gives `{ ok: false }`
 * and the caller must run unsandboxed with an ask, or refuse. Levels never
 * change the config: a floor, a deny rule and a protected path hold at every
 * level. Ask and allow rules are not carried by the OS layer (`policyOnly`).
 *
 * The result says "confined as configured". It never says "contained": that
 * claim waits for our own probes (escapeProbes.ts) on the running sandbox.
 */

const LABEL =
  "Confined as configured; contained only after our probes say so. Not applied.";

const FILE_READ_TOOLS = new Set([
  "readFile",
  "listDirectory",
  "grepSearch",
  "globSearch",
]);
const FILE_WRITE_TOOLS = new Set(["writeFile"]);
const BUILTIN_IDS: readonly BuiltinRuleId[] = [
  "protect-secrets",
  "protect-config",
  "protect-network-paths",
  "refuse-dangerous-commands",
  "no-fetch-and-run",
  "ask-destructive-commands",
  "ask-large-change",
  "ask-dependency-change",
  "ask-unknown-host",
  "ask-outside-paths",
  "plan-keeps-checks",
];

/** Normalise one absolute path from the input; undefined and a message if unusable. */
function absPath(label: string, raw: unknown, errs: string[]): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    errs.push(`${label}: a path is required`);
    return "";
  }
  if (/[\\\0]/.test(raw) || /^[A-Za-z]:/.test(raw) || !raw.startsWith("/")) {
    errs.push(
      `${label}: "${raw}" is not an absolute POSIX path (a Windows path cannot be confined here; use the WSL2 route)`,
    );
    return "";
  }
  if (GLOB_META.test(raw)) {
    errs.push(
      `${label}: "${raw}" contains a glob character; srt would need its literal form, which this compiler does not emit`,
    );
    return "";
  }
  const clean = posix.normalize(raw).replace(/(.)\/+$/, "$1");
  return clean;
}

function prepare(input: SandboxCompileInput): { ctx?: Ctx; errs: string[] } {
  const errs: string[] = [];
  if (!input || typeof input !== "object") {
    return { errs: ["input: an object is required"] };
  }
  if (!["linux", "wsl2", "macos"].includes(input.platform)) {
    errs.push(
      `platform: "${String(input.platform)}" is not linux, wsl2 or macos`,
    );
  }
  if (
    input.readPolicy !== undefined &&
    input.readPolicy !== "open" &&
    input.readPolicy !== "workspace-only"
  ) {
    errs.push(`readPolicy: "${String(input.readPolicy)}" is not valid`);
  }
  const levels = (input.levels ?? {}) as Record<string, unknown>;
  for (const area of POLICY_AREAS) {
    if (!parsePolicyLevel(levels[area])) {
      errs.push(`levels.${area}: "${String(levels[area])}" is not a level`);
    }
  }
  for (const id of Object.keys(input.builtin ?? {})) {
    if (!BUILTIN_IDS.includes(id as BuiltinRuleId)) {
      errs.push(`builtin.${id}: not a built-in rule`);
    }
  }
  const ws = absPath("workspace", input.workspace, errs);
  const tmp = absPath("tempDir", input.tempDir, errs);
  const home = absPath("homeDir", input.homeDir, errs);
  const many = (label: string, list: unknown): string[] =>
    (Array.isArray(list) ? list : []).map((p, i) =>
      absPath(`${label}[${i}]`, p, errs),
    );
  const extra = many("extraWritable", input.extraWritable);
  const readable = many("extraReadable", input.extraReadable);
  const locked = (input.lockedPaths ?? []).map((p, i) => {
    if (typeof p === "string" && !p.startsWith("/") && !p.startsWith("~/")) {
      return absPath(`lockedPaths[${i}]`, posix.join(ws || "/", p), errs);
    }
    const abs = typeof p === "string" ? p.replace(/^~(?=\/)/, home) : p;
    return absPath(`lockedPaths[${i}]`, abs, errs);
  });
  if (errs.length > 0) return { errs };
  const roots = [ws, ...dedupeSorted(extra.filter((p) => p !== ws))];
  return {
    ctx: { input, ws, tmp, home, extra, readable, locked, roots },
    errs,
  };
}

function builtinOn(ctx: Ctx, id: BuiltinRuleId): boolean {
  return builtinRuleOn(
    { levels: ctx.input.levels, builtin: ctx.input.builtin },
    id,
  );
}

function checkWritable(acc: Acc, ctx: Ctx): void {
  const { input } = ctx;
  const all: [string, string][] = [
    ["workspace", ctx.ws],
    ["tempDir", ctx.tmp],
    ...ctx.extra.map((p): [string, string] => ["extraWritable", p]),
  ];
  const isSecret = input.protectedPredicates?.isSecret ?? isSecretPath;
  const isConfig = input.protectedPredicates?.isConfig ?? isConfigPath;
  for (const [label, p] of all) {
    const tilde = underOrEqual(p, ctx.home)
      ? `~${p.slice(ctx.home.length)}`
      : p;
    if (p === "/" || underOrEqual(ctx.home, p)) {
      conflict(acc, `${label}: ${p}`, "covers the home directory or the root");
    } else if (
      SYSTEM_DIRS.some((d) => underOrEqual(p, d)) &&
      !TEMP_AREAS.some((d) => underOrEqual(p, d))
    ) {
      conflict(acc, `${label}: ${p}`, "is a system directory");
    } else if (isSecret(tilde)) {
      conflict(acc, `${label}: ${p}`, "is a protected secret location");
    } else if (isConfig(tilde)) {
      acc.warnings.push(
        `${label}: ${p} sits under a directory that holds configuration; the nested entries still protect what runs later`,
      );
    }
    if (input.platform === "wsl2" && /^\/mnt\/[a-z](\/|$)/i.test(p)) {
      conflict(
        acc,
        `${label}: ${p}`,
        "is on a Windows drive (9p): every folder looks writable and srt creates mount points on it; use the Linux file system",
      );
    }
  }
  for (const [label, p] of all) {
    if (SYSTEM_TEMP_ROOTS.includes(p)) {
      conflict(
        acc,
        `${label}: ${p}`,
        "is a system temp root shared with every program; use a private per-run directory",
      );
    }
  }
  put(acc, "allowWrite", ctx.roots, "workspace", "workspace and extraWritable");
  put(acc, "allowWrite", [ctx.tmp], "workspace", "tempDir");
}

/** `root/rel` and `root/**\/rel`: the expected location and the nested ones. */
function locations(root: string, rel: string): string[] {
  return [`${root}/${rel}`, `${root}/**/${rel}`];
}

function configRels(): { rels: string[]; bases: string[] } {
  const rels: string[] = [];
  const bases: string[] = [];
  for (const dir of CONFIG_DIRS) {
    for (const r of NARROWED_CONFIG_DIRS[dir] ?? [dir]) rels.push(r);
  }
  for (const [a, b] of CONFIG_DIR_PAIRS) {
    // The other pairs live in the home directory, which is never writable here
    if (a === ".github") {
      const joined = `${a}/${b}`;
      rels.push(CANONICAL_CASE[joined] ?? joined);
    }
  }
  for (const base of CONFIG_BASENAMES) {
    const r = CANONICAL_CASE[base] ?? base;
    rels.push(r);
    bases.push(r);
  }
  return { rels, bases };
}

function addConfig(acc: Acc, ctx: Ctx): void {
  if (!builtinOn(ctx, "protect-config")) {
    acc.warnings.push(
      "protect-config is off: nothing that runs later is write-protected at the OS layer except locked paths and srt's own mandatory list",
    );
    return;
  }
  const { rels, bases } = configRels();
  for (const root of ctx.roots) {
    put(
      acc,
      "denyWrite",
      rels.flatMap((r) => locations(root, r)),
      "protected-config",
      "CONFIG_DIRS, CONFIG_DIR_PAIRS, CONFIG_BASENAMES",
      root === ctx.ws
        ? ".git is narrowed to hooks and config, .yarn to releases and plugins: denying more would stop git commit and yarn install"
        : undefined,
    );
  }
  if (ctx.input.precreate) {
    for (const rel of PRECREATE_SAFE) {
      if (bases.includes(rel)) acc.precreate.add(`${ctx.ws}/${rel}`);
    }
    acc.warnings.push(
      "precreate: empty placeholder files will appear as untracked files in the workspace; create each only if absent, never overwrite",
    );
  }
}

function addSecrets(acc: Acc, ctx: Ctx): void {
  const names = [
    ...ENV_GLOBS,
    ...SECRET_BASENAMES,
    ...[...SECRET_EXTENSIONS].map((e) => `*${e}`),
  ];
  const homeSecrets = [...HOME_SECRET_DIRS, ...HOME_SECRET_FILES];
  const mac = ctx.input.platform === "macos";
  const others = [...HOME_SECRET_DIRS].flatMap((d) =>
    (mac ? ["/Users/*"] : ["/home/*", "/root"]).map((h) => `${h}/${d}`),
  );
  // The OS credential stores in the home directory (S9-X3)
  const stores = (mac ? MACOS_HOME_SECRETS : LINUX_HOME_SECRETS).map(
    (d) => `${ctx.home}/${d}`,
  );
  if (builtinOn(ctx, "protect-secrets")) {
    for (const effect of ["denyRead", "denyWrite"] as const) {
      // S9-X3's allow list is readable; it stays write-protected
      const home = homeSecrets
        .filter((d) => effect === "denyWrite" || !HOME_READ_ALLOWED.includes(d))
        .map((d) => `${ctx.home}/${d}`);
      put(
        acc,
        effect,
        [
          ...home,
          ...stores,
          ...others,
          ...(mac ? [] : SYSTEM_SECRET_PATHS),
          ...ctx.roots.flatMap((r) => names.flatMap((n) => locations(r, n))),
        ],
        "protected-secret",
        "HOME_SECRET_DIRS, HOME_SECRET_FILES, SECRET_BASENAMES, SECRET_EXTENSIONS, env files, system secrets, OS credential stores",
        effect === "denyRead"
          ? `readable by decision (S9-X3): ${HOME_READ_ALLOWED.map((f) => `~/${f}`).join(", ")}`
          : undefined,
      );
    }
  } else {
    acc.warnings.push(
      "protect-secrets is off: credentials are not hidden from commands at the OS layer",
    );
  }
  // Our own configuration holds keys and rules, whatever a built-in rule says
  const own = OWN_HOME_DIRS.map((d) => `${ctx.home}/${d}`);
  for (const effect of ["denyRead", "denyWrite"] as const) {
    put(acc, effect, own, "own-config", "our home configuration directories");
  }
  // And a project's: its rules, permissions and hooks (S9-X3)
  const project = ctx.roots.flatMap((r) =>
    PROJECT_POLICY_DIRS.map((d) => `${r}/${d}`),
  );
  for (const effect of ["denyRead", "denyWrite"] as const) {
    put(
      acc,
      effect,
      project,
      "own-config",
      "the project's policy folders (PROJECT_POLICY_DIRS)",
    );
  }
  if (ctx.locked.length > 0) {
    put(acc, "denyWrite", ctx.locked, "locked-path", "lockedPaths");
  }
}

function resolvePattern(
  pattern: string,
  ctx: Ctx,
): { paths: string[] } | { error: string } {
  const p = pattern.trim().replace(/\\/g, "/");
  if (/[[\]{}$`]/.test(p) || /^[A-Za-z]:/.test(p)) {
    return { error: "the pattern uses characters srt's globs do not share" };
  }
  const abs = p.startsWith("~/")
    ? `${ctx.home}${p.slice(1)}`
    : p.startsWith("/")
      ? p
      : posix.join(ctx.ws, p.replace(/^(\.\/)+/, ""));
  const clean = posix.normalize(abs).replace(/(.)\/+$/, "$1");
  const first = clean.split("/")[1] ?? "";
  if (/[*?]/.test(first) && ctx.input.platform !== "macos") {
    return {
      error:
        "a wildcard in the first path component is skipped by srt on Linux",
    };
  }
  const paths = [clean];
  if (clean.endsWith("/**")) paths.push(clean.slice(0, -3));
  return { paths };
}

function addDenyRules(acc: Acc, ctx: Ctx): DestRule[] {
  const dest: DestRule[] = [];
  for (const raw of ctx.input.toolPermissions?.deny ?? []) {
    const rule = parseRule(String(raw), "deny");
    if (!rule) {
      conflict(acc, String(raw), "a deny rule that cannot be read; refusing");
      continue;
    }
    const name = canonicalRuleName(rule.toolName);
    const reads = FILE_READ_TOOLS.has(name);
    const writes = FILE_WRITE_TOOLS.has(name);
    if (!reads && !writes) {
      if (
        name === "runTerminalCommand" &&
        rule.pattern !== undefined &&
        isDestinationPattern(rule.pattern)
      ) {
        const m = /^(?:(\S+)\s+)?(host|net):(\S+)$/i.exec(rule.pattern.trim());
        if (m) {
          dest.push({
            raw: rule.raw,
            program: m[1],
            kind: m[2].toLowerCase() as "host" | "net",
            value: m[3],
          });
          continue;
        }
      }
      acc.policyOnly.push(
        `${rule.raw}: decided by the rule engine before a command runs; the OS layer does not read commands or run MCP, web or other host tools`,
      );
      continue;
    }
    if (rule.pattern === undefined) {
      acc.policyOnly.push(
        `${rule.raw}: a whole-tool deny; a command can still reach the same files through the shell`,
      );
      acc.warnings.push(
        `${rule.raw} has no path, so it adds no OS entry; add a path pattern to confine commands`,
      );
      continue;
    }
    const r = resolvePattern(rule.pattern, ctx);
    if ("error" in r) {
      conflict(acc, rule.raw, r.error);
      continue;
    }
    if (reads) put(acc, "denyRead", r.paths, "deny-rule", rule.raw);
    put(acc, "denyWrite", r.paths, "deny-rule", rule.raw);
  }
  return dest;
}

function addReadPolicy(acc: Acc, ctx: Ctx): void {
  const { platform } = ctx.input;
  if (ctx.input.readPolicy === "workspace-only") {
    put(
      acc,
      "denyRead",
      [...BROAD_DENY_READ[platform]],
      "read-policy",
      "workspace-only",
    );
    put(
      acc,
      "allowRead",
      [...ctx.roots, ctx.tmp, ...ctx.readable],
      "read-policy",
      "workspace-only: workspace, tempDir, extra dirs",
    );
    // S9-X3's allow list, unless a deny rule of the person's names the file
    const allowed = HOME_READ_ALLOWED.map((f) => `${ctx.home}/${f}`).filter(
      (p) => !acc.fs.denyRead.has(p),
    );
    if (allowed.length > 0) {
      put(acc, "allowRead", allowed, "read-policy", "S9-X3 allow list");
    }
  } else if (platform === "wsl2") {
    put(acc, "denyRead", ["/mnt"], "platform", "wsl2: Windows drives");
  }
}

function checkOverlap(acc: Acc, ctx: Ctx): void {
  for (const root of [...ctx.roots, ctx.tmp]) {
    for (const entry of dedupeSorted(acc.specific)) {
      if (underOrEqual(root, entry)) {
        conflict(
          acc,
          `writable root ${root}`,
          `is inside the denied path ${entry}; the deny wins, so it could never be written`,
        );
      }
    }
  }
}

function failure(
  reasons: string[],
  conflicts: SandboxConflict[] = [],
  warnings: string[] = [],
): SandboxCompileResult {
  return { ok: false, reasons, conflicts, warnings };
}

function compile(input: SandboxCompileInput): SandboxCompileResult {
  const { ctx, errs } = prepare(input);
  if (!ctx) return failure(errs);
  const acc: Acc = {
    platform: input.platform,
    fs: {
      denyRead: new Set(),
      allowRead: new Set(),
      allowWrite: new Set(),
      denyWrite: new Set(),
    },
    allowed: new Set(),
    denied: new Set(),
    enforced: [],
    policyOnly: [],
    conflicts: [],
    warnings: [],
    weakened: [],
    precreate: new Set(),
    specific: [],
  };
  checkWritable(acc, ctx);
  addSecrets(acc, ctx);
  addConfig(acc, ctx);
  const dest = addDenyRules(acc, ctx);
  addReadPolicy(acc, ctx);
  addNetwork(acc, ctx, dest);
  checkOverlap(acc, ctx);
  if (
    Object.values(ctx.input.levels).some((l) => parsePolicyLevel(l) === "idgaf")
  ) {
    acc.warnings.push(
      "a level is IDGAF: the policy ignores rules at that level, but the OS config is unchanged and still applies to commands that run in the sandbox",
    );
  }
  if (acc.conflicts.length > 0) {
    return failure(
      acc.conflicts.map((c) => `${c.rule}: ${c.why}`),
      acc.conflicts,
      dedupeSorted(acc.warnings),
    );
  }
  const readPolicy = input.readPolicy ?? "open";
  const plan: SandboxPlan = {
    ok: true,
    label: LABEL,
    platform: input.platform,
    workspace: ctx.ws,
    homeDir: ctx.home,
    readPolicy,
    // `yolo`, the old spelling of idgaf, is written as idgaf
    levels: Object.fromEntries(
      Object.entries(input.levels).map(([a, l]) => [
        a,
        parsePolicyLevel(l) ?? l,
      ]),
    ) as typeof input.levels,
    config: {
      filesystem: {
        denyRead: dedupeSorted(acc.fs.denyRead),
        allowRead: dedupeSorted(acc.fs.allowRead),
        allowWrite: dedupeSorted(acc.fs.allowWrite),
        denyWrite: dedupeSorted(acc.fs.denyWrite),
      },
      network: {
        allowedDomains: dedupeSorted(acc.allowed),
        deniedDomains: dedupeSorted(acc.denied),
        strictAllowlist: true,
        allowLocalBinding: false,
        allowUnixSockets: [],
      },
    },
    enforced: acc.enforced,
    notEnforced: notEnforcedItems(input.platform, readPolicy),
    policyOnly: dedupeSorted(acc.policyOnly),
    conflicts: [],
    warnings: dedupeSorted(acc.warnings),
    weakened: dedupeSorted(acc.weakened),
    precreate: dedupeSorted(acc.precreate),
  };
  return plan;
}

/**
 * Compile the policy inputs into an srt configuration and its honest limits.
 * Never throws: an unexpected error is a refusal.
 */
export function compileSandboxConfig(
  input: SandboxCompileInput,
): SandboxCompileResult {
  try {
    return compile(input);
  } catch (e) {
    return failure([
      `internal error, refusing: ${e instanceof Error ? e.message : String(e)}`,
    ]);
  }
}
