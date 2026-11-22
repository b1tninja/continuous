import { describe, expect, it } from "vitest";

import { ContinueError, ContinueErrorReason } from "../util/errors";
import { isBlocked } from "../util/stuckSignals";

import {
  cancelledEditResult,
  editFailureCauseOf,
  editFailureResult,
  EditNotAppliedReason,
  type EditFailure,
  type EditFailureCause,
} from "./editFailure";
import {
  executeFindAndReplace,
  executeMultiFindAndReplace,
} from "./searchAndReplace/performReplace";

const FILE = "src/app.ts";

/** The error an edit raises, as the IDE receives it: a reason and a message. */
function raised(run: () => unknown): ContinueError {
  try {
    run();
  } catch (e) {
    if (e instanceof ContinueError) return e;
    throw e;
  }
  throw new Error("the edit did not fail");
}

function resultFor(tool: string, error: ContinueError): string {
  return editFailureResult({
    tool,
    file: FILE,
    cause: editFailureCauseOf(error.reason),
    detail: error.message,
  });
}

describe("editFailureResult: one fixture per cause", () => {
  it("the old text was not found", () => {
    const error = raised(() =>
      executeFindAndReplace("const a = 1;\n", "const b = 2;", "x", false),
    );
    const text = resultFor("single_find_and_replace", error);
    expect(text).toMatch(
      /^single_find_and_replace did not change src\/app\.ts: the old text was not found in the file\.\n/,
    );
    // Core's own detail (the closest region) is kept
    expect(text).toContain(error.message);
    expect(text).toMatch(
      /\nsrc\/app\.ts is unchanged\. Read src\/app\.ts again and retry with the exact current text\. Do not rewrite the whole file\.$/,
    );
  });

  it("the old text was found more than once", () => {
    const error = raised(() =>
      executeFindAndReplace("a = 1;\na = 1;\n", "a = 1;", "a = 2;", false),
    );
    const text = resultFor("single_find_and_replace", error);
    expect(text).toMatch(
      /^single_find_and_replace did not change src\/app\.ts: the old text was found more than once\.\n/,
    );
    expect(text).toContain("appears 2 times in the file");
    expect(text).toMatch(
      /\nsrc\/app\.ts is unchanged\. Retry with more surrounding lines in old_string, or with replace_all set to true\. Do not rewrite the whole file\.$/,
    );
  });

  it("a multi_edit says no edit was written, also the ones that matched", () => {
    const error = raised(() =>
      executeMultiFindAndReplace("one\ntwo\n", [
        { old_string: "one", new_string: "1" },
        { old_string: "three", new_string: "3" },
      ]),
    );
    const text = resultFor("multi_edit", error);
    expect(text).toContain("Edit at index 1");
    expect(text).toContain(
      "src/app.ts is unchanged: multi_edit writes all of its edits or none.",
    );
  });

  it("the file changed since it was read", () => {
    expect(
      editFailureResult({
        tool: "edit_existing_file",
        file: FILE,
        cause: "apply-failed",
        notApplied: EditNotAppliedReason.FileChanged,
      }),
    ).toBe(
      "edit_existing_file did not change src/app.ts: the file changed since it was read (it was typed in, or changed on disk). Nothing from this call was written. Read src/app.ts again and retry with the exact current text. Do not rewrite the whole file.",
    );
  });

  it("the file does not exist", () => {
    expect(
      editFailureResult({
        tool: "multi_edit",
        file: FILE,
        cause: editFailureCauseOf(ContinueErrorReason.FileNotFound),
        detail: "File src/app.ts does not exist",
      }),
    ).toBe(
      "multi_edit did not change src/app.ts: the file does not exist. Nothing was written. Check the path and retry with a file that exists.",
    );
  });

  it("the person rejected the apply", () => {
    expect(
      cancelledEditResult("single_find_and_replace", { filepath: FILE }),
    ).toBe(
      "The person rejected this single_find_and_replace edit of src/app.ts. src/app.ts is unchanged. Do not send the same edit again.",
    );
    // Only the edit tools: any other cancelled call keeps its own text
    expect(cancelledEditResult("run_terminal_command", {})).toBeUndefined();
  });

  it("the apply step failed, with its message", () => {
    expect(
      editFailureResult({
        tool: "edit_existing_file",
        file: FILE,
        cause: "apply-failed",
        detail: "Connection refused",
      }),
    ).toBe(
      "edit_existing_file did not change src/app.ts: the apply step failed.\nConnection refused.\nRead src/app.ts to see what it holds now, then send the edit again once. Do not rewrite the whole file.",
    );
  });

  it("the apply step failed for a reason the IDE named", () => {
    expect(
      editFailureResult({
        tool: "edit_existing_file",
        file: FILE,
        cause: "apply-failed",
        notApplied: EditNotAppliedReason.NoDiffView,
      }),
    ).toBe(
      "edit_existing_file did not change src/app.ts: the apply step failed. The edit could not be shown as a diff. Nothing was written. Send the edit again once. Do not rewrite the whole file.",
    );
    // No model to apply with: a retry meets the same failure
    expect(
      editFailureResult({
        tool: "edit_existing_file",
        file: FILE,
        cause: "apply-failed",
        notApplied: EditNotAppliedReason.NoApplyModel,
      }),
    ).toMatch(/Nothing was written\. Do not send this call again\./);
  });

  it("the arguments are not a valid edit", () => {
    expect(
      editFailureResult({
        tool: "single_find_and_replace",
        file: FILE,
        cause: editFailureCauseOf(
          ContinueErrorReason.FindAndReplaceIdenticalOldAndNewStrings,
        ),
        detail: "old_string and new_string must be different",
      }),
    ).toBe(
      "single_find_and_replace did not change src/app.ts: the arguments are not a valid edit.\nold_string and new_string must be different.\nsrc/app.ts is unchanged. Correct the arguments and send the call again.",
    );
  });

  it("any other error before the apply gives its message and says the file is unchanged", () => {
    expect(
      editFailureResult({
        tool: "multi_edit",
        cause: editFailureCauseOf(ContinueErrorReason.Unknown),
        detail: "EACCES: permission denied, open 'x'",
      }),
    ).toBe(
      "multi_edit did not change the file.\nEACCES: permission denied, open 'x'.\nThe file is unchanged: multi_edit writes all of its edits or none.",
    );
  });
});

describe("every edit failure result", () => {
  const causes: EditFailureCause[] = [
    "not-found",
    "not-unique",
    "file-changed",
    "file-missing",
    "rejected",
    "invalid-arguments",
    "apply-failed",
    "other",
  ];
  const failures: EditFailure[] = [
    ...causes.flatMap((cause) => [
      { tool: "multi_edit", file: FILE, cause, detail: "the detail" },
      { tool: "edit_existing_file", cause },
    ]),
    ...Object.values(EditNotAppliedReason).map((notApplied) => ({
      tool: "edit_existing_file",
      file: FILE,
      cause: "apply-failed" as const,
      notApplied,
    })),
  ];

  it.each(failures)("$tool $cause $notApplied", (failure) => {
    const text = editFailureResult(failure);
    expect(text).toContain(failure.tool);
    expect(text).toContain(failure.file ?? "the file");
    // Says a cause, never the bare line
    expect(text).not.toMatch(/^Failed to edit/);
    expect(text.length).toBeGreaterThan(`Failed to edit ${FILE}`.length);
    // The wording rules
    expect(text).not.toMatch(/please|sorry|!/i);
    // Not a refusal: the stuck detector must not count it as one
    expect(isBlocked({ tool: failure.tool, result: text, error: true })).toBe(
      false,
    );
  });
});
