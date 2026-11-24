import { NO_TOOL_CALL_OUTPUT_MESSAGE } from "./constants";

/**
 * What the model is told about a tool call that has no output because it never
 * finished, in place of "No tool output", which reads as a call that ran and
 * printed nothing. A call cut off while its arguments were still streaming
 * never ran; an edit that looked written then was not. The model should
 * check, not assume.
 */
export function unfinishedToolCallOutput(status: string | undefined): string {
  switch (status) {
    case "generating":
      return "This tool call was cut off while it was being written, so it did not run. Nothing was changed. Send it again if it is still needed.";
    case "generated":
      return "This tool call has not run: it was waiting for the person's approval. Nothing was changed.";
    case "calling":
      return "This tool call had not finished when this request was made, so its result is not known. Check before relying on it: read the file after an edit, or run the check again.";
    default:
      // "done" with nothing to show: a call that ran and printed nothing
      return NO_TOOL_CALL_OUTPUT_MESSAGE;
  }
}
