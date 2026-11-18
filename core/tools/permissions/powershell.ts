/**
 * What PowerShell makes of a command word and its parameters
 * (plans/command-analysis.md, P3). A text rule on `Remove-Item` has to see
 * `rm`, `del` and `ri`; a flag list has to see `-Rec` and `-Recurse:$true`
 * as the same parameter; and a command is only known to read if every
 * parameter it passes is one the cmdlet is known to have. The alias table
 * itself is in powershellAliases.ts.
 */
import { isAliasName, resolveAlias } from "./powershellAliases";

/**
 * The cmdlet a command word stands for, lower case: through an alias, or the
 * word itself when it is already a `Verb-Noun` name. Undefined for anything
 * else (a program, a script, a function).
 */
export function canonicalCmdlet(word: string): string | undefined {
  const w = word.toLowerCase();
  const aliased = resolveAlias(w);
  if (aliased) return aliased;
  return /^[a-z]+-[a-z][a-z0-9]*$/.test(w) ? w : undefined;
}

/** True when the word is an alias PowerShell defines (and not itself a cmdlet name). */
export function isPowerShellAlias(word: string): boolean {
  return isAliasName(word);
}

/** The short names PowerShell gives the common parameters. */
const COMMON_ALIASES: Record<string, string> = {
  ea: "ErrorAction",
  wa: "WarningAction",
  infa: "InformationAction",
  ev: "ErrorVariable",
  wv: "WarningVariable",
  iv: "InformationVariable",
  ov: "OutVariable",
  ob: "OutBuffer",
  pv: "PipelineVariable",
  vb: "Verbose",
  db: "Debug",
};

/** Parameters every cmdlet accepts. */
const COMMON = [
  "Verbose",
  "Debug",
  "ErrorAction",
  "WarningAction",
  "InformationAction",
  "ErrorVariable",
  "WarningVariable",
  "InformationVariable",
  "OutVariable",
  "OutBuffer",
  "PipelineVariable",
  "ProgressAction",
];

/**
 * The cmdlets this knows only read, and every parameter each has. A parameter
 * not on the list is not recognised, so the command is not vouched. `WhatIf`
 * and `Confirm` are left out on purpose: they belong to cmdlets that change
 * things.
 */
const READ_CMDLETS: Record<string, string[]> = {
  "get-childitem": [
    "Path",
    "LiteralPath",
    "Filter",
    "Include",
    "Exclude",
    "Recurse",
    "Depth",
    "Force",
    "Name",
    "Attributes",
    "FollowSymlink",
    "Directory",
    "File",
    "Hidden",
    "ReadOnly",
    "System",
  ],
  "get-content": [
    "Path",
    "LiteralPath",
    "ReadCount",
    "TotalCount",
    "Head",
    "First",
    "Tail",
    "Last",
    "Filter",
    "Include",
    "Exclude",
    "Force",
    "Delimiter",
    "Wait",
    "Raw",
    "Encoding",
    "AsByteStream",
    "Stream",
  ],
  "select-string": [
    "Pattern",
    "Path",
    "LiteralPath",
    "InputObject",
    "SimpleMatch",
    "CaseSensitive",
    "Quiet",
    "List",
    "Include",
    "Exclude",
    "NotMatch",
    "AllMatches",
    "Encoding",
    "Context",
    "Raw",
  ],
  "get-location": ["PSProvider", "PSDrive", "Stack", "StackName"],
  "get-item": [
    "Path",
    "LiteralPath",
    "Filter",
    "Include",
    "Exclude",
    "Force",
    "Stream",
  ],
  "test-path": [
    "Path",
    "LiteralPath",
    "Filter",
    "Include",
    "Exclude",
    "PathType",
    "IsValid",
    "OlderThan",
    "NewerThan",
  ],
  "resolve-path": ["Path", "LiteralPath", "Relative"],
  "split-path": [
    "Path",
    "LiteralPath",
    "Qualifier",
    "NoQualifier",
    "Parent",
    "Leaf",
    "LeafBase",
    "Extension",
    "IsAbsolute",
    "Resolve",
  ],
  "get-filehash": ["Path", "LiteralPath", "InputStream", "Algorithm"],
  "get-date": [
    "Date",
    "Year",
    "Month",
    "Day",
    "Hour",
    "Minute",
    "Second",
    "Millisecond",
    "DisplayHint",
    "Format",
    "UFormat",
  ],
  "select-object": [
    "InputObject",
    "Property",
    "ExcludeProperty",
    "ExpandProperty",
    "Unique",
    "Last",
    "First",
    "Skip",
    "SkipLast",
    "Wait",
    "Index",
  ],
  "measure-object": [
    "InputObject",
    "Property",
    "Sum",
    "Average",
    "Maximum",
    "Minimum",
    "Line",
    "Word",
    "Character",
    "IgnoreWhiteSpace",
  ],
  "sort-object": [
    "InputObject",
    "Descending",
    "Unique",
    "Property",
    "Culture",
    "CaseSensitive",
    "Stable",
    "Top",
    "Bottom",
  ],
  "format-table": [
    "InputObject",
    "Property",
    "AutoSize",
    "HideTableHeaders",
    "Wrap",
    "GroupBy",
    "View",
    "ShowError",
    "DisplayError",
    "Force",
    "Expand",
    "RepeatHeader",
  ],
  "format-list": [
    "InputObject",
    "Property",
    "GroupBy",
    "View",
    "ShowError",
    "DisplayError",
    "Force",
    "Expand",
  ],
  "write-output": ["InputObject", "NoEnumerate"],
  "compare-object": [
    "ReferenceObject",
    "DifferenceObject",
    "SyncWindow",
    "Property",
    "ExcludeDifferent",
    "IncludeEqual",
    "PassThru",
    "Culture",
    "CaseSensitive",
  ],
  "set-location": ["Path", "LiteralPath", "PassThru", "StackName"],
  // No ComputerName: it asks another machine, and Windows signs in to it
  "get-process": [
    "Name",
    "Id",
    "InputObject",
    "Module",
    "FileVersionInfo",
    "IncludeUserName",
  ],
  "get-service": [
    "Name",
    "DisplayName",
    "DependentServices",
    "RequiredServices",
    "Include",
    "Exclude",
    "InputObject",
  ],
};

