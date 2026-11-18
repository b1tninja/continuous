import { IDE } from "../..";
import { ContinueError, ContinueErrorReason } from "../../util/errors";
import {
  resolveRelativePathInDir,
  type ResolveOptions,
} from "../../util/ideUtils";

export async function validateSearchAndReplaceFilepath(
  filepath: unknown,
  ide: IDE,
  options?: ResolveOptions,
) {
  if (!filepath || typeof filepath !== "string") {
    throw new ContinueError(
      ContinueErrorReason.FindAndReplaceMissingFilepath,
      "filepath (string) is required",
    );
  }
  const resolvedFilepath = await resolveRelativePathInDir(
    filepath,
    ide,
    undefined,
    options,
  );
  if (!resolvedFilepath) {
    throw new ContinueError(
      ContinueErrorReason.FileNotFound,
      `File ${filepath} does not exist`,
    );
  }
  return resolvedFilepath;
}
