import fs from "fs";
import path from "path";

import { getGlobalDir } from "../hooks/hookTrust.js";
import { logger } from "../util/logger.js";

import { sendDesktopNotification } from "./osNotify.js";

/**
 * Attention notifications (GAP9): a terminal bell and/or an OS notification
 * when the terminal UI needs the person (an approval or a question is
 * waiting) or a long turn has finished. Off unless the person's own
 * settings.json turns it on; a project cannot. Local only: nothing goes to a
 * network service. The text carries names and states only, never a
 * command, an argument or a reply.
 */
export interface NotificationSettings {
  /** Ring the terminal bell (BEL, 0x07). */
  bell: boolean;
  /** Raise an OS notification (Windows toast, macOS Notification Center, notify-send). */
  desktop: boolean;
  /**
   * `unfocused`: only while the terminal is not focused, when that can be
   * told; when it cannot, as `always`. `always`: every time.
   */
  when: "unfocused" | "always";
  /** A finished turn notifies only when it took at least this long. */
  longTurnSeconds: number;
}

export const NOTIFICATIONS_OFF: NotificationSettings = {
  bell: false,
  desktop: false,
  when: "unfocused",
  longTurnSeconds: 30,
};

/** A repeat of the same event within this window is dropped. */
export const REPEAT_WINDOW_MS = 10_000;

export type AttentionEvent =
  | { kind: "approval"; tool: string }
  | { kind: "question" }
  | { kind: "turn-finished"; durationMs: number };

export type TerminalFocus = "focused" | "unfocused" | "unknown";

export interface DecisionInput {
  event: AttentionEvent;
  settings: NotificationSettings;
  /** The terminal UI is running with a terminal (not -p, not serve). */
  interactive: boolean;
  focus: TerminalFocus;
  now: number;
  /** When each event key last notified. */
  lastSent: ReadonlyMap<string, number>;
}

export interface Notice {
  key: string;
  bell: boolean;
  desktop: boolean;
  title: string;
  body: string;
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** A tool name as shown: printable, short, no path. */
function safeName(name: string): string {
  const clean = name.replace(/[^\w.:-]/g, "").slice(0, 60);
  return clean || "a tool";
}

function textOf(event: AttentionEvent): {
  key: string;
  title: string;
  body: string;
} {
  switch (event.kind) {
    case "approval":
      return {
        key: `approval:${safeName(event.tool)}`,
        title: "Continuous: approval needed",
        body: `${safeName(event.tool)} is waiting for your approval.`,
      };
    case "question":
      return {
        key: "question",
        title: "Continuous: question",
        body: "A question is waiting for your answer.",
      };
    case "turn-finished":
      return {
        key: "turn-finished",
        title: "Continuous: finished",
        body: `The turn finished after ${formatDuration(event.durationMs)}.`,
      };
  }
}

/** Whether to notify, and how. Pure: no clock, no I/O. */
export function decideNotification(input: DecisionInput): Notice | undefined {
  const { event, settings } = input;
  if (!settings.bell && !settings.desktop) return undefined;
  if (!input.interactive) return undefined;
  if (settings.when === "unfocused" && input.focus === "focused") {
    return undefined;
  }
  if (
    event.kind === "turn-finished" &&
    event.durationMs < settings.longTurnSeconds * 1000
  ) {
    return undefined;
  }
  const text = textOf(event);
  const last = input.lastSent.get(text.key);
  if (last !== undefined && input.now - last < REPEAT_WINDOW_MS) {
    return undefined;
  }
  return { ...text, bell: settings.bell, desktop: settings.desktop };
}

/** The `notifications` block of a parsed settings.json; anything unusable is off. */
export function parseNotificationSettings(raw: unknown): NotificationSettings {
  if (!raw || typeof raw !== "object") return NOTIFICATIONS_OFF;
  const r = raw as Record<string, unknown>;
  const seconds = r.longTurnSeconds;
  return {
    bell: r.bell === true,
    desktop: r.desktop === true,
    when: r.when === "always" ? "always" : "unfocused",
    longTurnSeconds:
      typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
        ? seconds
        : NOTIFICATIONS_OFF.longTurnSeconds,
  };
}

/** The setting in the person's own settings.json (the global directory); never a project's. */
export function loadNotificationSettings(
  cwd: string = process.cwd(),
  homeDir?: string,
): NotificationSettings {
  try {
    const dir = getGlobalDir(cwd, homeDir);
    if (!dir) return NOTIFICATIONS_OFF;
    const file = path.join(dir, "settings.json");
    if (!fs.existsSync(file)) return NOTIFICATIONS_OFF;
    return parseNotificationSettings(
      JSON.parse(fs.readFileSync(file, "utf-8"))?.notifications,
    );
  } catch (error) {
    logger.debug("Notification settings not read", { error });
    return NOTIFICATIONS_OFF;
  }
}

let settings: NotificationSettings | undefined;
let interactive = false;
const lastSent = new Map<string, number>();

/** Called by the terminal UI when it starts: notifications are only for it. */
export function enableAttentionNotifications(
  loaded: NotificationSettings = loadNotificationSettings(),
): void {
  settings = loaded;
  interactive = process.stdout.isTTY === true;
}

/** For tests. */
export function resetAttentionNotifications(): void {
  settings = undefined;
  interactive = false;
  lastSent.clear();
}

/**
 * The terminal's focus. Not detectable yet (focus reporting, DECSET 1004,
 * would put its replies in the input the UI reads), so `unfocused` acts as
 * `always`.
 */
function terminalFocus(): TerminalFocus {
  return "unknown";
}

/** Notify the person if their settings ask for it. Never throws. */
export function notifyPerson(
  event: AttentionEvent,
  io: {
    writeBell?: () => void;
    desktop?: (title: string, body: string) => void;
    now?: () => number;
  } = {},
): Notice | undefined {
  try {
    if (!settings) return undefined;
    const now = (io.now ?? Date.now)();
    const notice = decideNotification({
      event,
      settings,
      interactive,
      focus: terminalFocus(),
      now,
      lastSent,
    });
    if (!notice) return undefined;
    lastSent.set(notice.key, now);
    if (notice.bell) (io.writeBell ?? (() => process.stdout.write("\x07")))();
    if (notice.desktop) {
      (io.desktop ?? sendDesktopNotification)(notice.title, notice.body);
    }
    return notice;
  } catch (error) {
    logger.debug("Notification failed", { error });
    return undefined;
  }
}
