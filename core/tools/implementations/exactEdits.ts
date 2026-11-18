import type { ContextItem } from "../../index.js";
import { validateSingleEdit } from "../../edit/searchAndReplace/findAndReplaceUtils.js";
import { validateMultiEdit } from "../../edit/searchAndReplace/multiEditValidation.js";
import {
  executeFindAndReplace,
  executeMultiFindAndReplace,
} from "../../edit/searchAndReplace/performReplace.js";
import { validateSearchAndReplaceFilepath } from "../../edit/searchAndReplace/validateArgs.js";
import { ContinueError, ContinueErrorReason } from "../../util/errors.js";
import { getUriPathBasename } from "../../util/uri.js";
import { BuiltInToolNames } from "../builtIn.js";
import type { ToolImpl } from "./index.js";
import { outsideWriteNote } from "./outsideNote.js";

/**
 * The two exact edit tools (single_find_and_replace, multi_edit) applied in
 * core, without the client's diff review: for a call that runs in another
 * checkout (`ToolExtras.workspaceDirs`, a Loop worker's worktree), where the
 * merge of the worker's patch is the review. A call without a working
 * directory is refused: in the person's own checkout these edits belong to
 * the client, which shows them as a diff.
 */
function requireWorkspace(extras: Parameters<ToolImpl>[1], tool: string) {
  if (!extras.workspaceDirs?.length) {
    throw new ContinueError(
      ContinueErrorReason.Unspecified,
      `${tool} is applied through the editor's diff review in this checkout; core runs it only for a call with a working directory of its own.`,
    );
  }
}

function edited(fileUri: string, text: string, note?: string): ContextItem[] {
  return [
    {
      name: `Edited ${getUriPathBasename(fileUri)}`,
      description: fileUri,
      content: note ? `${text}\n${note}` : text,
    },
  ];
}

export const singleFindAndReplaceImpl: ToolImpl = async (args, extras) => {
  requireWorkspace(extras, BuiltInToolNames.SingleFindAndReplace);
  const { oldString, newString, replaceAll } = validateSingleEdit(
    args.old_string,
    args.new_string,
    args.replace_all,
  );
  const fileUri = await validateSearchAndReplaceFilepath(
    args.filepath,
    extras.ide,
    { allowOutside: extras.allowOutsideWorkspace },
  );
  const before = await extras.ide.readFile(fileUri);
  const after = executeFindAndReplace(
    before,
    oldString,
    newString,
    replaceAll ?? false,
    0,
  );
  await extras.ide.writeFile(fileUri, after);
  return edited(
    fileUri,
    `Replaced ${replaceAll ? "every occurrence" : "the text"} in ${args.filepath}.`,
    await outsideWriteNote(extras, fileUri),
  );
};

export const multiEditImpl: ToolImpl = async (args, extras) => {
  requireWorkspace(extras, BuiltInToolNames.MultiEdit);
  const { edits } = validateMultiEdit(args);
  const fileUri = await validateSearchAndReplaceFilepath(
    args.filepath,
    extras.ide,
    { allowOutside: extras.allowOutsideWorkspace },
  );
  const before = await extras.ide.readFile(fileUri);
  const after = executeMultiFindAndReplace(before, edits);
  await extras.ide.writeFile(fileUri, after);
  return edited(
    fileUri,
    `Applied ${edits.length} edit${edits.length === 1 ? "" : "s"} to ${args.filepath}.`,
    await outsideWriteNote(extras, fileUri),
  );
};
