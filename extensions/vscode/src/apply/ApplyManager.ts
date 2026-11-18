import { ApplyToFilePayload } from "core";
import { ConfigHandler } from "core/config/ConfigHandler";
import { myersDiff } from "core/diff/myers";
import { generateLines } from "core/diff/util";
import { ApplyAbortManager } from "core/edit/applyAbortManager";
import { applyCodeBlock } from "core/edit/lazy/applyCodeBlock";
import { streamDiffLines } from "core/edit/streamDiffLines";
import { pruneLinesFromBottom, pruneLinesFromTop } from "core/llm/countTokens";
import { getMarkdownLanguageTagForFile } from "core/util";
import { getUriPathBasename } from "core/util/uri";
import * as vscode from "vscode";

import { VerticalDiffManager } from "../diff/vertical/manager";
import { VsCodeIde } from "../VsCodeIde";
import { VsCodeWebviewProtocol } from "../webviewProtocol";

import {
  documentChanged,
  editorMatchesFilepath,
  type DocumentStamp,
} from "./applyTarget";
import { assembleAppliedContent } from "./assembleAppliedContent";
import { EditNotAppliedError, EditNotAppliedReason } from "./editNotApplied";
import {
  pendingEditorForFilepath,
  pendingFilepathForEditor,
  trackPendingNewFile,
} from "./pendingNewFile";

/**
 * Handles applying text/code to files including diff generation and streaming
 */
export class ApplyManager {
  constructor(
    private readonly ide: VsCodeIde,
    private readonly webviewProtocol: VsCodeWebviewProtocol,
    private readonly verticalDiffManager: VerticalDiffManager,
    private readonly configHandler: ConfigHandler,
  ) {}

  async applyToFile({
    streamId,
    filepath,
    text,
    toolCallId,
    isSearchAndReplace,
  }: ApplyToFilePayload) {
    if (filepath) {
      await this.ensureFileOpen(filepath);
    }

    // Resolve the document once. A later read of activeTextEditor can be a
    // different tab if the person switches during an await.
    const editor = this.editorFor(filepath);
    if (!editor) {
      void vscode.window.showErrorMessage("No active editor to apply edits to");
      throw new EditNotAppliedError(EditNotAppliedReason.NoEditor);
    }
    const stamp: DocumentStamp = {
      uri: editor.document.uri.toString(),
      version: editor.document.version,
    };

    // Capture the original file content before applying changes
    const originalFileContent = editor.document.getText();

    await this.webviewProtocol.request("updateApplyState", {
      streamId,
      status: "streaming",
      fileContent: text,
      originalFileContent,
      toolCallId,
    });

    this.throwIfStale(editor, stamp);

    const hasExistingDocument = !!originalFileContent.trim();
    const isNewFile = pendingFilepathForEditor(stamp.uri) !== undefined;
    if (!hasExistingDocument && !isNewFile) {
      await this.handleEmptyDocument(editor, text, streamId, toolCallId);
    } else if (isSearchAndReplace || isNewFile) {
      // A new file is edited in an untitled document and written only if
      // the person accepts. Search-and-replace is a full-file rewrite.
      await this.verticalDiffManager.instantApplyDiff(
        originalFileContent,
        text,
        streamId,
        toolCallId,
        editor,
        stamp.version,
        isNewFile ? filepath : undefined,
      );
    } else {
      await this.handleExistingDocument(
        editor,
        text,
        streamId,
        toolCallId,
        stamp,
      );
    }
  }

  /** The editor for `filepath`, or the active editor when no path was given. */
  private editorFor(
    filepath: string | undefined,
  ): vscode.TextEditor | undefined {
    if (!filepath) {
      return vscode.window.activeTextEditor;
    }
    const pendingUri = pendingEditorForFilepath(filepath);
    return vscode.window.visibleTextEditors.find((editor) => {
      const uri = editor.document.uri.toString();
      if (pendingUri && uri === pendingUri) {
        return true;
      }
      return editorMatchesFilepath(
        { uri, fsPath: editor.document.uri.fsPath },
        filepath,
      );
    });
  }

