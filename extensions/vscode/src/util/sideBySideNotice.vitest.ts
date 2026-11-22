import { afterEach, describe, expect, it, vi } from "vitest";

const { getExtension, showInformationMessage, executeCommand } = vi.hoisted(
  () => ({
    getExtension: vi.fn((_id: string): unknown => undefined),
    showInformationMessage: vi.fn(
      async (_message: string, ..._items: string[]): Promise<unknown> =>
        undefined,
    ),
    executeCommand: vi.fn(async (_command: string, ..._args: unknown[]) => {}),
  }),
);

vi.mock("vscode", () => ({
  extensions: { getExtension },
  window: { showInformationMessage },
  commands: { executeCommand },
}));

import {
  DISMISS,
  offerSideBySideNotice,
  OPEN_KEYBOARD_SHORTCUTS,
  ORIGINAL_EXTENSION_ID,
  SHORTCUT_EXAMPLES,
  SIDE_BY_SIDE_NOTICE_SHOWN_KEY,
  sideBySideMessage,
} from "./sideBySideNotice";

const packageJSON = require("../../package.json");

/** A context whose globalState is a plain map, as one user profile has. */
function contextWith(stored: Record<string, unknown> = {}) {
  const state = new Map(Object.entries(stored));
  return {
    extension: { id: "b1tninja.continuous" },
    globalState: {
      get: (key: string) => state.get(key),
      update: async (key: string, value: unknown) => {
        state.set(key, value);
      },
    },
  } as any;
}

/** The extension list of a person who has the original installed too. */
function originalInstalled() {
  getExtension.mockImplementation((id: string) =>
    id === ORIGINAL_EXTENSION_ID ? { id } : undefined,
  );
}

describe("offerSideBySideNotice", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    getExtension.mockReset();
    showInformationMessage.mockReset();
    executeCommand.mockReset();
  });

  it("shows one message with two buttons when Continue.continue is installed", async () => {
    originalInstalled();

    await offerSideBySideNotice(contextWith());

    expect(getExtension).toHaveBeenCalledWith("Continue.continue");
    expect(showInformationMessage).toHaveBeenCalledTimes(1);
    const [message, ...buttons] = showInformationMessage.mock.calls[0];
    expect(message).toBe(sideBySideMessage());
    expect(buttons).toEqual([OPEN_KEYBOARD_SHORTCUTS, DISMISS]);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("shows it once: the second start says nothing", async () => {
    originalInstalled();
    const context = contextWith();

    await offerSideBySideNotice(context);
    await offerSideBySideNotice(context);

    expect(context.globalState.get(SIDE_BY_SIDE_NOTICE_SHOWN_KEY)).toBe(true);
    expect(showInformationMessage).toHaveBeenCalledTimes(1);
  });

  it("does not show when the shown flag is set", async () => {
    originalInstalled();

    await offerSideBySideNotice(
      contextWith({ [SIDE_BY_SIDE_NOTICE_SHOWN_KEY]: true }),
    );

    expect(showInformationMessage).not.toHaveBeenCalled();
  });

  it("does not show, and keeps the flag unset, when the original is absent", async () => {
    const context = contextWith();

    await offerSideBySideNotice(context);

    expect(showInformationMessage).not.toHaveBeenCalled();
    // So that installing the original later still gets the notice
    expect(
      context.globalState.get(SIDE_BY_SIDE_NOTICE_SHOWN_KEY),
    ).toBeUndefined();
  });

  it("opens Keyboard Shortcuts filtered to this extension", async () => {
    originalInstalled();
    showInformationMessage.mockResolvedValue(OPEN_KEYBOARD_SHORTCUTS);
    const context = contextWith();

    await offerSideBySideNotice(context);
    await offerSideBySideNotice(context);

    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(executeCommand).toHaveBeenCalledWith(
      "workbench.action.openGlobalKeybindings",
      "@ext:b1tninja.continuous",
    );
    expect(showInformationMessage).toHaveBeenCalledTimes(1);
  });

  it("does not show again after Don't show again", async () => {
    originalInstalled();
    showInformationMessage.mockResolvedValue(DISMISS);
    const context = contextWith();

    await offerSideBySideNotice(context);
    await offerSideBySideNotice(context);

    expect(showInformationMessage).toHaveBeenCalledTimes(1);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("sets the flag before the message is answered", async () => {
    originalInstalled();
    // A notification nobody answers never resolves
    showInformationMessage.mockReturnValue(new Promise(() => {}));
    const context = contextWith();

    void offerSideBySideNotice(context);
    await vi.waitFor(() => expect(showInformationMessage).toHaveBeenCalled());

    expect(context.globalState.get(SIDE_BY_SIDE_NOTICE_SHOWN_KEY)).toBe(true);
  });

  it("logs one named line and does not reject when the message fails", async () => {
    originalInstalled();
    showInformationMessage.mockRejectedValue(new Error("no window\n    at x"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(offerSideBySideNotice(contextWith())).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(
      "Continuous: could not show the side-by-side notice: no window",
    );
  });
});

describe("sideBySideMessage", () => {
  it("says the three facts in one line", () => {
    const message = sideBySideMessage("win32", {});

    expect(message).not.toContain("\n");
    expect(message).not.toContain("!");
    expect(message).toContain("copies ~/.continue to ~/.continuous");
    expect(message).toContain("a change in one does not reach the other");
    expect(message).toContain(
      "bind the same default shortcuts, such as Ctrl+L and Ctrl+I.",
    );
  });

  it("names the keys as a Mac shows them", () => {
    expect(sideBySideMessage("darwin", {})).toContain(
      "such as Cmd+L and Cmd+I.",
    );
  });

  it("leaves out the folders when a variable names the global folder", () => {
    for (const name of ["CONTINUOUS_GLOBAL_DIR", "CONTINUE_GLOBAL_DIR"]) {
      const message = sideBySideMessage("linux", { [name]: "/srv/config" });
      expect(message).not.toContain("~/.continu");
      expect(message).toContain("the Continue extension is also installed");
      expect(message).toContain("such as Ctrl+L and Ctrl+I.");
    }
  });

  it("names shortcuts that the manifest binds", () => {
    const bindings: Array<{ command: string; key: string; mac?: string }> =
      packageJSON.contributes.keybindings;
    for (const example of SHORTCUT_EXAMPLES) {
      expect(bindings).toContainEqual(
        expect.objectContaining({
          command: example.command,
          key: example.key,
          mac: example.mac,
        }),
      );
    }
  });
});
