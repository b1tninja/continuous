import { messageQueue } from "../../stream/messageQueue.js";
import { backgroundSignalManager } from "../../util/backgroundSignalManager.js";
import {
  checkClipboardForImage,
  getClipboardImage,
} from "../../util/clipboard.js";
import { logger } from "../../util/logger.js";
import type { TextBuffer } from "../TextBuffer.js";

// Helper function to handle control keys
interface ControlKeysOptions {
  input: string;
  key: any;
  exit: () => void;
  showSlashCommands: boolean;
  showFileSearch: boolean;
  cycleModes: (step?: 1 | -1) => Promise<unknown>;
  /**
   * Ctrl+C: asks before stopping a turn, clearing text or exiting over running
   * work. True when it took the press, so the two-stage exit does not count it.
   */
  onCtrlC?: () => boolean;
  /** Ctrl+D: true when it asked instead of exiting (work runs, or text is typed) */
  onCtrlD?: () => boolean;
  textBuffer?: TextBuffer;
  onTextBufferUpdate?: () => void;
}

/**
 * Ctrl+C and Ctrl+D. Typed text is not cleared by one Ctrl+C and work is not
 * ended by one key: the prompt's handlers ask first and answer true when they
 * took the key (useExitGuards). Otherwise Ctrl+C goes to the process's SIGINT
 * handler (the two-stage exit) and Ctrl+D exits.
 */
function handleExitKeys(
  input: string,
  key: any,
  exit: () => void,
  onCtrlC?: () => boolean,
  onCtrlD?: () => boolean,
): boolean {
  if (key.ctrl && input === "c") {
    if (onCtrlC?.()) return true;
    process.kill(process.pid, "SIGINT");
    return true;
  }
  if (key.ctrl && input === "d") {
    if (onCtrlD?.()) return true;
    exit();
    void import("../../util/exit.js").then(({ gracefulExit }) =>
      gracefulExit(0),
    );
    return true;
  }
  return false;
}

export function handleControlKeys(options: ControlKeysOptions): boolean {
  const {
    input,
    key,
    exit,
    showSlashCommands,
    showFileSearch,
    cycleModes,
    onCtrlC,
    onCtrlD,
    textBuffer,
    onTextBufferUpdate,
  } = options;

  // Ctrl+C: two-stage exit; Ctrl+D: exit. Both ask first when it matters
  if (handleExitKeys(input, key, exit, onCtrlC, onCtrlD)) return true;

  // Handle Ctrl+V for clipboard paste (including images)
  // Note: Cmd+V often doesn't work for image pasting as terminals don't send the key event
  if (key.ctrl && input === "v" && textBuffer) {
    logger.debug("Handling Ctrl+V clipboard paste");

    // Check clipboard for images immediately on paste event
    checkClipboardForImage()
      .then(async (hasImage) => {
        if (hasImage) {
          logger.debug("Image found in clipboard during paste event");
          const imageBuffer = await getClipboardImage();
          if (imageBuffer) {
            textBuffer.addImage(imageBuffer);
            // Trigger UI update
            if (onTextBufferUpdate) {
              onTextBufferUpdate();
            }
            return;
          }
        }
        // If no image, let normal text paste handling continue
      })
      .catch((error) => {
        logger.debug("Error checking clipboard for image:", error);
      });

    // Don't consume the event - let normal text paste handling continue
    return false;
  }

  // Handle Ctrl+L to refresh screen (clear terminal artifacts)
  if (key.ctrl && input === "l") {
    process.stdout.write("\x1b[2J\x1b[H");
    return true;
  }

  // Handle Ctrl+B to send current tool execution to background
  if (key.ctrl && input === "b") {
    backgroundSignalManager.signalBackground();
    return true;
  }

  // Handle Shift+Tab to cycle through modes
  if (key.tab && key.shift && !showSlashCommands && !showFileSearch) {
    cycleModes().catch((error) => {
      logger.error("Failed to cycle modes:", error);
    });
    return true;
  }

  // Left and Right on an empty prompt (where they move nothing) step back
  // and forward through the modes; not while a queued message is selected
  if (
    (key.leftArrow || key.rightArrow) &&
    !messageQueue.getSelectedId() &&
    !key.ctrl &&
    !key.meta &&
    !key.shift &&
    textBuffer &&
    textBuffer.text === "" &&
    !showSlashCommands &&
    !showFileSearch
  ) {
    cycleModes(key.rightArrow ? 1 : -1).catch((error) => {
      logger.error("Failed to switch modes:", error);
    });
    return true;
  }

  return false;
}

// Helper to update text buffer state
interface TextBufferStateOptions {
  handled: boolean;
  textBuffer: any;
  setInputText: (text: string) => void;
  setCursorPosition: (pos: number) => void;
  updateSlashCommandState: (text: string, cursor: number) => void;
  updateFileSearchState: (text: string, cursor: number) => void;
  updateBashModeState: (text: string) => void;
  inputHistory: any;
}

export function updateTextBufferState(options: TextBufferStateOptions) {
  const {
    handled: _handled,
    textBuffer,
    setInputText,
    setCursorPosition,
    updateSlashCommandState,
    updateFileSearchState,
    updateBashModeState,
    inputHistory,
  } = options;

  // Skip state updates during rapid input mode to avoid conflicts with timer-based updates
  if (!textBuffer.isInRapidInputMode()) {
    const newText = textBuffer.text;
    const newCursor = textBuffer.cursor;
    setInputText(newText);
    setCursorPosition(newCursor);
    updateSlashCommandState(newText, newCursor);
    updateFileSearchState(newText, newCursor);
    updateBashModeState(newText);
    inputHistory.resetNavigation();
  }
}
