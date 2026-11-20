import { selectApplyStateByToolCallId } from "../../redux/selectors/selectToolCalls";
import { ClientToolExtras } from "./callClientTool";
import { acquireFileLock, releaseWhenClosed } from "./fileLock";

/**
 * Runs an edit's read-compute-apply under the file's lock, and keeps the lock
 * until the edit's diff has closed, so a second edit of the same file reads
 * the file as the first one left it. Never holds the lock after a throw.
 */
export async function withFileLockUntilClosed<T>(
  fileUri: string,
  toolCallId: string,
  extras: ClientToolExtras,
  run: () => Promise<T>,
): Promise<T> {
  const release = await acquireFileLock(fileUri);
  try {
    const result = await run();
    releaseWhenClosed(release, () => {
      try {
        return (
          selectApplyStateByToolCallId(extras.getState(), toolCallId)
            ?.status === "closed"
        );
      } catch {
        // No state to read: do not hold the file
        return true;
      }
    });
    return result;
  } catch (e) {
    release();
    throw e;
  }
}