  /**
   * Throws when the document was edited after `stamp`. Tells the person, and
   * the error ends the edit's tool call (see editNotApplied.ts): a quiet
   * return left it running forever.
   */
  private throwIfStale(editor: vscode.TextEditor, stamp: DocumentStamp): void {
    if (
      !documentChanged(stamp, {
        uri: editor.document.uri.toString(),
        version: editor.document.version,
      })
    ) {
      return;
    }
    void vscode.window.showErrorMessage(
      "The file changed before the edit could be applied.",
    );
    throw new EditNotAppliedError(EditNotAppliedReason.FileChanged);
  }

  /**
   * Opens the file to edit without moving keyboard focus: the person may be
   * typing in the chat, and focus in the editor put their keystrokes into
   * the file, which then failed the edit's version check.
   */
  private async ensureFileOpen(filepath: string): Promise<void> {
    const fileExists = await this.ide.fileExists(filepath);
    if (!fileExists) {
      // Do not create an empty file on disk before the edit is accepted.
      const doc = await vscode.workspace.openTextDocument({ content: "" });
      await vscode.window.showTextDocument(doc, {
        preview: false,
        preserveFocus: true,
      });
      trackPendingNewFile(doc.uri.toString(), filepath);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.parse(filepath),
    );
    await vscode.window.showTextDocument(doc, {
      preview: false,
      preserveFocus: true,
    });
  }

  private modelIsTooFastForStreaming(model: string): boolean {
    return [/mercury/].some((r) => r.test(model));
  }

  private async handleEmptyDocument(
    editor: vscode.TextEditor,
    text: string,
    streamId: string,
    toolCallId?: string,
  ) {
    await editor.edit((builder) =>
      builder.insert(new vscode.Position(0, 0), text),
    );

    await this.webviewProtocol.request("updateApplyState", {
      streamId,
      status: "closed",
      numDiffs: 0,
      fileContent: text,
      toolCallId,
    });
  }

  private async handleExistingDocument(
    editor: vscode.TextEditor,
    text: string,
    streamId: string,
    toolCallId: string | undefined,
    stamp: DocumentStamp,
  ) {
    const { config } = await this.configHandler.loadConfig();
    if (!config) {
      void vscode.window.showErrorMessage("Config not loaded");
      throw new EditNotAppliedError(EditNotAppliedReason.NoApplyModel);
    }
    this.throwIfStale(editor, stamp);

    const llm =
      config.selectedModelByRole.apply ?? config.selectedModelByRole.chat;
    if (!llm) {
      void vscode.window.showErrorMessage(
        `No model with roles "apply" or "chat" found in config.`,
      );
      throw new EditNotAppliedError(EditNotAppliedReason.NoApplyModel);
    }

    const fileUri = editor.document.uri.toString();
    const abortManager = ApplyAbortManager.getInstance();
    const abortController = abortManager.get(fileUri);

    const { isInstantApply, diffLinesGenerator } = await applyCodeBlock(
      editor.document.getText(),
      text,
      getUriPathBasename(fileUri),
      llm,
      abortController,
    );

    if (isInstantApply) {
      await this.verticalDiffManager.streamDiffLines(
        diffLinesGenerator,
        isInstantApply,
        streamId,
        toolCallId,
      );
    } else {
      await this.handleNonInstantDiff(
        editor,
        text,
        llm,
        streamId,
        this.verticalDiffManager,
        toolCallId,
        !this.modelIsTooFastForStreaming(llm.model),
        stamp,
      );
    }
  }

  /**
   * Creates a prompt for applying code edits
   */
  private getApplyPrompt(text: string): string {
    return `The following code was suggested as an edit:\n\`\`\`\n${text}\n\`\`\`\nPlease apply it to the previous code. Leave existing comments in place unless changes require modifying them.`;
  }

