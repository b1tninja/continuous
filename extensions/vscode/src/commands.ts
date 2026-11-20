/* eslint-disable @typescript-eslint/naming-convention */
import * as fs from "node:fs";

import { ContextMenuConfig, ILLM, ModelInstaller } from "core";
import { CompletionProvider } from "core/autocomplete/CompletionProvider";
import { ConfigHandler } from "core/config/ConfigHandler";
import { Core } from "core/core";
import { isModelInstaller } from "core/llm";
import { NextEditLoggingService } from "core/nextEdit/NextEditLoggingService";
import { EXTENSION_NAME } from "core/util/constants";
import { startLocalLemonade } from "core/util/lemonadeHelper";
import { startLocalOllama } from "core/util/ollamaHelper";
import {
  getConfigJsonPath,
  getConfigYamlPath,
  setConfigFilePermissions,
} from "core/util/paths";
import * as vscode from "vscode";
import * as YAML from "yaml";

import { convertJsonToYamlConfig } from "../../../packages/config-yaml/dist";

import {
  getAutocompleteStatusBarDescription,
  getAutocompleteStatusBarTitle,
  getNextEditMenuItems,
  getStatusBarStatus,
  getStatusBarStatusFromQuickPickItemLabel,
  handleNextEditToggle,
  isNextEditToggleLabel,
  quickPickStatusText,
  setupStatusBar,
  StatusBarStatus,
} from "./autocomplete/statusBar";
import { ContinueConsoleWebviewViewProvider } from "./ContinueConsoleWebviewViewProvider";
import { ContinueGUIWebviewViewProvider } from "./ContinueGUIWebviewViewProvider";
import { processDiff } from "./diff/processDiff";
import { VerticalDiffManager } from "./diff/vertical/manager";
import { paletteCommands } from "./paletteCommands";
import EditDecorationManager from "./quickEdit/EditDecorationManager";
import { QuickEdit, QuickEditShowParams } from "./quickEdit/QuickEditQuickPick";
import {
  addCodeToContextFromRange,
  addHighlightedCodeToContext,
  getRangeInFileWithContents,
} from "./util/addCode";
import {
  AddToChatHost,
  buildAddToChatPayload,
  uriOfTabInput,
  urisFromCommandArgs,
} from "./util/addToChat";
import { Battery } from "./util/battery";
import { getMetaKeyLabel } from "./util/util";
import { openEditorAndRevealRange } from "./util/vscode";
import { VsCodeIde } from "./VsCodeIde";

let fullScreenPanel: vscode.WebviewPanel | undefined;

function getFullScreenTab() {
  const tabs = vscode.window.tabGroups.all.flatMap((tabGroup) => tabGroup.tabs);
  return tabs.find((tab) =>
    (tab.input as any)?.viewType?.endsWith("continuous.continueGUIView"),
  );
}

export function focusGUI() {
  const fullScreenTab = getFullScreenTab();
  if (fullScreenTab) {
    // focus fullscreen
    fullScreenPanel?.reveal();
  } else {
    // focus sidebar
    vscode.commands.executeCommand("continuous.continueGUIView.focus");
    // vscode.commands.executeCommand("workbench.action.focusAuxiliaryBar");
  }
}

function hideGUI() {
  const fullScreenTab = getFullScreenTab();
  if (fullScreenTab) {
    // focus fullscreen
    fullScreenPanel?.dispose();
  } else {
    // focus sidebar
    vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
    // vscode.commands.executeCommand("workbench.action.toggleAuxiliaryBar");
  }
}

export function waitForSidebarReady(
  sidebar: ContinueGUIWebviewViewProvider,
  timeout: number,
  interval: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const startTime = Date.now();

    const checkReadyState = () => {
      if (sidebar.isReady) {
        resolve(true);
      } else if (Date.now() - startTime >= timeout) {
        resolve(false); // Timed out
      } else {
        setTimeout(checkReadyState, interval);
      }
    };

    checkReadyState();
  });
}

const vscodeAddToChatHost: AddToChatHost = {
  workspaceDirs: () =>
    (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.toString()),
  stat: async (uri) => {
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.parse(uri));
      return stat.type & vscode.FileType.Directory ? "folder" : "file";
    } catch {
      return undefined;
    }
  },
};

