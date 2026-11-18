import * as vscode from "vscode";

import {
  describeOutcome,
  DropChip,
  DroppedKind,
  resolveDrop,
  URI_LIST_MIME,
} from "./dropHandler";

export const DROP_ZONE_VIEW_ID = "continuous.dropZone";
export const DROP_ZONE_PICK_COMMAND = "continuous.dropZone.pickFiles";

/**
 * Set when this VS Code no longer delivers Explorer and editor-tab drags to
 * webviews (1.140 and later, microsoft/vscode#339036), so the
 * `continuous.chatDropZone` setting's "auto" value shows the view.
 */
export const DROP_BLOCKED_CONTEXT_KEY = "continuous.webviewDropBlocked";

/** First VS Code release with Electron 43.7 (microsoft/vscode#339036). */
const FIRST_BLOCKED_VERSION: [number, number] = [1, 140];

export function isWebviewDropBlocked(version: string): boolean {
  const match = /^(\d+)\.(\d+)/.exec(version);
  if (!match) {
    return false;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (
    major > FIRST_BLOCKED_VERSION[0] ||
    (major === FIRST_BLOCKED_VERSION[0] && minor >= FIRST_BLOCKED_VERSION[1])
  );
}

class DropZoneItem extends vscode.TreeItem {}

function placeholder(): DropZoneItem {
  const item = new DropZoneItem(
    "Drop files or folders here",
    vscode.TreeItemCollapsibleState.None,
  );
  item.id = "continuous.dropZone.placeholder";
  item.iconPath = new vscode.ThemeIcon("inbox");
  item.description = "or press Enter to pick";
  item.tooltip = new vscode.MarkdownString(
    "Drop files or folders from the Explorer, an editor tab or your file manager to add them to the chat input as `@` mentions.\n\nFiles outside the workspace and files that look like they hold secrets are not added.",
  );
  item.accessibilityInformation = {
    label:
      "Add files or folders to the Continuous chat input. Press Enter to pick them, or drop them here.",
    role: "button",
  };
  item.command = {
    command: DROP_ZONE_PICK_COMMAND,
    title: "Pick Files or Folders for Chat",
  };
  return item;
}

/**
 * The single-row tree view. Tree views are drawn by the workbench itself, not
 * in a webview iframe, so drags from the Explorer and editor tabs still reach
 * them on VS Code 1.140 and later.
 */
export class ChatDropZone
  implements
    vscode.TreeDataProvider<DropZoneItem>,
    vscode.TreeDragAndDropController<DropZoneItem>
{
  // `onDragOver` in the workbench adds `text/uri-list` for any OS file, so
  // this one type accepts the Explorer, editor tabs and the file manager.
  readonly dropMimeTypes = [URI_LIST_MIME];
  readonly dragMimeTypes: string[] = [];

  private readonly item = placeholder();

  constructor(private readonly deliver: (chips: DropChip[]) => Promise<void>) {}

  getTreeItem(element: DropZoneItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: DropZoneItem): DropZoneItem[] {
    return element ? [] : [this.item];
  }

  async handleDrop(
    _target: DropZoneItem | undefined,
    dataTransfer: vscode.DataTransfer,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const outcome = await resolveDrop(dataTransfer, {
      workspaceDirs: workspaceDirs(),
      stat: statKind,
      caseInsensitiveFiles: process.platform !== "linux",
    });
    if (token.isCancellationRequested) {
      return;
    }
    await this.report(
      outcome.chips,
      describeOutcome(outcome),
      outcome.refused.length > 0,
    );
  }

  /** The keyboard route: the same checks, from an open dialog. */
  async pickFiles(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    // Windows and Linux dialogs pick files or folders, not both at once.
    let files = true;
    let dirs = true;
    if (process.platform !== "darwin") {
      const choice = await vscode.window.showQuickPick(["Files", "Folders"], {
        placeHolder: "Add files or folders to the chat input",
      });
      if (!choice) {
        return;
      }
      files = choice === "Files";
      dirs = !files;
    }
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: files,
      canSelectFolders: dirs,
      canSelectMany: true,
      defaultUri: folders?.[0]?.uri,
      openLabel: "Add to Chat",
    });
    if (!picked?.length) {
      return;
    }
    const list = picked.map((u) => u.toString()).join("\r\n");
    const outcome = await resolveDrop(
      {
        get: (m) =>
          m === URI_LIST_MIME ? { asString: async () => list } : undefined,
      },
      {
        workspaceDirs: workspaceDirs(),
        stat: statKind,
        caseInsensitiveFiles: process.platform !== "linux",
      },
    );
    await this.report(
      outcome.chips,
      describeOutcome(outcome),
      outcome.refused.length > 0,
    );
  }

  private async report(
    chips: DropChip[],
    sentence: string | undefined,
    anyRefused: boolean,
  ): Promise<void> {
    if (chips.length > 0) {
      await this.deliver(chips);
    }
    if (!sentence) {
      return;
    }
    if (anyRefused) {
      void vscode.window.showWarningMessage(sentence);
    } else {
      vscode.window.setStatusBarMessage(sentence, 4000);
    }
  }
}

function workspaceDirs(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.toString());
}

async function statKind(uri: string): Promise<DroppedKind | undefined> {
  try {
    const stat = await vscode.workspace.fs.stat(vscode.Uri.parse(uri, true));
    if (stat.type & vscode.FileType.Directory) {
      return "folder";
    }
    if (stat.type & vscode.FileType.File) {
      return "file";
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Registers the view, its pick command and the context key its `when` clause
 * reads. `deliver` inserts the chips into the chat input (the `addToChat`
 * message) and focuses it.
 */
export function registerChatDropZone(
  context: vscode.ExtensionContext,
  deliver: (chips: DropChip[]) => Promise<void>,
): void {
  void vscode.commands.executeCommand(
    "setContext",
    DROP_BLOCKED_CONTEXT_KEY,
    isWebviewDropBlocked(vscode.version),
  );
  const zone = new ChatDropZone(deliver);
  context.subscriptions.push(
    vscode.window.createTreeView(DROP_ZONE_VIEW_ID, {
      treeDataProvider: zone,
      dragAndDropController: zone,
    }),
    vscode.commands.registerCommand(DROP_ZONE_PICK_COMMAND, () =>
      zone.pickFiles(),
    ),
  );
}
