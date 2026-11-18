import * as path from "path";

import {
  editsAllowOutsideWorkspace,
  wroteOutsideNote,
} from "core/tools/permissions/outsideEdits.js";
import { ContinueError, ContinueErrorReason } from "core/util/errors.js";

import { env } from "../env.js";
import { effectiveLevels } from "../permissions/policyLevels.js";
import { services } from "../services/index.js";

import type { ToolCallPreview } from "./types.js";

/**
 * Where the file tools may write without a person looking: inside the
 * working directory, or under the Continue home folder (rules, skills,
 * sessions). Under --auto Nova Pro wrote two files to an absolute path one
 * hex digit off the working directory and the Write tool followed it out of
 * the tree (research-bedrock-families.md item 4). Headless runs refuse
 * such a write; interactive runs say so in the approval preview, and the
 * person decides.
 *
 * File edits at IDGAF is the person saying nothing asks, so neither
 * the refusal nor the note's hold applies there: the write goes through, and
 * the result says where it landed (`wroteOutsideResult`). The levels are read
 * from the same place the permission check reads them, so a run started with
 * `--auto` or `--policy idgaf` behaves the same headless, in the TUI and under
 * `serve`. The permission layer (core's engine) still decides every call
 * first: the locked policy files, a tool switched off and the person's own
 * floor rules hold at every level.
 */

/** True while File edits is IDGAF, `--auto` included. */
export function editsAreIdgaf(): boolean {
  try {
    const mode = services.toolPermissions.getCurrentMode();
    return editsAllowOutsideWorkspace({ levels: effectiveLevels(mode) });
  } catch {
    return false;
  }
}

/** True when `child` is `parent` or inside it. Case-insensitive on Windows, as the file system is. */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return (
    rel === "" ||
    (rel !== ".." &&
      !rel.startsWith(`..${path.sep}`) &&
      !rel.startsWith("../") &&
      !path.isAbsolute(rel))
  );
}

/** The target resolved against the working directory. */
export function resolveWorkspacePath(
  filepath: string,
  cwd: string = process.cwd(),
): string {
  return path.resolve(cwd, filepath);
}

/**
 * A note for a write target that is outside the working directory and not
 * under the Continue home folder, or undefined when it is inside either.
 */
export function outsideWorkspaceNote(
  resolvedPath: string,
  cwd: string = process.cwd(),
  home: string | undefined = env.continueHome,
): string | undefined {
  if (isInside(cwd, resolvedPath)) return undefined;
  if (home && isInside(home, resolvedPath)) return undefined;
  return `Outside the working directory: ${resolvedPath} is not under ${cwd}.`;
}

/** The preview line that shows the note in an approval prompt. */
export function outsideWorkspacePreview(note: string): ToolCallPreview {
  return { type: "text", content: note, color: "yellow" };
}

/**
 * The line that ends a tool result when the write landed outside the working
 * directory, whatever the level that allowed it; empty when it did not.
 */
export function wroteOutsideResult(resolvedPath: string): string {
  return outsideWorkspaceNote(resolvedPath)
    ? `\n${wroteOutsideNote(resolvedPath)}`
    : "";
}

/**
 * Refuses the write in a headless run (nobody sees the preview) when the
 * target is outside the workspace, unless File edits is IDGAF; returns the
 * note otherwise so the preview can carry it. `toolName` names the tool in
 * the refusal.
 */
export function checkWorkspaceWrite(
  toolName: string,
  resolvedPath: string,
): string | undefined {
  const note = outsideWorkspaceNote(resolvedPath);
  if (note && services.toolPermissions.isHeadless() && !editsAreIdgaf()) {
    throw new ContinueError(
      ContinueErrorReason.FileWriteError,
      `${toolName} was not run: ${note} A headless run writes only inside the working directory (or under the Continuous home folder, ${env.continueHome}) unless File edits is set to IDGAF (--policy edits=idgaf or --auto). Use a path inside ${process.cwd()}.`,
    );
  }
  return note;
}
