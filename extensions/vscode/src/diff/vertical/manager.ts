import { ChatMessage, DiffLine, IDE, ILLM, RuleWithSource } from "core";
import { myersDiff } from "core/diff/myers";
import { ApplyAbortManager } from "core/edit/applyAbortManager";
import { EDIT_MODE_STREAM_ID } from "core/edit/constants";
import { streamDiffLines } from "core/edit/streamDiffLines";
import { pruneLinesFromBottom, pruneLinesFromTop } from "core/llm/countTokens";
import { getMarkdownLanguageTagForFile } from "core/util";
import { stripImages } from "core/util/messageContent";
import { getLastNPathParts } from "core/util/uri";
import * as URI from "uri-js";
import * as vscode from "vscode";

import { documentChanged } from "../../apply/applyTarget";
import {
  EditNotAppliedError,
  EditNotAppliedReason,
} from "../../apply/editNotApplied";
import { isFastApplyModel } from "../../apply/utils";
import { editOutcomeTracker } from "../../extension/EditOutcomeTracker";
import EditDecorationManager from "../../quickEdit/EditDecorationManager";
import { handleLLMError } from "../../util/errorHandling";
import { VsCodeWebviewProtocol } from "../../webviewProtocol";

import { VerticalDiffHandler, VerticalDiffHandlerOptions } from "./handler";
import { getFirstChangedLine } from "./util";

export interface VerticalDiffCodeLens {
  start: number;
  numRed: number;
  numGreen: number;
}

export class VerticalDiffManager {
  public refreshCodeLens: () => void = () => {};

  private fileUriToHandler: Map<string, VerticalDiffHandler> = new Map();
  fileUriToCodeLens: Map<string, VerticalDiffCodeLens[]> = new Map();

  private userChangeListener: vscode.Disposable | undefined;

  logDiffs: DiffLine[] | undefined;

  constructor(
    private readonly webviewProtocol: VsCodeWebviewProtocol,
    private readonly editDecorationManager: EditDecorationManager,
    private readonly ide: IDE,
  ) {
    this.userChangeListener = undefined;
  }

  createVerticalDiffHandler(
    fileUri: string,
    startLine: number,
    endLine: number,
    options: VerticalDiffHandlerOptions,
    editor?: vscode.TextEditor,
  ): VerticalDiffHandler | undefined {
    if (this.fileUriToHandler.has(fileUri)) {
      this.fileUriToHandler.get(fileUri)?.clear(false);
      this.fileUriToHandler.delete(fileUri);
    }
    const candidate =
      editor && URI.equal(editor.document.uri.toString(), fileUri)
        ? editor
        : vscode.window.activeTextEditor;
    if (candidate && URI.equal(candidate.document.uri.toString(), fileUri)) {
      const handler = new VerticalDiffHandler(
        startLine,
        endLine,
        candidate,
        this.fileUriToCodeLens,
        this.clearForfileUri.bind(this),
        this.refreshCodeLens,
        options,
      );
      this.fileUriToHandler.set(fileUri, handler);
      return handler;
    } else {
      return undefined;
    }
  }

  getHandlerForFile(fileUri: string) {
    return this.fileUriToHandler.get(fileUri);
  }

  getStreamIdForFile(fileUri: string): string | undefined {
    return this.fileUriToHandler.get(fileUri)?.streamId;
  }

  // Creates a listener for document changes by user.
  private enableDocumentChangeListener(): vscode.Disposable | undefined {
    if (this.userChangeListener) {
      //Only create one listener per file
      return;
    }

    this.userChangeListener = vscode.workspace.onDidChangeTextDocument(
      (event) => {
        // Check if there is an active handler for the affected file
        const fileUri = event.document.uri.toString();
        const handler = this.getHandlerForFile(fileUri);
        if (handler) {
          // If there is an active diff for that file, handle the document change
          this.handleDocumentChange(event, handler);
        }
      },
    );
  }

  // Listener for user doc changes is disabled during updates to the text document by continue
  public disableDocumentChangeListener() {
    if (this.userChangeListener) {
      this.userChangeListener.dispose();
      this.userChangeListener = undefined;
    }
  }

