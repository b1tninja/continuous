import { setEditorEnvironmentDetail } from "core/util/environmentDetail";
import { parseEnvDetail } from "core/util/environmentSnapshot";
import * as vscode from "vscode";

const DETAIL = "continuous.environment.detail";

/**
 * `continuous.environment.detail`: how much the agent is told about this
 * machine and workspace (core/util/environmentDetail.ts, ENV18). Core runs in
 * this process, so the value is applied now and whenever it changes; a new
 * session uses it, a running one keeps the level it started with. The user
 * value chooses the level; a workspace value may only lower it, so a
 * repository's settings cannot make the agent send more.
 */
export function registerEnvironmentDetailSetting(
  context: vscode.ExtensionContext,
): void {
  const apply = () => {
    const inspected = vscode.workspace
      .getConfiguration()
      .inspect<string>(DETAIL);
    setEditorEnvironmentDetail(
      parseEnvDetail(inspected?.globalValue),
      parseEnvDetail(
        inspected?.workspaceFolderValue ?? inspected?.workspaceValue,
      ),
    );
  };
  apply();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(DETAIL)) apply();
    }),
  );
}