/**
 * Sends files and folders to the chat input as `@file` and `@folder` chips
 * through the `addToChat` message, opening the chat view first if it is
 * closed. The webview inserts the chips, skips duplicates, focuses the input
 * and announces the result.
 */
async function addResourcesToChat(
  uris: vscode.Uri[],
  sidebar: ContinueGUIWebviewViewProvider,
) {
  const payload = await buildAddToChatPayload(
    uris.map((uri) => uri.toString()),
    vscodeAddToChatHost,
  );
  if (payload.data.length === 0 && !payload.refused?.length) {
    void vscode.window.showInformationMessage(
      "There is no file or folder to add to the chat.",
    );
    return;
  }
  focusGUI();
  if (!sidebar.isReady) {
    const isReady = await waitForSidebarReady(sidebar, 5000, 100);
    if (!isReady) {
      return;
    }
  }
  void sidebar.webviewProtocol?.request("addToChat", payload);
}

// Copy everything over from extension.ts
const getCommandsMap: (
  ide: VsCodeIde,
  extensionContext: vscode.ExtensionContext,
  sidebar: ContinueGUIWebviewViewProvider,
  consoleView: ContinueConsoleWebviewViewProvider,
  configHandler: ConfigHandler,
  verticalDiffManager: VerticalDiffManager,
  battery: Battery,
  quickEdit: QuickEdit,
  core: Core,
  editDecorationManager: EditDecorationManager,
) => { [command: string]: (...args: any) => any } = (
  ide,
  extensionContext,
  sidebar,
  consoleView,
  configHandler,
  verticalDiffManager,
  battery,
  quickEdit,
  core,
  editDecorationManager,
) => {
  /**
   * Streams an inline edit to the vertical diff manager.
   *
   * This function retrieves the configuration, determines the appropriate model title,
   * increments the FTC count, and then streams an edit to the
   * vertical diff manager.
   *
   * @param  promptName - The key for the prompt in the context menu configuration.
   * @param  fallbackPrompt - The prompt to use if the configured prompt is not available.
   * @param  [range] - Optional. The range to edit if provided.
   * @returns
   */
  async function streamInlineEdit(
    promptName: keyof ContextMenuConfig,
    fallbackPrompt: string,
    range?: vscode.Range,
  ) {
    const { config } = await configHandler.loadConfig();
    if (!config) {
      throw new Error("Config not loaded");
    }

    const llm =
      config.selectedModelByRole.edit ?? config.selectedModelByRole.chat;

    if (!llm) {
      throw new Error("No edit or chat model selected");
    }

    void sidebar.webviewProtocol.request("incrementFtc", undefined);

    await verticalDiffManager.streamEdit({
      input:
        config.experimental?.contextMenuPrompts?.[promptName] ?? fallbackPrompt,
      llm,
      range,
      rulesToInclude: config.rules,
      isApply: false,
    });
  }

  return {
    "continuous.acceptDiff": async (newFileUri?: string, streamId?: string) => {
      void processDiff(
        "accept",
        sidebar,
        ide,
        core,
        verticalDiffManager,
        newFileUri,
        streamId,
      );
    },

    "continuous.rejectDiff": async (newFileUri?: string, streamId?: string) => {
      void processDiff(
        "reject",
        sidebar,
        ide,
        core,
        verticalDiffManager,
        newFileUri,
        streamId,
      );
    },
    "continuous.acceptVerticalDiffBlock": (
      fileUri?: string,
      index?: number,
    ) => {
      verticalDiffManager.acceptRejectVerticalDiffBlock(true, fileUri, index);
    },
    "continuous.rejectVerticalDiffBlock": (
      fileUri?: string,
      index?: number,
    ) => {
      verticalDiffManager.acceptRejectVerticalDiffBlock(false, fileUri, index);
    },
    "continuous.quickFix": async (
      range: vscode.Range,
      diagnosticMessage: string,
    ) => {
      const prompt = `Please explain the cause of this error and how to solve it: ${diagnosticMessage}`;

      addCodeToContextFromRange(range, sidebar.webviewProtocol, prompt);

      vscode.commands.executeCommand("continuous.continueGUIView.focus");
    },
    "continuous.defaultQuickAction": async (args: QuickEditShowParams) => {
      vscode.commands.executeCommand("continuous.focusEdit", args);
    },
    "continuous.customQuickActionSendToChat": async (
      prompt: string,
      range: vscode.Range,
    ) => {
      addCodeToContextFromRange(range, sidebar.webviewProtocol, prompt);

      vscode.commands.executeCommand("continuous.continueGUIView.focus");
    },
    "continuous.customQuickActionStreamInlineEdit": async (
      prompt: string,
      range: vscode.Range,
    ) => {
      streamInlineEdit("docstring", prompt, range);
    },
    "continuous.codebaseForceReIndex": async () => {
      core.invoke("index/forceReIndex", undefined);
    },
    "continuous.rebuildCodebaseIndex": async () => {
      core.invoke("index/forceReIndex", { shouldClearIndexes: true });
    },
    "continuous.docsIndex": async () => {
      core.invoke("context/indexDocs", { reIndex: false });
    },
    "continuous.docsReIndex": async () => {
      core.invoke("context/indexDocs", { reIndex: true });
    },
    "continuous.focusContinuousInput": async () => {
      const isContinueInputFocused = await sidebar.webviewProtocol.request(
        "isContinueInputFocused",
        undefined,
        false,
      );

      // This is a temporary fix—sidebar.webviewProtocol.request is blocking
      // when the GUI hasn't yet been setup and we should instead be
      // immediately throwing an error, or returning a Result object
      focusGUI();
      if (!sidebar.isReady) {
        const isReady = await waitForSidebarReady(sidebar, 5000, 100);
        if (!isReady) {
          return;
        }
      }

      const historyLength = await sidebar.webviewProtocol.request(
        "getWebviewHistoryLength",
        undefined,
        false,
      );

      if (isContinueInputFocused) {
        if (historyLength === 0) {
          hideGUI();
        } else {
          void sidebar.webviewProtocol?.request(
            "focusContinueInputWithNewSession",
            undefined,
            false,
          );
        }
      } else {
        // The selection has to be read before the new session focuses the
        // chat. That reset clears the input, so the code is added after it,
        // into the session that stays on screen.
        const rangeInFileWithContents = getRangeInFileWithContents(false);
        focusGUI();
        await sidebar.webviewProtocol?.request(
          "focusContinueInputWithNewSession",
          undefined,
          false,
        );
        if (rangeInFileWithContents) {
          void sidebar.webviewProtocol?.request("highlightedCode", {
            rangeInFileWithContents,
          });
        }
      }
    },
    "continuous.focusContinuousInputWithoutClear": async () => {
      const isContinueInputFocused = await sidebar.webviewProtocol.request(
        "isContinueInputFocused",
        undefined,
        false,
      );

      // This is a temporary fix—sidebar.webviewProtocol.request is blocking
      // when the GUI hasn't yet been setup and we should instead be
      // immediately throwing an error, or returning a Result object
      focusGUI();
      if (!sidebar.isReady) {
        const isReady = await waitForSidebarReady(sidebar, 5000, 100);
        if (!isReady) {
          return;
        }
      }

      if (isContinueInputFocused) {
        hideGUI();
      } else {
        focusGUI();

        sidebar.webviewProtocol?.request(
          "focusContinueInputWithoutClear",
          undefined,
        );

        void addHighlightedCodeToContext(sidebar.webviewProtocol);
      }
    },
    // QuickEditShowParams are passed from CodeLens, temp fix
    // until we update to new params specific to Edit
    "continuous.focusEdit": async (args?: QuickEditShowParams) => {
      focusGUI();
      sidebar.webviewProtocol?.request("focusEdit", undefined);
    },
    "continuous.exitEditMode": async () => {
      editDecorationManager.clear();
      void sidebar.webviewProtocol?.request("exitEditMode", undefined);
    },
    "continuous.writeCommentsForCode": async () => {
      streamInlineEdit(
        "comment",
        "Write comments for this code. Do not change anything about the code itself.",
      );
    },
    "continuous.writeDocstringForCode": async () => {
      void streamInlineEdit(
        "docstring",
        "Write a docstring for this code. Do not change anything about the code itself.",
      );
    },
    "continuous.fixCode": async () => {
      streamInlineEdit(
        "fix",
        "Fix this code. If it is already 100% correct, simply rewrite the code.",
      );
    },
    "continuous.optimizeCode": async () => {
      streamInlineEdit("optimize", "Optimize this code");
    },
    "continuous.fixGrammar": async () => {
      streamInlineEdit(
        "fixGrammar",
        "If there are any grammar or spelling mistakes in this writing, fix them. Do not make other large changes to the writing.",
      );
    },
    "continuous.clearConsole": async () => {
      consoleView.clearLog();
    },
    "continuous.viewLogs": async () => {
      vscode.commands.executeCommand("workbench.action.toggleDevTools");
    },
    "continuous.debugTerminal": async () => {
      const terminalContents = await ide.getTerminalContents();

      vscode.commands.executeCommand("continuous.continueGUIView.focus");

      sidebar.webviewProtocol?.request("userInput", {
        input: `I got the following error, can you please help explain how to fix it?\n\n${terminalContents.trim()}`,
      });
    },
    "continuous.hideInlineTip": () => {
      vscode.workspace
        .getConfiguration(EXTENSION_NAME)
        .update("showInlineTip", false, vscode.ConfigurationTarget.Global);
    },

    // Commands without keyboard shortcuts
    "continuous.addModel": () => {
      vscode.commands.executeCommand("continuous.continueGUIView.focus");
      sidebar.webviewProtocol?.request("addModel", undefined);
    },
    "continuous.newSession": () => {
      sidebar.webviewProtocol?.request("newSession", undefined);
    },
    "continuous.copyMessageAsMarkdown": async () => {
      await vscode.commands.executeCommand("continuous.continueGUIView.focus");
      const copied = await sidebar.webviewProtocol?.request(
        "copyMessageAsMarkdown",
        undefined,
      );
      if (!copied) {
        void vscode.window.showInformationMessage(
          "Focus a message in the chat, then copy it.",
        );
      }
    },

    "continuous.shareSession": async (sessionId: string | undefined) => {
      if (!sessionId) {
        sessionId = await sidebar.webviewProtocol?.request(
          "getCurrentSessionId",
          undefined,
        );
      }
      if (!sessionId) {
        void vscode.window.showErrorMessage(
          "No session ID found. Please start a new session first.",
        );
        return;
      }
      //let user select the destination folder
      const destinationFolder = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: "Select Destination Folder",
      });
      if (!destinationFolder || destinationFolder.length === 0) {
        return;
      }

      try {
        // despite core.invoke not being async, we still need to await it, because the 'history/share' command is async
        // if not awaited, then errors will not be caught.
        await core.invoke("history/share", {
          id: sessionId,
          outputDir: destinationFolder[0].fsPath,
        });
      } catch (error) {
        const errorMessage = `Failed to save session: ${error instanceof Error ? error.message : String(error)}`;
        void vscode.window.showErrorMessage(errorMessage);
      }
    },
    "continuous.viewHistory": () => {
      vscode.commands.executeCommand("continuous.navigateTo", "/history", true);
    },
    "continuous.focusContinuousSessionId": async (
      sessionId: string | undefined,
    ) => {
      if (!sessionId) {
        sessionId = await vscode.window.showInputBox({
          prompt: "Enter the Session ID",
        });
      }
      void sidebar.webviewProtocol?.request("focusContinueSessionId", {
        sessionId,
      });
    },
    "continuous.applyCodeFromChat": () => {
      void sidebar.webviewProtocol.request("applyCodeFromChat", undefined);
    },
    "continuous.openConfigPage": () => {
      vscode.commands.executeCommand("continuous.navigateTo", "/config", false);
    },
    "continuous.openModelSetup": () => {
      // Opens the shared provider setup flow (credentials, models, review).
      void sidebar.webviewProtocol.request("setupApiKey", undefined);
      focusGUI();
    },
    // The Explorer's former "Select Files as Context" pasted every selected
    // file in full (folders recursively) with no size cap or credential
    // check. The id stays for existing keybindings and now adds chips.
    "continuous.selectFilesAsContext": async (
      clicked?: unknown,
      selected?: unknown,
    ) => {
      await vscode.commands.executeCommand(
        "continuous.addToChat",
        clicked,
        selected,
      );
    },
    "continuous.addToChat": async (clicked?: unknown, selected?: unknown) => {
      const uris = urisFromCommandArgs<vscode.Uri>(
        clicked instanceof vscode.Uri ? clicked : undefined,
        selected,
        vscode.window.activeTextEditor?.document.uri,
      );
      await addResourcesToChat(uris, sidebar);
    },
    "continuous.addOpenTabsToChat": async () => {
      const uris = vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .map((tab) => uriOfTabInput<vscode.Uri>(tab.input))
        .filter((uri): uri is vscode.Uri => !!uri);
      await addResourcesToChat(uris, sidebar);
    },
    "continuous.logAutocompleteOutcome": (
      completionId: string,
      completionProvider: CompletionProvider,
    ) => {
      completionProvider.accept(completionId);
    },
    "continuous.logNextEditOutcomeAccept": (
      completionId: string,
      nextEditLoggingService: NextEditLoggingService,
    ) => {
      nextEditLoggingService.accept(completionId);
    },
    "continuous.logNextEditOutcomeReject": (
      completionId: string,
      nextEditLoggingService: NextEditLoggingService,
    ) => {
      nextEditLoggingService.reject(completionId);
    },
    "continuous.toggleTabAutocompleteEnabled": () => {
      const config = vscode.workspace.getConfiguration(EXTENSION_NAME);
      const enabled = config.get("enableTabAutocomplete");
      const pauseOnBattery = config.get<boolean>(
        "pauseTabAutocompleteOnBattery",
      );
      if (!pauseOnBattery || battery.isACConnected()) {
        config.update(
          "enableTabAutocomplete",
          !enabled,
          vscode.ConfigurationTarget.Global,
        );
      } else {
        if (enabled) {
          const paused = getStatusBarStatus() === StatusBarStatus.Paused;
          if (paused) {
            setupStatusBar(StatusBarStatus.Enabled);
          } else {
            config.update(
              "enableTabAutocomplete",
              false,
              vscode.ConfigurationTarget.Global,
            );
          }
        } else {
          setupStatusBar(StatusBarStatus.Paused);
          config.update(
            "enableTabAutocomplete",
            true,
            vscode.ConfigurationTarget.Global,
          );
        }
      }
    },
    "continuous.forceAutocomplete": async () => {
      // 1. Explicitly hide any existing suggestion. This clears VS Code's cache for the current position.
      await vscode.commands.executeCommand("editor.action.inlineSuggest.hide");

      // 2. Now trigger a new one. VS Code has no cached suggestion, so it's forced to call our provider.
      await vscode.commands.executeCommand(
        "editor.action.inlineSuggest.trigger",
      );
    },

    "continuous.openTabAutocompleteConfigMenu": async () => {
      const config = vscode.workspace.getConfiguration(EXTENSION_NAME);
      const quickPick = vscode.window.createQuickPick();

      const { config: continueConfig } = await configHandler.loadConfig();
      const autocompleteModels =
        continueConfig?.modelsByRole.autocomplete ?? [];
      const selected =
        continueConfig?.selectedModelByRole?.autocomplete?.title ?? undefined;

      // Toggle between Disabled, Paused, and Enabled
      const pauseOnBattery =
        config.get<boolean>("pauseTabAutocompleteOnBattery") &&
        !battery.isACConnected();
      const currentStatus = getStatusBarStatus();

      let targetStatus: StatusBarStatus | undefined;
      if (pauseOnBattery) {
        // Cycle from Disabled -> Paused -> Enabled
        targetStatus =
          currentStatus === StatusBarStatus.Paused
            ? StatusBarStatus.Enabled
            : currentStatus === StatusBarStatus.Disabled
              ? StatusBarStatus.Paused
              : StatusBarStatus.Disabled;
      } else {
        // Toggle between Disabled and Enabled
        targetStatus =
          currentStatus === StatusBarStatus.Disabled
            ? StatusBarStatus.Enabled
            : StatusBarStatus.Disabled;
      }

      const nextEditEnabled = config.get<boolean>("enableNextEdit") ?? false;

      quickPick.items = [
        {
          label: "$(gear) Open settings",
        },
        {
          label: "$(comment) Open chat",
          description: getMetaKeyLabel() + " + L",
        },
        {
          label: "$(screen-full) Open full screen chat",
          description:
            getMetaKeyLabel() + " + K, " + getMetaKeyLabel() + " + M",
        },
        {
          label: quickPickStatusText(targetStatus),
          description:
            getMetaKeyLabel() + " + K, " + getMetaKeyLabel() + " + A",
        },
        ...getNextEditMenuItems(currentStatus, nextEditEnabled),
        {
          kind: vscode.QuickPickItemKind.Separator,
          label: "Switch model",
        },
        ...autocompleteModels.map((model) => ({
          label: getAutocompleteStatusBarTitle(selected, model),
          description: getAutocompleteStatusBarDescription(selected, model),
        })),
      ];
      quickPick.onDidAccept(() => {
        const selectedOption = quickPick.selectedItems[0].label;
        const targetStatus =
          getStatusBarStatusFromQuickPickItemLabel(selectedOption);

        if (targetStatus !== undefined) {
          setupStatusBar(targetStatus);
          config.update(
            "enableTabAutocomplete",
            targetStatus === StatusBarStatus.Enabled,
            vscode.ConfigurationTarget.Global,
          );
        } else if (isNextEditToggleLabel(selectedOption)) {
          handleNextEditToggle(selectedOption, config);
        } else if (
          autocompleteModels.some((model) => model.title === selectedOption)
        ) {
          if (core.configHandler.currentProfile?.profileDescription.id) {
            core.invoke("config/updateSelectedModel", {
              profileId:
                core.configHandler.currentProfile?.profileDescription.id,
              role: "autocomplete",
              title: selectedOption,
            });
          }
        } else if (selectedOption === "$(comment) Open chat") {
          vscode.commands.executeCommand("continuous.focusContinuousInput");
        } else if (selectedOption === "$(screen-full) Open full screen chat") {
          vscode.commands.executeCommand("continuous.openInNewWindow");
        } else if (selectedOption === "$(gear) Open settings") {
          vscode.commands.executeCommand("continuous.navigateTo", "/config");
        }

        quickPick.dispose();
      });
      quickPick.show();
    },
    ...paletteCommands({
      showPanel: async () => {
        focusGUI();
        return sidebar.isReady || waitForSidebarReady(sidebar, 5000, 100);
      },
      request: (messageType, data) =>
        sidebar.webviewProtocol.request(messageType, data),
      info: (message) => void vscode.window.showInformationMessage(message),
    }),
    "continuous.navigateTo": (path: string, toggle: boolean) => {
      sidebar.webviewProtocol?.request("navigateTo", { path, toggle });
      focusGUI();
    },
    "continuous.startLocalOllama": () => {
      startLocalOllama(ide);
    },
    "continuous.startLocalLemonade": () => {
      startLocalLemonade(ide);
    },
    "continuous.installModel": async (
      modelName: string,
      llmProvider: ILLM | undefined,
    ) => {
      try {
        if (!isModelInstaller(llmProvider)) {
          const msg = llmProvider
            ? `LLM provider '${llmProvider.providerName}' does not support installing models`
            : "Missing LLM Provider";
          throw new Error(msg);
        }
        await installModelWithProgress(modelName, llmProvider);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(
          `Failed to install '${modelName}': ${message}`,
        );
      }
    },
    "continuous.convertConfigJsonToConfigYaml": async () => {
      const configJson = fs.readFileSync(getConfigJsonPath(), "utf-8");
      const parsed = JSON.parse(configJson);
      const configYaml = convertJsonToYamlConfig(parsed);

      const configYamlPath = getConfigYamlPath();
      fs.writeFileSync(configYamlPath, YAML.stringify(configYaml));
      setConfigFilePermissions(configYamlPath);

      // Open config.yaml
      await openEditorAndRevealRange(
        vscode.Uri.file(configYamlPath),
        undefined,
        undefined,
        false,
      );

      void vscode.window
        .showInformationMessage(
          "Your config.json has been converted to the new config.yaml format. If you need to switch back to config.json, you can delete or rename config.yaml.",
          "Read the docs",
        )
        .then(async (selection) => {
          if (selection === "Read the docs") {
            await vscode.env.openExternal(
              vscode.Uri.parse(
                "https://b1tninja.github.io/continuous/reference/yaml-migration",
              ),
            );
          }
        });
    },
    "continuous.toggleNextEditEnabled": async () => {
      const config = vscode.workspace.getConfiguration(EXTENSION_NAME);
      const tabAutocompleteEnabled = config.get<boolean>(
        "enableTabAutocomplete",
      );

      if (!tabAutocompleteEnabled) {
        vscode.window.showInformationMessage(
          "Please enable tab autocomplete first to use Next Edit",
        );
        return;
      }

      const nextEditEnabled = config.get<boolean>("enableNextEdit") ?? false;

      // updateNextEditState in VsCodeExtension.ts will handle the validation.
      config.update(
        "enableNextEdit",
        !nextEditEnabled,
        vscode.ConfigurationTarget.Global,
      );
    },
    "continuous.openInNewWindow": async () => {
      focusGUI();

      const sessionId = await sidebar.webviewProtocol.request(
        "getCurrentSessionId",
        undefined,
      );
      // Check if full screen is already open by checking open tabs
      const fullScreenTab = getFullScreenTab();

      if (fullScreenTab && fullScreenPanel) {
        // Full screen open, but not focused - focus it
        fullScreenPanel.reveal();
        return;
      }

      // Clear the sidebar to prevent overwriting changes made in fullscreen
      vscode.commands.executeCommand("continuous.newSession");

      // Full screen not open - open it
      // Create the full screen panel
      let panel = vscode.window.createWebviewPanel(
        "continuous.continueGUIView",
        "Continuous",
        vscode.ViewColumn.One,
        {
          retainContextWhenHidden: true,
          enableScripts: true,
        },
      );
      fullScreenPanel = panel;

      // Add content to the panel
      panel.webview.html = sidebar.getSidebarContent(
        extensionContext,
        panel,
        undefined,
        undefined,
        true,
      );

      const sessionLoader = panel.onDidChangeViewState(() => {
        vscode.commands.executeCommand("continuous.newSession");
        if (sessionId) {
          vscode.commands.executeCommand(
            "continuous.focusContinuousSessionId",
            sessionId,
          );
        }
        panel.reveal();
        sessionLoader.dispose();
      });

      // When panel closes, reset the webview and focus
      panel.onDidDispose(
        () => {
          sidebar.resetWebviewProtocolWebview();
          vscode.commands.executeCommand("continuous.focusContinuousInput");
        },
        null,
        extensionContext.subscriptions,
      );

      vscode.commands.executeCommand("workbench.action.copyEditorToNewWindow");
      vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
    },
    "continuous.forceNextEdit": async () => {
      // This is basically the same logic as forceAutocomplete.
      // I'm writing a new command KV pair here in case we diverge in features.

      await vscode.commands.executeCommand("editor.action.inlineSuggest.hide");

      await vscode.commands.executeCommand(
        "editor.action.inlineSuggest.trigger",
      );
    },
  };
};

