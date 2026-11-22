import * as vscode from "vscode";

import { warnOptionalStartup } from "./warnOptionalStartup";

/** The extension this one was forked from. Many people keep both installed. */
export const ORIGINAL_EXTENSION_ID = "Continue.continue";
export const SIDE_BY_SIDE_NOTICE_SHOWN_KEY = "continuous.sideBySideNoticeShown";
export const OPEN_KEYBOARD_SHORTCUTS = "Open Keyboard Shortcuts";
export const DISMISS = "Don't show again";

const OWN_EXTENSION_ID = "b1tninja.continuous";

/**
 * Two of this extension's default key bindings, as package.json has them. The
 * bindings were copied from the original's, whose manifest is not in this
 * repository, so the notice names examples and claims no complete list.
 */
export const SHORTCUT_EXAMPLES = [
  { command: "continuous.focusContinuousInput", key: "ctrl+l", mac: "cmd+l" },
  { command: "continuous.focusEdit", key: "ctrl+i", mac: "cmd+i" },
] as const;

function keyLabel(key: string): string {
  return key
    .split("+")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("+");
}

/**
 * The notice's text. With CONTINUOUS_GLOBAL_DIR or CONTINUE_GLOBAL_DIR set
 * nothing is copied and the folder is the one the variable names, so the
 * sentences about ~/.continue and ~/.continuous are left out.
 */
export function sideBySideMessage(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const keys = SHORTCUT_EXAMPLES.map((example) =>
    keyLabel(platform === "darwin" ? example.mac : example.key),
  );
  const sentences = ["Continuous: the Continue extension is also installed."];
  if (!env.CONTINUOUS_GLOBAL_DIR && !env.CONTINUE_GLOBAL_DIR) {
    sentences.push(
      "On its first start Continuous copies ~/.continue to ~/.continuous, unless ~/.continuous already exists, and keeps its configuration there.",
      "The two folders are separate from here on: a change in one does not reach the other.",
    );
  }
  sentences.push(
    `Both extensions bind the same default shortcuts, such as ${keys.join(" and ")}.`,
  );
  return sentences.join(" ");
}

/**
 * Tell a person who has Continue.continue installed, once, what the two
 * extensions share and what they do not. A notification, not a line in the
 * chat page: it shows on the first start whether or not the chat is open.
 * Never rejects, so the caller need not wait for it or catch.
 */
export async function offerSideBySideNotice(
  context: vscode.ExtensionContext,
): Promise<void> {
  try {
    if (context.globalState.get(SIDE_BY_SIDE_NOTICE_SHOWN_KEY)) {
      return;
    }
    if (!vscode.extensions.getExtension(ORIGINAL_EXTENSION_ID)) {
      return;
    }
    // Before the message: it shows once, whether it is answered or closed
    await context.globalState.update(SIDE_BY_SIDE_NOTICE_SHOWN_KEY, true);
    const choice = await vscode.window.showInformationMessage(
      sideBySideMessage(),
      OPEN_KEYBOARD_SHORTCUTS,
      DISMISS,
    );
    if (choice === OPEN_KEYBOARD_SHORTCUTS) {
      await vscode.commands.executeCommand(
        "workbench.action.openGlobalKeybindings",
        `@ext:${context.extension?.id ?? OWN_EXTENSION_ID}`,
      );
    }
  } catch (error) {
    warnOptionalStartup("could not show the side-by-side notice", error);
  }
}
