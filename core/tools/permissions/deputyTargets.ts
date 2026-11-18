import { keyIsPathBySchema, propertySchema } from "./mcpPathSchema";
import { fileToolTarget } from "./protectedCall";

/**
 * The paths a tool call names, for the confused-deputy rule (deputyCall.ts).
 *
 * - The built-in read, list and write tools: the path argument.
 * - `grep_search` with a `path` (the CLI's Search tool), and `file_glob_search`,
 *   whose pattern can begin with a path (`/etc/**`, `../../**`): the literal
 *   part before the first wildcard.
 * - An MCP tool: every string argument whose name says it is a path (`path`,
 *   `file_path`, `directory`, `uri`, `destination`...) and the strings in an
 *   array under such a name, and any string the tool's own JSON schema
 *   calls a path (`format: uri`, a path in its description). The tool's own
 *   `readonly` hint does not matter: a read is as much a leak as a write is
 *   a change. An argument with another name and no such schema evidence is
 *   not read.
 */

const GLOB_CHARS = /[*?[\]{}!()]/;

/** `/etc/**` is `/etc/`; `**` and `*.ts` have no literal part; `src/**` is `src/`. */
export function literalPrefix(pattern: string): string | undefined {
  const norm = pattern.trim().replace(/\\/g, "/");
  const segs = norm.split("/");
  const keep: string[] = [];
  for (const [i, seg] of segs.entries()) {
    if (i === segs.length - 1 || GLOB_CHARS.test(seg)) break;
    keep.push(seg);
  }
  const prefix = keep.join("/");
  if (prefix === "" && !norm.startsWith("/")) return undefined;
  return prefix === "" ? "/" : prefix;
}

const PATH_KEY =
  /(^|_|-)(path|paths|file|files|filepath|filepaths|filename|dir|dirs|dirpath|directory|folder|uri|src|source|dest|destination|target|cwd|root)$/i;

/** A URL that is not a file URI is not a path. */
function pathLike(value: string): boolean {
  if (!value.trim()) return false;
  return !/^[a-z][a-z0-9+.-]+:\/\//i.test(value) || /^file:/i.test(value);
}

function pushIfPath(out: string[], v: unknown) {
  if (typeof v === "string" && pathLike(v)) out.push(v);
}

/**
 * The path arguments of an MCP call: a string under a path-like name or one
 * the tool's schema calls a path (mcpPathSchema.ts), and the strings of an
 * array under such a name.
 */
function mcpPaths(
  args: Record<string, unknown>,
  schema?: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  const stack: [unknown, unknown, number][] = [[args, schema, 0]];
  while (stack.length > 0 && out.length < 64) {
    const [value, node, depth] = stack.pop()!;
    if (!value || typeof value !== "object" || depth > 4) continue;
    for (const [key, v] of Object.entries(value)) {
      const named = PATH_KEY.test(key) || keyIsPathBySchema(node, key);
      if (named && typeof v === "string") pushIfPath(out, v);
      else if (named && Array.isArray(v)) {
        for (const item of v) pushIfPath(out, item);
      } else if (v && typeof v === "object") {
        stack.push([v, propertySchema(node, key), depth + 1]);
      }
    }
  }
  return out;
}

export interface DeputyTargets {
  paths: string[];
  /** One built-in file tool path: the tool's own resolution applies to it. */
  single: boolean;
  /** The tool names no path itself (read_currently_open_file). */
  fromResolved?: boolean;
}

export function deputyTargets(
  toolName: string,
  parsedArgs: Record<string, unknown>,
  isMcp: boolean,
  schema?: Record<string, unknown>,
): DeputyTargets | undefined {
  if (isMcp) return { paths: mcpPaths(parsedArgs, schema), single: false };
  const target = fileToolTarget(toolName, parsedArgs);
  if (target) {
    return target.path
      ? { paths: [target.path], single: true }
      : { paths: [], single: true, fromResolved: true };
  }
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  if (toolName === "grep_search") {
    const p = str(parsedArgs.path) ?? str(parsedArgs.dirPath);
    return p ? { paths: [p], single: true } : undefined;
  }
  if (toolName === "file_glob_search") {
    const prefix = str(parsedArgs.pattern)
      ? literalPrefix(str(parsedArgs.pattern)!)
      : undefined;
    return prefix ? { paths: [prefix], single: true } : undefined;
  }
  return undefined;
}
