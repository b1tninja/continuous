import {
  resolveRelativePathInDir,
  uniqueOpenFileInWorkspace,
} from "core/util/ideUtils";
import { v4 as uuid } from "uuid";
import { allowOutsideWorkspaceOf } from "../outsideEdits";
import { applyForEditTool } from "../../redux/thunks/handleApplyStateUpdate";
import { ClientToolImpl } from "./callClientTool";

export const editToolImpl: ClientToolImpl = async (
  args,
  toolCallId,
  extras,
) => {
  if (!args.filepath || !args.changes) {
    throw new Error(
      "`filepath` and `changes` arguments are required to edit an existing file.",
    );
  }
  let filepath = args.filepath;
  if (filepath.startsWith("./")) {
    filepath = filepath.slice(2);
  }

  // File edits at IDGAF: a path outside the workspace is a target
  const allowOutside = allowOutsideWorkspaceOf(extras.getState?.());
  let firstUriMatch = await resolveRelativePathInDir(
    filepath,
    extras.ideMessenger.ide,
    undefined,
    { allowOutside },
  );

  if (!firstUriMatch) {
    firstUriMatch = await uniqueOpenFileInWorkspace(
      filepath,
      extras.ideMessenger.ide,
    );
  }

  if (!firstUriMatch) {
    throw new Error(`${filepath} does not exist`);
  }
  const streamId = uuid();
  void extras.dispatch(
    applyForEditTool({
      streamId,
      text: args.changes,
      toolCallId,
      filepath: firstUriMatch,
    }),
  );

  return {
    respondImmediately: false,
    output: undefined, // no immediate output - output for edit tools should be added based on apply state coming in
  };
};
