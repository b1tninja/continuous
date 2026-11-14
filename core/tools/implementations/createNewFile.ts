import {
  absoluteLocalUri,
  inferResolvedUriFromRelativePath,
  isOutsideDirs,
} from "../../util/ideUtils";
import { outsideWriteNote } from "./outsideNote";

import { ToolImpl } from ".";
import { throwIfFileIsSecurityConcern } from "../../indexing/ignore";
import { ContinueError, ContinueErrorReason } from "../../util/errors";
import { getCleanUriPath, getUriPathBasename } from "../../util/uri";
import { getBooleanArg, getStringArg } from "../parseArgs";
import {
  newProblems,
  newProblemsItem,
  PROBLEMS_WAIT_MS,
} from "../problemsReport";

/**
 * An absolute path (or one whose drive colon is percent-encoded, `c%3A/...`)
 * that points outside every workspace folder, or undefined. Without the
 * outside-workspace option such a path used to be joined onto the first
 * folder as if it were relative, `C:/repo/c:/elsewhere/a.ts`, and the write
 * failed with "EINVAL: invalid argument, mkdir" (14 times in one week).
 */
export function outsideAbsolutePath(
  filepath: string,
  dirs: readonly string[],
): string | undefined {
  let text = filepath.trim();
  if (/^[a-zA-Z]%3A/i.test(text)) {
    try {
      text = decodeURIComponent(text);
    } catch {
      return undefined;
    }
  }
  const uri = absoluteLocalUri(text);
  return uri && dirs.length && isOutsideDirs(uri, dirs) ? uri : undefined;
}

export const createNewFileImpl: ToolImpl = async (args, extras) => {
  const filepath = getStringArg(args, "filepath");
  const contents = getStringArg(args, "contents", true);
  const append = getBooleanArg(args, "append") === true;

  if (!extras.allowOutsideWorkspace) {
    const dirs =
      extras.workspaceDirs ?? (await extras.ide.getWorkspaceDirs?.()) ?? [];
    if (outsideAbsolutePath(filepath, dirs)) {
      throw new ContinueError(
        ContinueErrorReason.PathResolutionFailed,
        `${filepath} is outside the workspace, and files outside it can't be written at this permission level. Use a path relative to the workspace, or ask the user to allow edits outside it.`,
      );
    }
  }

  const resolvedFileUri = await inferResolvedUriFromRelativePath(
    filepath,
    extras.ide,
    undefined,
    { allowOutside: extras.allowOutsideWorkspace },
  );
  if (resolvedFileUri) {
    throwIfFileIsSecurityConcern(getCleanUriPath(resolvedFileUri));
    const exists = await extras.ide.fileExists(resolvedFileUri);
    if (exists && !append) {
      throw new ContinueError(
        ContinueErrorReason.FileAlreadyExists,
        `File ${filepath} already exists. Use the edit tool to edit this file`,
      );
    }
    if (append && !exists) {
      throw new ContinueError(
        ContinueErrorReason.FileNotFound,
        `File ${filepath} does not exist yet. Create it first, without append.`,
      );
    }
    const before = append ? await extras.ide.readFile(resolvedFileUri) : "";
    await extras.ide.writeFile(resolvedFileUri, before + contents);
    await extras.ide.openFile(resolvedFileUri);
    await extras.ide.saveFile(resolvedFileUri);
    if (extras.codeBaseIndexer) {
      void extras.codeBaseIndexer?.refreshCodebaseIndexFiles([resolvedFileUri]);
    }
    // A new file has no earlier problems, so whatever is reported is new
    const problems = await extras.ide
      .waitForProblems?.(resolvedFileUri, PROBLEMS_WAIT_MS)
      .catch(() => []);
    const problemsItem = newProblemsItem(
      filepath,
      newProblems([], problems ?? []),
    );
    return [
      {
        name: getUriPathBasename(resolvedFileUri),
        description: getCleanUriPath(resolvedFileUri),
        content: [
          append ? "Added to the file" : "File created successfuly",
          await outsideWriteNote(extras, resolvedFileUri),
        ]
          .filter(Boolean)
          .join("\n"),
        uri: {
          type: "file",
          value: resolvedFileUri,
        },
      },
      ...(problemsItem ? [problemsItem] : []),
    ];
  } else {
    throw new ContinueError(
      ContinueErrorReason.PathResolutionFailed,
      "Failed to resolve path",
    );
  }
};