  private handleDocumentChange(
    event: vscode.TextDocumentChangeEvent,
    handler: VerticalDiffHandler,
  ) {
    // Loop through each change in the event
    event.contentChanges.forEach((change) => {
      // Calculate the number of lines added or removed
      const linesAdded = change.text.split("\n").length - 1;
      const linesDeleted = change.range.end.line - change.range.start.line;
      const lineDelta = linesAdded - linesDeleted;

      // Update the diff handler with the new line delta
      handler.updateLineDelta(
        event.document.uri.toString(),
        change.range.start.line,
        lineDelta,
      );
    });
  }

  /** Same as clearForfileUri, but waits until the editor edits have finished. */
  async finishDiff(fileUri: string, accept: boolean): Promise<void> {
    const handler = this.fileUriToHandler.get(fileUri);
    if (handler) {
      await handler.clear(accept);
      this.fileUriToHandler.delete(fileUri);
    }
    this.disableDocumentChangeListener();
    void vscode.commands.executeCommand(
      "setContext",
      "continuous.diffVisible",
      false,
    );
    void this.webviewProtocol.request(
      "focusContinueInputWithoutClear",
      undefined,
    );
  }

  clearForfileUri(fileUri: string | undefined, accept: boolean) {
    if (!fileUri) {
      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor) {
        return;
      }
      fileUri = activeEditor.document.uri.toString();
    }

    const handler = this.fileUriToHandler.get(fileUri);
    if (handler) {
      handler.clear(accept);
      this.fileUriToHandler.delete(fileUri);
    }

    this.disableDocumentChangeListener();

    void vscode.commands.executeCommand(
      "setContext",
      "continuous.diffVisible",
      false,
    );

