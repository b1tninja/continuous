/**
 * The retirement notice for the active model, at most once a day and never
 * after the user dismissed it (core/util/retirementNoticeState.ts). Offline:
 * the checked-in table, overridden by the lifecycle the user's own key last
 * returned. Returns the line to print, or undefined. Never blocks, never
 * throws.
 */
import { retirementNotice, type RetirementNotice } from "./modelRetirement.js";
import {
  dismissNotice,
  dueToday,
  liveFor,
  markShown,
  markWarned,
  readNoticeState,
} from "./retirementNoticeState.js";

export interface StartupInput {
  provider: string | undefined;
  model: string | undefined;
  /** Today, YYYY-MM-DD. */
  now?: string;
  /** For tests. */
  file?: string;
}

const today = (now?: string) => now ?? new Date().toISOString().slice(0, 10);

/** The current notice for a model, whether or not it was shown today. */
export function currentNotice(
  input: StartupInput,
): RetirementNotice | undefined {
  try {
    if (!input.model) return undefined;
    const live = liveFor(input.model, input.file);
    return retirementNotice({
      provider: input.provider,
      model: input.model,
      now: today(input.now),
      ...(live ? { live } : {}),
    });
  } catch {
    return undefined;
  }
}

/** The start-up line, marking it shown; undefined when none is due. */
export function startupRetirementLine(input: StartupInput): string | undefined {
  const n = currentNotice(input);
  if (!n || !dueToday(n.key, today(input.now), input.file)) return undefined;
  markShown(n.key, today(input.now), input.file);
  return `Warning: ${n.message} To hide this notice: continuous dismiss-notice ${n.model}`;
}

/** Dismiss the current notice for a model; true when there was one. */
export function dismissCurrentNotice(input: StartupInput): boolean {
  const n = currentNotice(input);
  if (!n) return false;
  dismissNotice(n.key, today(input.now), input.file);
  return true;
}

export interface ConfiguredModel {
  provider: string | undefined;
  model: string | undefined;
  /** The name the person gave the model in their config, for the message. */
  title?: string;
}

const modelKey = (m: ConfiguredModel) => `${m.provider}\u0000${m.model}`;

/** Each configured model once, in order; entries without a model id dropped. */
function unique<T extends ConfiguredModel>(models: T[]): T[] {
  const seen = new Set<string>();
  return models.filter((m) => {
    if (!m.model || seen.has(modelKey(m))) return false;
    seen.add(modelKey(m));
    return true;
  });
}

/**
 * The current notice of every configured model that has one, for the model
 * picker and Settings > Models. Not filtered by dismissal: a dismissal hides
 * the chip, while a list entry stays marked until the model is replaced.
 */
export function noticesFor(
  models: ConfiguredModel[],
  opts: { now?: string; file?: string } = {},
): { provider: string; model: string; notice: RetirementNotice }[] {
  const out: { provider: string; model: string; notice: RetirementNotice }[] =
    [];
  for (const m of unique(models)) {
    const notice = currentNotice({ ...m, ...opts });
    if (notice && m.provider && m.model) {
      out.push({ provider: m.provider, model: m.model, notice });
    }
  }
  return out;
}

/**
 * The config check: one warning per configured model whose notice was neither
 * dismissed nor warned about before, marked as warned so the next config load
 * stays quiet. A model listed under several roles or titles warns once; a
 * notice that changes (a new date, or "retiring" becoming "retired") warns
 * again. Never throws.
 */
export function configRetirementWarnings(
  models: ConfiguredModel[],
  opts: { now?: string; file?: string } = {},
): string[] {
  try {
    const state = readNoticeState(opts.file);
    const due: { key: string; message: string }[] = [];
    for (const m of unique(models)) {
      const n = currentNotice({ ...m, ...opts });
      if (!n || n.key in state.dismissed || n.key in state.warned) continue;
      if (due.some((d) => d.key === n.key)) continue;
      const titles = models
        .filter((o) => modelKey(o) === modelKey(m) && o.title)
        .map((o) => `"${o.title}"`);
      const who = titles.length
        ? `Model ${[...new Set(titles)].join(", ")}: `
        : "";
      due.push({ key: n.key, message: `${who}${n.message}` });
    }
    markWarned(
      due.map((d) => d.key),
      today(opts.now),
      opts.file,
    );
    return due.map((d) => d.message);
  } catch {
    return [];
  }
}