async function installModelWithProgress(
  modelName: string,
  modelInstaller: ModelInstaller,
) {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Installing model '${modelName}'`,
      cancellable: true,
    },
    async (windowProgress, token) => {
      let currentProgress: number = 0;
      const progressWrapper = (
        details: string,
        worked?: number,
        total?: number,
      ) => {
        let increment = 0;
        if (worked && total) {
          const progressValue = Math.round((worked / total) * 100);
          increment = progressValue - currentProgress;
          currentProgress = progressValue;
        }
        windowProgress.report({ message: details, increment });
      };
      const abortController = new AbortController();
      token.onCancellationRequested(() => {
        console.log(`Pulling ${modelName} model was cancelled`);
        abortController.abort();
      });
      await modelInstaller.installModel(
        modelName,
        abortController.signal,
        progressWrapper,
      );
    },
  );
}

export function registerAllCommands(
  context: vscode.ExtensionContext,
  ide: VsCodeIde,
  extensionContext: vscode.ExtensionContext,
  sidebar: ContinueGUIWebviewViewProvider,
  consoleView: ContinueConsoleWebviewViewProvider,
  configHandler: ConfigHandler,
  verticalDiffManager: VerticalDiffManager,
  battery: Battery,
  quickEdit: QuickEdit,
  core: Core,
  editDecorationManager: EditDecorationManager,
) {
  for (const [command, callback] of Object.entries(
    getCommandsMap(
      ide,
      extensionContext,
      sidebar,
      consoleView,
      configHandler,
      verticalDiffManager,
      battery,
      quickEdit,
      core,
      editDecorationManager,
    ),
  )) {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, callback),
    );
  }
}