    void this.webviewProtocol.request(
      "focusContinueInputWithoutClear",
      undefined,
    );
  }

  async acceptRejectVerticalDiffBlock(
    accept: boolean,
    fileUri?: string,
    index?: number,
  ) {
    if (!fileUri) {
      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor) {
        return;
      }
      fileUri = activeEditor.document.uri.toString();
    }

    if (typeof index === "undefined") {
      index = 0;
    }

    const blocks = this.fileUriToCodeLens.get(fileUri);
    const block = blocks?.[index];
    if (!blocks || !block) {
      return;
    }

    const handler = this.getHandlerForFile(fileUri);
    if (!handler) {
      return;
    }

    // Disable listening to file changes while continue makes changes
    this.disableDocumentChangeListener();

    // CodeLens object removed from editorToVerticalDiffCodeLens here
    await handler.acceptRejectBlock(
      accept,
      block.start,
      block.numGreen,
      block.numRed,
    );

    if (blocks.length === 1) {
      this.clearForfileUri(fileUri, true);
    } else {
      // Re-enable listener for user changes to file
      this.enableDocumentChangeListener();
    }

    this.refreshCodeLens();
  }

  async streamDiffLines(
    diffStream: AsyncGenerator<DiffLine>,
    instant: boolean,
    streamId: string,
    toolCallId?: string,
    editor?: vscode.TextEditor,
    documentVersion?: number,
  ) {
    vscode.commands.executeCommand(
      "setContext",
      "continuous.diffVisible",
      true,
    );

    // Use the editor the apply resolved. Falling back to whichever tab is
    // active now puts the diff in the wrong file after a tab switch.
    let target = editor ?? vscode.window.activeTextEditor;
    if (!target) {
      throw new EditNotAppliedError(EditNotAppliedReason.NoEditor);
    }
    const fileUri = target.document.uri.toString();
    const startLine = 0;
    const endLine = target.document.lineCount - 1;

    // Check for existing handlers in the same file the new one will be created in
    const existingHandler = this.getHandlerForFile(fileUri);
    if (existingHandler) {
      existingHandler.clear(false);
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });

    this.throwIfStale(target, documentVersion);
    if (!editor) {
      target = vscode.window.activeTextEditor ?? target;
    }

    // Create new handler with determined start/end
    const diffHandler = this.createVerticalDiffHandler(
      fileUri,
      startLine,
      endLine,
      {
        instant,
        onStatusUpdate: (status, numDiffs, fileContent) =>
          void this.webviewProtocol.request("updateApplyState", {
            streamId,
            status,
            numDiffs,
            fileContent,
            filepath: fileUri,
            toolCallId,
          }),
        streamId,
      },
      target,
    );

    if (!diffHandler) {
      console.warn("Issue occurred while creating new vertical diff handler");
      throw new EditNotAppliedError(EditNotAppliedReason.NoDiffView);
    }

    if (target.selection) {
      // Unselect the range
      target.selection = new vscode.Selection(
        target.selection.active,
        target.selection.active,
      );
    }

    vscode.commands.executeCommand(
      "setContext",
      "continuous.streamingDiff",
      true,
    );

    try {
      this.logDiffs = await diffHandler.run(diffStream);

      // enable a listener for user edits to file while diff is open
      this.enableDocumentChangeListener();
    } catch (e) {
      this.disableDocumentChangeListener();
      const handled = await handleLLMError(e);
      if (!handled) {
        let message = "Error streaming diffs";
        if (e instanceof Error) {
          message += `: ${e.message}`;
        }
        throw new Error(message);
      }
    } finally {
      vscode.commands.executeCommand(
        "setContext",
        "continuous.streamingDiff",
        false,
      );
    }
  }

  async instantApplyDiff(
    oldContent: string,
    newContent: string,
    streamId: string,
    toolCallId?: string,
    editor?: vscode.TextEditor,
    documentVersion?: number,
    /** Path to report when the editor is an untitled stand-in for a new file. */
    reportedFilepath?: string,
  ) {
    vscode.commands.executeCommand(
      "setContext",
      "continuous.diffVisible",
      true,
    );

    const target = editor ?? vscode.window.activeTextEditor;
    if (!target) {
      throw new EditNotAppliedError(EditNotAppliedReason.NoEditor);
    }
    this.throwIfStale(target, documentVersion);

    const fileUri = target.document.uri.toString();
    const filepath = reportedFilepath ?? fileUri;

    const myersDiffs = myersDiff(oldContent, newContent);

    const diffHandler = this.createVerticalDiffHandler(
      fileUri,
      0,
      target.document.lineCount - 1,
      {
        instant: true,
        expectedVersion: documentVersion,
        onStatusUpdate: (status, numDiffs, fileContent) =>
          void this.webviewProtocol.request("updateApplyState", {
            streamId,
            status,
            numDiffs,
            fileContent,
            filepath,
            toolCallId,
          }),
        streamId,
      },
      target,
    );

    if (!diffHandler) {
      console.warn("Issue occurred while creating vertical diff handler");
      throw new EditNotAppliedError(EditNotAppliedReason.NoDiffView);
    }

    // Undefined when the document changed between reading it and writing
    // the diff (someone typed in it): report it, so the tool call ends.
    const applied = await diffHandler.reapplyWithMyersDiff(myersDiffs);
    if (!applied) {
      throw new EditNotAppliedError(EditNotAppliedReason.FileChanged);
    }

    const scrollToLine = getFirstChangedLine(applied, 0) ?? 0;
    const range = new vscode.Range(scrollToLine, 0, scrollToLine, 0);
    target.revealRange(range, vscode.TextEditorRevealType.Default);

    this.enableDocumentChangeListener();

    await this.webviewProtocol.request("updateApplyState", {
      streamId,
      status: "done",
      numDiffs: this.fileUriToCodeLens.get(fileUri)?.length ?? 0,
      fileContent: target.document.getText(),
      filepath,
      toolCallId,
    });
  }

  async streamEdit({
    input,
    llm,
    streamId,
    quickEdit,
    range,
    newCode,
    toolCallId,
    rulesToInclude,
    isApply,
    editor: givenEditor,
    documentVersion,
  }: {
    input: string;
    llm: ILLM;
    streamId?: string;
    quickEdit?: string;
    range?: vscode.Range;
    newCode?: string;
    toolCallId?: string;
    rulesToInclude: undefined | RuleWithSource[];
    isApply: boolean;
    /** The document the apply resolved. Omit to use the active editor. */
    editor?: vscode.TextEditor;
    documentVersion?: number;
  }): Promise<string | undefined> {
    void vscode.commands.executeCommand(
      "setContext",
      "continuous.diffVisible",
      true,
    );

    let editor = givenEditor ?? vscode.window.activeTextEditor;

    if (!editor) {
      return undefined;
    }

    const fileUri = editor.document.uri.toString();

    let startLine, endLine: number;

    if (range) {
      startLine = range.start.line;
      endLine = range.end.line;
    } else {
      startLine = editor.selection.start.line;
      endLine = editor.selection.end.line;
    }

    // Check for existing handlers in the same file the new one will be created in
    const existingHandler = this.getHandlerForFile(fileUri);

    if (existingHandler) {
      if (quickEdit) {
        // Previous diff was a quickEdit
        // Check if user has highlighted a range
        let rangeBool =
          startLine !== endLine ||
          editor.selection.start.character !== editor.selection.end.character;

        // Check if the range is different from the previous range
        let newRangeBool =
          startLine !== existingHandler.range.start.line ||
          endLine !== existingHandler.range.end.line;

        if (!rangeBool || !newRangeBool) {
          // User did not highlight a new range -> use start/end from the previous quickEdit
          startLine = existingHandler.range.start.line;
          endLine = existingHandler.range.end.line;
        }
      }

      // Clear the previous handler
      // This allows the user to edit above the changed area,
      // but extra delta was added for each line generated by Continue
      // Before adding this back, we need to distinguish between human and Continue
      // let effectiveLineDelta =
      //   existingHandler.getLineDeltaBeforeLine(startLine);
      // startLine += effectiveLineDelta;
      // endLine += effectiveLineDelta;

      await existingHandler.clear(false);
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });

    this.throwIfStale(editor, documentVersion);
    if (!givenEditor) {
      editor = vscode.window.activeTextEditor ?? editor;
    }

    // Create new handler with determined start/end
    const diffHandler = this.createVerticalDiffHandler(
      fileUri,
      startLine,
      endLine,
      {
        instant: isFastApplyModel(llm),
        input,
        onStatusUpdate: (status, numDiffs, fileContent) =>
          streamId &&
          void this.webviewProtocol.request("updateApplyState", {
            streamId,
            status,
            numDiffs,
            fileContent,
            filepath: fileUri,
            toolCallId,
          }),
        streamId,
      },
      editor,
    );

    if (!diffHandler) {
      console.warn("Issue occurred while creating new vertical diff handler");
      throw new EditNotAppliedError(EditNotAppliedReason.NoDiffView);
    }

    let selectedRange = diffHandler.range;

    // Only if the selection is empty, use exact prefix/suffix instead of by line
    if (selectedRange.isEmpty) {
      selectedRange = new vscode.Range(
        editor.selection.start.with(undefined, 0),
        editor.selection.end.with(undefined, Number.MAX_SAFE_INTEGER),
      );
    }

    const rangeContent = editor.document.getText(selectedRange);
    const prefix = pruneLinesFromTop(
      editor.document.getText(
        new vscode.Range(new vscode.Position(0, 0), selectedRange.start),
      ),
      llm.contextLength / 4,
      llm.model,
    );
    const suffix = pruneLinesFromBottom(
      editor.document.getText(
        new vscode.Range(
          selectedRange.end,
          new vscode.Position(editor.document.lineCount, 0),
        ),
      ),
      llm.contextLength / 4,
      llm.model,
    );

    let overridePrompt: ChatMessage[] | undefined;
    if (llm.promptTemplates?.apply) {
      const filepath = getLastNPathParts(fileUri, 1);
      const rendered = llm.renderPromptTemplate(llm.promptTemplates.apply, [], {
        original_code: rangeContent,
        new_code: newCode ?? "",
        filepath,
      });
      overridePrompt =
        typeof rendered === "string"
          ? [{ role: "user", content: rendered }]
          : rendered;
    }

    if (editor.selection) {
      // Unselect the range
      editor.selection = new vscode.Selection(
        editor.selection.active,
        editor.selection.active,
      );
    }

    void vscode.commands.executeCommand(
      "setContext",
      "continuous.streamingDiff",
      true,
    );

    this.editDecorationManager.clear();

    const abortManager = ApplyAbortManager.getInstance();
    const abortController = abortManager.get(fileUri);

    try {
      const streamedLines: string[] = [];

      async function* recordedStream() {
        const stream = streamDiffLines(
          {
            highlighted: rangeContent,
            prefix,
            suffix,
            input,
            language: getMarkdownLanguageTagForFile(fileUri),
            type: isApply ? "apply" : "edit",
            newCode: newCode ?? "",
            includeRulesInSystemMessage: !!rulesToInclude && !isApply,
            modelTitle: llm.title ?? llm.model,
          },
          llm,
          abortController,
          overridePrompt,
          rulesToInclude,
        );

        for await (const line of stream) {
          if (line.type === "new" || line.type === "same") {
            streamedLines.push(line.line);
          }
          yield line;
        }
      }

      this.logDiffs = await diffHandler.run(recordedStream());

      // enable a listener for user edits to file while diff is open
      this.enableDocumentChangeListener();

      if (abortController.signal.aborted) {
        void vscode.commands.executeCommand("continuous.rejectDiff");
      }

      const fileAfterEdit = `${prefix}${streamedLines.join("\n")}${suffix}`;
      await this.trackEditInteraction({
        model: llm,
        filepath: fileUri,
        prompt: input,
        fileAfterEdit,
      });

      return fileAfterEdit;
    } catch (e) {
      this.disableDocumentChangeListener();
      const handled = await handleLLMError(e);
      if (!handled) {
        let message = "Error streaming edit diffs";
        if (e instanceof Error) {
          message += `: ${e.message}`;
        }
        throw new Error(message);
      }
    } finally {
      void vscode.commands.executeCommand(
        "setContext",
        "continuous.streamingDiff",
        false,
      );
    }
  }

  async trackEditInteraction({
    model,
    filepath,
    prompt,
    fileAfterEdit,
  }: {
    model: ILLM;
    filepath: string;
    prompt: string;
    fileAfterEdit: string | undefined;
  }) {
    // Get previous code content for outcome tracking
    const previousCode = await this.ide.readFile(filepath);
    const newCode = fileAfterEdit ?? "";
    const previousCodeLines = previousCode.split("\n").length;
    const newCodeLines = newCode.split("\n").length;
    const lineChange = newCodeLines - previousCodeLines;

    // Store pending edit data for outcome tracking
    editOutcomeTracker.trackEditInteraction({
      streamId: EDIT_MODE_STREAM_ID,
      timestamp: new Date().toISOString(),
      modelProvider: model.underlyingProviderName,
      modelName: model.title ?? "",
      modelTitle: model.title ?? "",
      prompt: stripImages(prompt),
      completion: newCode,
      previousCode,
      newCode,
      filepath: filepath,
      previousCodeLines,
      newCodeLines,
      lineChange,
    });
  }

  /**
   * Throws when the document was edited after the apply captured it. The
   * person sees why; the error ends the edit's tool call (see
   * apply/editNotApplied.ts).
   */
  private throwIfStale(
    editor: vscode.TextEditor,
    version: number | undefined,
  ): void {
    if (version === undefined) {
      return;
    }
    if (
      !documentChanged(
        { uri: editor.document.uri.toString(), version },
        {
          uri: editor.document.uri.toString(),
          version: editor.document.version,
        },
      )
    ) {
      return;
    }
    void vscode.window.showErrorMessage(
      "The file changed before the edit could be applied.",
    );
    throw new EditNotAppliedError(EditNotAppliedReason.FileChanged);
  }
}