/** True for a cmdlet this knows only reads. */
export function isReadCmdlet(cmdlet: string): boolean {
  return cmdlet in READ_CMDLETS;
}

export type ParameterResolution =
  { ok: true; name: string; value?: string } | { ok: false; why: string };

/**
 * A word that starts with `-` as the parameter of a cmdlet: PowerShell takes
 * any unambiguous prefix (`-Rec` is `-Recurse`), is case-insensitive, and
 * accepts `-Name:value`. An ambiguous prefix is an error in PowerShell and is
 * not resolved here. Undefined for a word that is not a parameter (a negative
 * number, a lone dash).
 */
export function resolveParameter(
  cmdlet: string,
  word: string,
): ParameterResolution | undefined {
  if (!/^-[A-Za-z]/.test(word)) return undefined;
  const colon = word.indexOf(":");
  const raw = (colon > 0 ? word.slice(1, colon) : word.slice(1)).toLowerCase();
  const value = colon > 0 ? word.slice(colon + 1) : undefined;
  const known = [...(READ_CMDLETS[cmdlet] ?? []), ...COMMON];
  const exact = known.find((p) => p.toLowerCase() === raw);
  if (exact) return { ok: true, name: exact, value };
  if (raw in COMMON_ALIASES) {
    return { ok: true, name: COMMON_ALIASES[raw], value };
  }
  const matches = known.filter((p) => p.toLowerCase().startsWith(raw));
  if (matches.length === 1) return { ok: true, name: matches[0], value };
  return {
    ok: false,
    why:
      matches.length > 1
        ? `parameter ${word} is ambiguous for ${cmdlet}`
        : `parameter ${word} is not recognised for ${cmdlet}`,
  };
}

/**
 * Why a call to a read cmdlet is not known to read, or undefined when every
 * parameter is one it has. Not a read cmdlet: says so.
 */
export function checkReadCmdlet(
  cmdlet: string,
  args: string[],
): string | undefined {
  if (!isReadCmdlet(cmdlet)) return `${cmdlet} is not a known read cmdlet`;
  for (const arg of args) {
    if (arg === "--%") return "the stop-parsing symbol (--%) is not understood";
    const r = resolveParameter(cmdlet, arg);
    if (r && !r.ok) return r.why;
  }
  return undefined;
}
