import { useEffect, useRef } from "react";

import {
  checkClipboardForImage,
  getClipboardImage,
} from "../../util/clipboard.js";
import { logger } from "../../util/logger.js";

/** The slowest the idle poll gets, after doubling from `pollInterval`. */
export const CLIPBOARD_MAX_POLL_INTERVAL_MS = 16_000;

/**
 * Whether polling the clipboard can help anyone: only a person at a terminal
 * sees the hint. Piped or redirected runs never start the probe process
 * (powershell, osascript or xclip).
 */
export function canProbeClipboard(
  stdin: { isTTY?: boolean } = process.stdin,
  stdout: { isTTY?: boolean } = process.stdout,
): boolean {
  return stdin.isTTY === true && stdout.isTTY === true;
}

interface UseClipboardMonitorOptions {
  onImageStatusChange?: (hasImage: boolean) => void;
  enabled?: boolean;
  pollInterval?: number;
  maxPollInterval?: number;
  /** Defaults to canProbeClipboard(); tests pass it. */
  interactive?: boolean;
}

/**
 * Hook to monitor clipboard for images and notify when status changes
 * Shows helpful UI messages when images are available for pasting
 *
 * Each probe starts a process (228 ms wall and about 250 ms CPU for the
 * PowerShell one on Windows), so:
 * - the poll is not restarted by renders: the callback is read through a
 *   ref, and only `enabled` and the intervals restart it. With an inline
 *   callback the effect used to re-run, and probe, on every keystroke;
 * - while nothing changes the interval doubles, from `pollInterval` up to
 *   `maxPollInterval`, and drops back when the clipboard changes or the
 *   input is enabled again (after each turn);
 * - nothing runs when the terminal is not interactive.
 * Ctrl+V checks the clipboard itself (useUserInput.ts), so a slower hint
 * never delays a paste.
 */
export function useClipboardMonitor({
  onImageStatusChange,
  enabled = true,
  pollInterval = 1000,
  maxPollInterval = CLIPBOARD_MAX_POLL_INTERVAL_MS,
  interactive = canProbeClipboard(),
}: UseClipboardMonitorOptions) {
  const lastImageStatus = useRef<boolean>(false);
  const isChecking = useRef<boolean>(false);
  const onImageStatusChangeRef = useRef(onImageStatusChange);
  onImageStatusChangeRef.current = onImageStatusChange;
  const polling = enabled && interactive;

  useEffect(() => {
    if (!polling) {
      return;
    }

    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    // The wait before the next probe: pollInterval after a start or a
    // change, then doubled each time nothing changed
    let delay = pollInterval;
    const longest = Math.max(maxPollInterval, pollInterval);

    const checkClipboard = async () => {
      let changed = false;
      // Prevent overlapping checks (a manual checkNow may be running)
      if (!isChecking.current) {
        isChecking.current = true;
        try {
          const hasImage = await checkClipboardForImage();

          // Only notify if status changed
          if (!stopped && hasImage !== lastImageStatus.current) {
            changed = true;
            lastImageStatus.current = hasImage;
            onImageStatusChangeRef.current?.(hasImage);
            logger.debug(
              hasImage
                ? "Image detected in clipboard"
                : "No image in clipboard",
            );
          }
        } catch (error) {
          logger.debug("Error checking clipboard:", error);
        } finally {
          isChecking.current = false;
        }
      }
      if (stopped) {
        return;
      }
      if (changed) {
        delay = pollInterval;
      }
      timer = setTimeout(checkClipboard, delay);
      if (!changed) {
        delay = Math.min(delay * 2, longest);
      }
    };

    // Initial check, then the next one is scheduled after each finishes
    void checkClipboard();

    // Cleanup
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [polling, pollInterval, maxPollInterval]);

  // Manual check function for explicit paste operations
  const checkNow = async (): Promise<Buffer | null> => {
    if (!polling || isChecking.current) {
      return null;
    }

    isChecking.current = true;

    try {
      const hasImage = await checkClipboardForImage();

      if (hasImage) {
        const imageBuffer = await getClipboardImage();
        return imageBuffer;
      }
    } catch (error) {
      logger.debug("Error in manual clipboard check:", error);
    } finally {
      isChecking.current = false;
    }

    return null;
  };

  return { checkNow };
}
