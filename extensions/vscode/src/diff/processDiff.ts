import { Core } from "core/core";
import { DataLogger } from "core/data/log";
import { myersDiff } from "core/diff/myers";
import * as vscode from "vscode";

import {
  forgetPendingNewFile,
  pendingEditorForFilepath,
} from "../apply/pendingNewFile";
import { ContinueGUIWebviewViewProvider } from "../ContinueGUIWebviewViewProvider";
import { editOutcomeTracker } from "../extension/EditOutcomeTracker";
import { VsCodeIde } from "../VsCodeIde";

import { VerticalDiffManager } from "./vertical/manager";

/**
 * Closes the draft editor of a new file, without taking the keyboard and
 * without discarding anyone's work. The draft is shown without focus, so the
 * revert-and-close command has an editor to act on. That command reverts what
 * it closes, so it runs only when the active editor really is the draft: if
 * something else is active (the person switched tabs), the draft is left open
 * rather than reverting their file.
 */
async function closeDraft(doc: vscode.TextDocument): Promise<void> {
  await vscode.window.showTextDocument(doc, {
    preview: false,
    preserveFocus: true,
  });
  const active = vscode.window.activeTextEditor?.document;
  if (active?.uri.toString() !== doc.uri.toString()) return;
  await vscode.commands.executeCommand(
    "workbench.action.revertAndCloseActiveEditor",
  );
}

export async function processDiff(
  action: "accept" | "reject",
  sidebar: ContinueGUIWebviewViewProvider,
  ide: VsCodeIde,
  core: Core,
  verticalDiffManager: VerticalDiffManager,
  newFileUri?: string,
  streamId?: string,
  toolCallId?: string,
) {
  let newOrCurrentUri = newFileUri;
  if (!newOrCurrentUri) {
    const currentFile = await ide.getCurrentFile();
    newOrCurrentUri = currentFile?.path;
  }
  if (!newOrCurrentUri) {
    console.warn(
      `No file provided or current file open while attempting to resolve diff`,
    );
    return;
  }

  const pendingEditor = pendingEditorForFilepath(newOrCurrentUri);
  if (pendingEditor) {
    if (!streamId) {
      streamId = verticalDiffManager.getStreamIdForFile(pendingEditor);
    }
    const doc = vscode.workspace.textDocuments.find(
      (open) => open.uri.toString() === pendingEditor,
    );
    await verticalDiffManager.finishDiff(
      pendingEditor,
      action === "accept",
      action === "reject",
    );
    forgetPendingNewFile(newOrCurrentUri);
    if (action !== "accept") {
      if (doc) await closeDraft(doc);
      core.invoke("cancelApply", undefined);
      if (streamId) {
        await sidebar.webviewProtocol.request("updateApplyState", {
          fileContent: "",
          filepath: newOrCurrentUri,
          streamId,
          status: "closed",
          numDiffs: 0,
          toolCallId,
          rejected: true,
        });
      }
      return;
    }
    if (!doc) {
      void vscode.window.showErrorMessage(
        "The new file was closed before it could be saved.",
      );
      return;
    }
    const content = doc.getText();
    await ide.writeFile(newOrCurrentUri, content);
    await closeDraft(doc);
    await ide.openFile(newOrCurrentUri, { preserveFocus: true });
  } else {
    // An agent edit that finishes on its own passes through here too
    await ide.openFile(newOrCurrentUri, { preserveFocus: true });
  }

  // If streamId is not provided, try to get it from the VerticalDiffManager
  if (!streamId) {
    streamId = verticalDiffManager.getStreamIdForFile(newOrCurrentUri);
  }

  // Clear vertical diffs depending on action
  verticalDiffManager.clearForfileUri(
    newOrCurrentUri,
    action === "accept",
    action === "reject",
  );
  if (action === "reject") {
    // this is so that IDE reject diff command can also cancel apply
    core.invoke("cancelApply", undefined);
  }

  if (streamId) {
    // Capture file content before save to detect autoformatting
    const preSaveContent = await ide.readFile(newOrCurrentUri);

    // Record the edit outcome before updating the apply state
    await editOutcomeTracker.recordEditOutcome(
      streamId,
      action === "accept",
      DataLogger.getInstance(),
    );

    // Save the file
    await ide.saveFile(newOrCurrentUri);

    // Capture file content after save to detect autoformatting
    const postSaveContent = await ide.readFile(newOrCurrentUri);

    // Detect autoformatting by comparing normalized content
    let autoFormattingDiff: string | undefined;
    const normalizedPreSave = preSaveContent.trim();
    const normalizedPostSave = postSaveContent.trim();

    if (normalizedPreSave !== normalizedPostSave) {
      // Auto-formatting was applied by the editor
      const diffLines = myersDiff(preSaveContent, postSaveContent);
      autoFormattingDiff = diffLines
        .map((line) => {
          switch (line.type) {
            case "old":
              return `-${line.line}`;
            case "new":
              return `+${line.line}`;
            case "same":
              return ` ${line.line}`;
          }
        })
        .join("\n");
    }

    await sidebar.webviewProtocol.request("updateApplyState", {
      fileContent: postSaveContent, // Use post-save content
      filepath: newOrCurrentUri,
      streamId,
      status: "closed",
      numDiffs: 0,
      toolCallId,
      autoFormattingDiff, // Include autoformatting diff
      ...(action === "reject" ? { rejected: true } : {}),
    });
  } else {
    // Save the file even if no streamId
    await ide.saveFile(newOrCurrentUri);
  }
}
