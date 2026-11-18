/**
 * `environment.detail`: how much the model is told about the machine and the
 * workspace (plans/research/env-disclosure-master-plan.md 3.5 and 5.5, row
 * ENV18). `minimal`, `standard` (the default) or `full`.
 *
 * The person's own settings choose the level: the `--env-detail` flag, the
 * editor's machine setting `continuous.environment.detail`, then
 * `environment.detail` in their own config.yaml. Anything else (a workspace
 * setting, an assistant's or a project's config) may lower it, never raise
 * it, so a repository cannot make the agent send more about the machine.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";

import type { Detail } from "./environmentContract";
import { DEFAULT_DETAIL, parseEnvDetail } from "./environmentSnapshot";
import { getContinueGlobalPath } from "./paths";

const RANK: Record<Detail, number> = { minimal: 0, standard: 1, full: 2 };

export interface DetailSources {
  /** `--env-detail` on the command line. */
  flag?: Detail;
  /** The editor's machine-scoped setting (its user value). */
  editor?: Detail;
  /** `environment.detail` in the person's own config.yaml. */
  user?: Detail;
  /** Sources that may only lower the level. */
  lowerOnly?: ReadonlyArray<Detail | undefined>;
}

/** The level in force, from the sources above. */
export function resolveEnvironmentDetail(sources: DetailSources): Detail {
  let level = sources.flag ?? sources.editor ?? sources.user ?? DEFAULT_DETAIL;
  for (const other of sources.lowerOnly ?? []) {
    if (other && RANK[other] < RANK[level]) level = other;
  }
  return level;
}

/** `environment.detail` from a parsed config.yaml value, if well formed. */
export function environmentDetailOf(config: unknown): Detail | undefined {
  const env = (config as { environment?: unknown } | undefined)?.environment;
  return parseEnvDetail((env as { detail?: unknown } | undefined)?.detail);
}

/** `environment.detail` in the person's own config.yaml. */
export function readUserEnvironmentDetail(
  file = path.join(getContinueGlobalPath(), "config.yaml"),
): Detail | undefined {
  try {
    if (!fs.existsSync(file)) return undefined;
    return environmentDetailOf(YAML.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return undefined;
  }
}

let editorOwn: Detail | undefined;
let editorWorkspace: Detail | undefined;

/**
 * Set by the editor from `continuous.environment.detail`: the user value
 * chooses, a workspace value may only lower it.
 */
export function setEditorEnvironmentDetail(
  own: Detail | undefined,
  workspace?: Detail,
): void {
  editorOwn = own;
  editorWorkspace = workspace;
}

/** The level for a new editor session. */
export function editorEnvironmentDetail(
  lowerOnly: ReadonlyArray<Detail | undefined> = [],
): Detail {
  return resolveEnvironmentDetail({
    editor: editorOwn,
    user: readUserEnvironmentDetail(),
    lowerOnly: [editorWorkspace, ...lowerOnly],
  });
}
