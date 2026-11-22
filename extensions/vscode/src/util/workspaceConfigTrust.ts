import { ConfigHandler } from "core/config/ConfigHandler";
import {
  getInstructionFilesState,
  loadAgentFilesThisSession,
  setAgentFileGate,
  type InstructionFilesState,
} from "core/config/markdown/instructionFiles";
import {
  pendingProjectTrust,
  trustProjectScopes,
  type PendingTrust,
} from "core/config/projectTrust";
import * as vscode from "vscode";

const dismissed = new Set<string>();
let prompting = false;

function fingerprintKey(items: PendingTrust[]): string {
  return items
    .map((item) => `${item.scope}:${item.fingerprint}`)
    .sort()
    .join("|");
}

function describe(items: PendingTrust[]): string {
  const lines: string[] = [];
  for (const item of items) {
    const names = item.files.slice(0, 8).join(", ");
    lines.push(`${item.scope}: ${names}`);
  }
  return lines.join("\n");
}

/**
 * Ask once when a folder ships Continuous configuration that was not applied.
 * Trust is recorded outside the folder, against the files as they are now.
 */
export async function promptForWorkspaceConfigTrust(
  configHandler: ConfigHandler,
): Promise<void> {
  if (vscode.workspace.isTrusted === false) return;
  const items = pendingProjectTrust();
  if (items.length === 0 || prompting) return;
  const key = fingerprintKey(items);
  if (dismissed.has(key)) return;
  prompting = true;
  try {
    const choice = await vscode.window.showWarningMessage(
      `This folder includes Continuous configuration that has not been trusted, so it was not applied.\n\n${describe(items)}\n\nTrusting lets that configuration run. Your own configuration keeps any name it already uses.`,
      { modal: true },
      "Trust this folder",
    );
    if (choice !== "Trust this folder") {
      dismissed.add(key);
      return;
    }
    const byDir = new Map<string, PendingTrust[]>();
    for (const item of items) {
      const list = byDir.get(item.projectDir) ?? [];
      list.push(item);
      byDir.set(item.projectDir, list);
    }
    for (const [dir, group] of byDir) {
      const fingerprints: Record<string, string> = {};
      for (const item of group) fingerprints[item.scope] = item.fingerprint;
      trustProjectScopes(dir, fingerprints);
    }
    await configHandler.reloadConfig("Workspace configuration trusted");
  } catch (error) {
    console.warn("Could not save workspace configuration trust", error);
  } finally {
    prompting = false;
  }
}

/**
 * The webview's `projectTrust/ask`: the "Trust this folder" button of the MCP
 * servers tab. In Restricted Mode it opens VS Code's own workspace trust
 * page; otherwise it shows the question above again, even after "not now".
 * Trust is only ever recorded by the person's answer to that question.
 */
export async function askForWorkspaceConfigTrust(
  configHandler: ConfigHandler,
): Promise<{ shown: "config" | "workspace" | "none" }> {
  if (vscode.workspace.isTrusted === false) {
    await vscode.commands.executeCommand("workbench.trust.manage");
    return { shown: "workspace" };
  }
  if (pendingProjectTrust().length === 0) return { shown: "none" };
  dismissed.clear();
  await promptForWorkspaceConfigTrust(configHandler);
  return { shown: "config" };
}

/**
 * ROADMAP X20: in a workspace VS Code has not trusted (Restricted Mode),
 * `AGENTS.md` and the other agent files are not read. Call before the first
 * config load. When the person trusts the workspace, config reloads and the
 * file is read.
 */
export function gateAgentFilesOnWorkspaceTrust(
  context: vscode.ExtensionContext,
  reload: () => void,
): void {
  setAgentFileGate(() => vscode.workspace.isTrusted === false);
  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(reload));
}

/**
 * The webview's `instructionFiles/state`. `load` is the one-click Load: the
 * withheld agent files are read for this window's session only. Nothing is
 * stored, so the next window asks again.
 */
export async function instructionFilesState(
  load: boolean | undefined,
  configHandler: { reloadConfig(reason: string): Promise<unknown> },
): Promise<InstructionFilesState> {
  if (load && getInstructionFilesState().withheld.length > 0) {
    loadAgentFilesThisSession();
    await configHandler.reloadConfig("Agent file loaded for this session");
  }
  return getInstructionFilesState();
}
