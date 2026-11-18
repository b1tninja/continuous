/**
 * Local state for retirement notices (core/util/modelRetirement.ts), in
 * `retirement-notices.json` under the global folder: which notice was shown
 * today, which the user dismissed, and the lifecycle fields the user's own
 * key last returned per model. No key, no endpoint, only model ids and dates.
 * Every function takes the file so tests never touch the real folder, and a
 * missing or unreadable file reads as empty: a notice is never blocked by it.
 */
import fs from "node:fs";
import path from "node:path";
import type { LiveLifecycle } from "./modelRetirement.js";
import { getContinueGlobalPath } from "./paths.js";

export interface NoticeState {
  /** notice key -> YYYY-MM-DD it was last shown. */
  shown: Record<string, string>;
  /** notice key -> YYYY-MM-DD it was dismissed. */
  dismissed: Record<string, string>;
  /** model id -> lifecycle from the user's own `GET /v1/models`, and the day. */
  live: Record<string, LiveLifecycle & { readOn: string }>;
  /**
   * notice key -> YYYY-MM-DD the config check last warned about it. Once per
   * key: the key changes with the date or the severity, so "retiring" and then
   * "retired" each warn once.
   */
  warned: Record<string, string>;
}

export function noticeStatePath(): string {
  return path.join(getContinueGlobalPath(), "retirement-notices.json");
}

export function readNoticeState(file = noticeStatePath()): NoticeState {
  try {
    const p = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<NoticeState>;
    return {
      shown: p.shown ?? {},
      dismissed: p.dismissed ?? {},
      live: p.live ?? {},
      warned: p.warned ?? {},
    };
  } catch {
    return { shown: {}, dismissed: {}, live: {}, warned: {} };
  }
}

function write(state: NoticeState, file: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
  } catch {
    // Read-only home or full disk: the notice just shows again.
  }
}

export function isDismissed(key: string, file = noticeStatePath()): boolean {
  return key in readNoticeState(file).dismissed;
}

/** True when the notice was neither dismissed nor shown on `today`. */
export function dueToday(
  key: string,
  today: string,
  file = noticeStatePath(),
): boolean {
  const s = readNoticeState(file);
  return !(key in s.dismissed) && s.shown[key] !== today;
}

export function markShown(
  key: string,
  today: string,
  file = noticeStatePath(),
): void {
  const s = readNoticeState(file);
  s.shown[key] = today;
  write(s, file);
}

export function dismissNotice(
  key: string,
  today: string,
  file = noticeStatePath(),
): void {
  const s = readNoticeState(file);
  s.dismissed[key] = today;
  write(s, file);
}

export function recordLive(
  model: string,
  live: LiveLifecycle,
  today: string,
  file = noticeStatePath(),
): void {
  const s = readNoticeState(file);
  s.live[model] = { ...live, readOn: today };
  write(s, file);
}

/**
 * Several models' lifecycle in one read and one write, e.g. from a model list
 * the person fetched. Unchanged entries keep their `readOn`; nothing is
 * written when nothing changed.
 */
export function recordLiveMany(
  entries: { model: string; live: LiveLifecycle }[],
  today: string,
  file = noticeStatePath(),
): void {
  if (entries.length === 0) return;
  const s = readNoticeState(file);
  let changed = false;
  for (const { model, live } of entries) {
    const before = s.live[model];
    if (
      before &&
      before.lifecycle === live.lifecycle &&
      before.deprecatedAt === live.deprecatedAt &&
      before.retiresAt === live.retiresAt
    ) {
      continue;
    }
    s.live[model] = { ...live, readOn: today };
    changed = true;
  }
  if (changed) write(s, file);
}

/** Marks the keys the config check warned about; one write. */
export function markWarned(
  keys: string[],
  today: string,
  file = noticeStatePath(),
): void {
  if (keys.length === 0) return;
  const s = readNoticeState(file);
  for (const k of keys) s.warned[k] = today;
  write(s, file);
}

export function liveFor(
  model: string,
  file = noticeStatePath(),
): LiveLifecycle | undefined {
  const l = readNoticeState(file).live[model];
  if (!l) return undefined;
  const { lifecycle, deprecatedAt, retiresAt } = l;
  return { lifecycle, deprecatedAt, retiresAt };
}
