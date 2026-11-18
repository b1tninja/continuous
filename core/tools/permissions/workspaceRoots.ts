import type { EvaluateInput } from "./evaluate";
import { uriToPath } from "./names";
import { localLinkResolver } from "./realPath";

/**
 * What the evaluator needs to judge a path against every workspace folder
 * (a multi-root window) and, for a local workspace, to follow links in MCP
 * path arguments. The IDE gives folders as URIs: only `file:` ones (and a bare path, which the CLI gives) are
 * local paths, so a remote or virtual workspace contributes no root and no
 * link resolver (its paths are judged as written, and a call whose tool did
 * not resolve the path still asks).
 */
export function deputyWorkspace(
  dirs: readonly string[],
): Pick<EvaluateInput, "workspaceDirs" | "resolvePath"> {
  const isLocal = (d: string) =>
    d.startsWith("file:") || !/^[a-z][a-z0-9+.-]+:\/\//i.test(d);
  const local = dirs
    .filter(isLocal)
    .map((d) => (d.startsWith("file:") ? uriToPath(d) : d))
    .filter((d): d is string => !!d);
  if (local.length === 0 || local.length !== dirs.length) {
    return { workspaceDirs: local };
  }
  return { workspaceDirs: local, resolvePath: localLinkResolver(local) };
}
