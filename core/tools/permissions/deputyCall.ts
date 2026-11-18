import * as os from "node:os";
import { builtinRuleOn, type BuiltinRuleId } from "./policy";
import type { ProtectedHit } from "./protected";
import { deputyTargets } from "./deputyTargets";
import {
  deputyPathHit,
  hostFlavor,
  type DeputyHit,
  type PathFlavor,
} from "./deputyPaths";
import { globalDirsFor } from "./selfProtect";

export interface DeputyCallInput {
  toolName: string;
  parsedArgs: Record<string, unknown>;
  /** What the tool resolved: the real path and whether it is in a workspace folder. */
  resolved?: { path?: string; withinWorkspace?: boolean };
  cwd?: string;
  approval?: { builtin?: Partial<Record<BuiltinRuleId, boolean>> };
  flavor?: PathFlavor;
  home?: string;
  /** An MCP tool: its path-named arguments are judged */
  mcp?: boolean;
  /** The MCP tool's JSON schema (`inputSchema`): a string it calls a path is judged too */
  schema?: Record<string, unknown>;
  /** Every workspace folder as a path; a path in any of them is inside */
  workspaceDirs?: readonly string[];
  /**
   * Follows links for an MCP path argument and says whether the real path is
   * inside a workspace folder. Supplied only where the host is local
   * (realPath.ts); without it MCP paths are judged as written.
   */
  resolvePath?: (
    raw: string,
  ) => { path: string; withinWorkspace: boolean } | undefined;
}

/**
 * The confused-deputy check for one tool call (deputyPaths.ts): the built-in
 * file, list and search tools and the path arguments of MCP tools. Switchable by the person's own `builtin` settings and by
 * nothing else: `ask-outside-paths` for a path outside the workspace or in
 * another account's home, `protect-network-paths` for a UNC path. A device
 * path, an alternate data stream and the global configuration folder have no
 * switch.
 */
export function deputyCallHit(
  input: DeputyCallInput,
): ProtectedHit | undefined {
  const targets = deputyTargets(
    input.toolName,
    input.parsedArgs,
    input.mcp === true,
    input.schema,
  );
  if (!targets) return undefined;
  // read_currently_open_file names no path: judge the one it resolved.
  const paths = targets.fromResolved
    ? input.resolved?.path
      ? [input.resolved.path]
      : []
    : targets.paths;
  const home = input.home ?? os.homedir();
  const on = (id: BuiltinRuleId) => builtinRuleOn(input.approval as never, id);
  const base = {
    flavor: input.flavor ?? hostFlavor(),
    home,
    cwd: input.cwd,
    roots: input.workspaceDirs,
    globalDirs: globalDirsFor(home),
  };
  for (const raw of paths) {
    const followed =
      input.mcp && !targets.single ? input.resolvePath?.(raw) : undefined;
    const hit: DeputyHit | undefined =
      // The real path first, then the path as written: a link can only add a
      // reason to ask, never remove the one the text gives.
      (followed
        ? deputyPathHit({
            ...base,
            raw,
            resolved: followed.path,
            withinWorkspace: followed.withinWorkspace,
          })
        : undefined) ??
      deputyPathHit({
        ...base,
        raw,
        resolved: targets.single ? input.resolved?.path : undefined,
        withinWorkspace: targets.single
          ? input.resolved?.withinWorkspace
          : undefined,
      });
    if (!hit) continue;
    if (hit.why === "network" && !on("protect-network-paths")) continue;
    if (
      (hit.why === "outside-workspace" || hit.why === "other-account") &&
      !on("ask-outside-paths")
    ) {
      continue;
    }
    return { kind: hit.kind, path: hit.path };
  }
  return undefined;
}
