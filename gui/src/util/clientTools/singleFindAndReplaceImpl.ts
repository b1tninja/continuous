import { validateSingleEdit } from "core/edit/searchAndReplace/findAndReplaceUtils";
import { executeFindAndReplace } from "core/edit/searchAndReplace/performReplace";
import { validateSearchAndReplaceFilepath } from "core/edit/searchAndReplace/validateArgs";
import { v4 as uuid } from "uuid";
import { applyForEditTool } from "../../redux/thunks/handleApplyStateUpdate";
import { allowOutsideWorkspaceOf } from "../outsideEdits";
import { ClientToolImpl } from "./callClientTool";
import { withFileLockUntilClosed } from "./lockedEdit";

export const singleFindAndReplaceImpl: ClientToolImpl = async (
  args,
  toolCallId,
  extras,
) => {
  // Note that this is fully duplicate of what occurs in args preprocessing
  // This is to handle cases where file changes while tool call is pending
  const { oldString, newString, replaceAll } = validateSingleEdit(
    args.old_string,
    args.new_string,
    args.replace_all,
  );
  const fileUri = await validateSearchAndReplaceFilepath(
    args.filepath,
    extras.ideMessenger.ide,
    { allowOutside: allowOutsideWorkspaceOf(extras.getState?.()) },
  );

  // One edit at a time per file: read it only when the earlier edit is done
  await withFileLockUntilClosed(fileUri, toolCallId, extras, async () => {
    const editingFileContents = await extras.ideMessenger.ide.readFile(fileUri);
    const newFileContents = executeFindAndReplace(
      editingFileContents,
      oldString,
      newString,
      replaceAll ?? false,
      0,
    );

    // Apply the changes to the file
    const streamId = uuid();
    void extras.dispatch(
      applyForEditTool({
        streamId,
        toolCallId,
        text: newFileContents,
        filepath: fileUri,
        isSearchAndReplace: true,
      }),
    );
  });

  // Return success - applyToFile will handle the completion state
  return {
    respondImmediately: false, // Let apply state handle completion
    output: undefined,
  };
};