  /**
   * Calculates prefix and suffix for a given range, shared between streaming and non-streaming modes
   */
  private calculatePrefixSuffix(
    editor: vscode.TextEditor,
    range: vscode.Range,
    llm: any,
  ): {
    prefix: string;
    suffix: string;
    rangeContent: string;
    fullPrefix: string;
    fullSuffix: string;
  } {
    const rangeContent = editor.document.getText(range);
    const fullPrefix = editor.document.getText(
      new vscode.Range(new vscode.Position(0, 0), range.start),
    );
    const fullSuffix = editor.document.getText(
      new vscode.Range(
        range.end,
        new vscode.Position(editor.document.lineCount, 0),
      ),
    );

    // The prompt only needs the lines nearest the selection. The file is
    // rebuilt from fullPrefix and fullSuffix, or the omitted lines show up
    // as deletions.
    const prefix = pruneLinesFromTop(
      fullPrefix,
      llm.contextLength / 4,
      llm.model,
    );
    const suffix = pruneLinesFromBottom(
      fullSuffix,
      llm.contextLength / 4,
      llm.model,
    );

    return { prefix, suffix, rangeContent, fullPrefix, fullSuffix };
  }

  private async handleNonInstantDiff(
    editor: vscode.TextEditor,
    text: string,
    llm: any,
    streamId: string,
    verticalDiffManager: VerticalDiffManager,
    toolCallId?: string,
    streaming: boolean = true,
    stamp?: DocumentStamp,
  ) {
    const { config } = await this.configHandler.loadConfig();
    if (!config) {
      void vscode.window.showErrorMessage("Config not loaded");
      throw new EditNotAppliedError(EditNotAppliedReason.NoApplyModel);
    }

    const prompt = this.getApplyPrompt(text);
    const fullEditorRange = new vscode.Range(
      0,
      0,
      editor.document.lineCount - 1,
      editor.document.lineAt(editor.document.lineCount - 1).text.length,
    );
    const rangeToApplyTo = editor.selection.isEmpty
      ? fullEditorRange
      : editor.selection;

    if (streaming) {
      await verticalDiffManager.streamEdit({
        input: prompt,
        llm,
        streamId,
        range: rangeToApplyTo,
        newCode: text,
        toolCallId,
        rulesToInclude: undefined, // No rules for apply
        isApply: true,
        editor,
        documentVersion: stamp?.version,
      });
    } else {
      // Non-streaming: accumulate LLM output, then apply via Myers diff
      const finalContent = await this.generateAppliedContent(
        editor,
        prompt,
        llm,
        rangeToApplyTo,
        text,
      );

      if (finalContent) {
        if (stamp) this.throwIfStale(editor, stamp);
        const diffLinesGenerator = generateLines(
          myersDiff(editor.document.getText(), finalContent),
        );

        await verticalDiffManager.streamDiffLines(
          diffLinesGenerator,
          true, // Apply instantly since we accumulated all content
          streamId,
          toolCallId,
          editor,
          stamp?.version,
        );
      }
    }
  }

  /**
   * Generates the final applied content by accumulating all LLM output
   * Similar to streamEdit but collects all output before applying
   */
  private async generateAppliedContent(
    editor: vscode.TextEditor,
    prompt: string,
    llm: any,
    range: vscode.Range,
    newCode: string,
  ): Promise<string | undefined> {
    const fileUri = editor.document.uri.toString();
    const { prefix, suffix, rangeContent, fullPrefix, fullSuffix } =
      this.calculatePrefixSuffix(editor, range, llm);

    const abortManager = ApplyAbortManager.getInstance();
    const abortController = abortManager.get(fileUri);

    try {
      const streamedLines: string[] = [];

      // Use streamDiffLines to get the LLM output
      const stream = streamDiffLines(
        {
          highlighted: rangeContent,
          prefix,
          suffix,
          input: prompt,
          language: getMarkdownLanguageTagForFile(fileUri),
          type: "apply",
          newCode,
          includeRulesInSystemMessage: false,
          modelTitle: llm.title ?? llm.model,
        },
        llm,
        abortController,
        undefined,
        undefined,
      );

      // Accumulate all the streamed content
      for await (const line of stream) {
        if (abortController.signal.aborted) {
          return undefined;
        }
        if (line.type === "new" || line.type === "same") {
          streamedLines.push(line.line);
        }
      }

      // The model saw the pruned prefix and suffix. The file keeps the
      // unpruned head and tail so those lines are not deleted.
      return assembleAppliedContent(fullPrefix, streamedLines, fullSuffix);
    } catch (error) {
      console.error("Error generating applied content:", error);
      return undefined;
    }
  }
}
