/**
 * Warn when a configured Anthropic model is deprecated, retired or about to
 * retire. Two sources, the live one winning:
 *   - core/util/modelRetirements.generated.json, a checked-in table copied
 *     from Anthropic's deprecations page with its URL and fetch date;
 *   - `lifecycle`, `deprecated_at` and `retires_at` from the user's own
 *     `GET /v1/models` (core/util/anthropicSurfaceTest.ts), kept locally.
 * The dates apply to Anthropic-operated platforms only: Bedrock and
 * Google-managed Vertex set their own schedules, so only provider
 * "anthropic" is matched against the table. Provider "openai" gets a notice
 * only from its own live answer (`shutdown_date` from OpenAI's models API,
 * read by the selected model's background refresh). Pure and GUI-safe: no
 * I/O, the caller passes `now`.
 * A notice is information; nothing is blocked.
 */
import data from "./modelRetirements.generated.json";

export type RetirementState = "active" | "deprecated" | "retired";
export type RetirementSeverity =
  "retired" | "retiring" | "deprecated" | "possible";

export interface RetirementRow {
  id: string;
  /** Case-insensitive regular expression over the model id. */
  match: string;
  provider: string;
  state: RetirementState;
  deprecatedAt: string | null;
  /** YYYY-MM-DD, or null when "to be announced". */
  retiresAt: string | null;
  /** The date is Anthropic's "not sooner than", not a retirement notice. */
  notSoonerThan: boolean;
  replacement: string | null;
  source: string;
  fetchedOn: string;
  note?: string;
}

export const RETIREMENT_ROWS = (data as { rows: RetirementRow[] }).rows;

/** Anthropic gives at least this many days' notice; we warn inside the same window. */
export const WARN_WINDOW_DAYS = 60;

/** The lifecycle fields of one model in a live `GET /v1/models`. */
export interface LiveLifecycle {
  lifecycle?: string;
  deprecatedAt?: string;
  retiresAt?: string;
}

export interface RetirementNotice {
  model: string;
  severity: RetirementSeverity;
  retiresAt?: string;
  deprecatedAt?: string;
  /** Days from `now` to `retiresAt`; negative once past. */
  daysLeft?: number;
  replacement?: string;
  /** "live" when the user's own key said so, otherwise the checked-in table. */
  from: "live" | "table";
  sourceUrl?: string;
  fetchedOn?: string;
  message: string;
  /** Identity for "shown today" and "dismissed": changes with the dates or the severity. */
  key: string;
}

export function findRetirementRow(
  provider: string | undefined,
  model: string | undefined,
  rows: RetirementRow[] = RETIREMENT_ROWS,
): RetirementRow | undefined {
  if (provider !== "anthropic" || !model) return undefined;
  return rows.find((r) => r.provider === provider && matches(r.match, model));
}

function matches(pattern: string, model: string): boolean {
  try {
    return new RegExp(pattern, "i").test(model);
  } catch {
    return false;
  }
}

function dayNumber(iso: string): number {
  return Math.floor(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / 86_400_000);
}

export interface RetirementInput {
  provider: string | undefined;
  model: string | undefined;
  /** Today, YYYY-MM-DD. */
  now: string;
  live?: LiveLifecycle;
  rows?: RetirementRow[];
}

interface Facts {
  state: RetirementState;
  retiresAt?: string;
  deprecatedAt?: string;
  notSoonerThan: boolean;
}

function mergeFacts(
  row: RetirementRow | undefined,
  live?: LiveLifecycle,
): Facts {
  const liveState =
    live?.lifecycle === "deprecated" || live?.lifecycle === "retired"
      ? live.lifecycle
      : live?.lifecycle === "active"
        ? "active"
        : undefined;
  const retiresAt =
    live?.retiresAt?.slice(0, 10) ?? row?.retiresAt ?? undefined;
  return {
    state: liveState ?? row?.state ?? "active",
    ...(retiresAt ? { retiresAt } : {}),
    ...((live?.deprecatedAt?.slice(0, 10) ?? row?.deprecatedAt)
      ? { deprecatedAt: live?.deprecatedAt?.slice(0, 10) ?? row?.deprecatedAt! }
      : {}),
    // A date from the user's own key is a real date, not a "not sooner than".
    notSoonerThan: live?.retiresAt ? false : (row?.notSoonerThan ?? false),
  };
}

function severityOf(
  f: Facts,
  daysLeft: number | undefined,
): RetirementSeverity | undefined {
  const past = daysLeft !== undefined && daysLeft <= 0;
  if (
    f.state === "retired" ||
    (past && !f.notSoonerThan && f.state !== "active")
  ) {
    return "retired";
  }
  if (f.retiresAt && !f.notSoonerThan && daysLeft !== undefined) {
    if (past) return "retired";
    if (daysLeft <= WARN_WINDOW_DAYS || f.state === "deprecated")
      return "retiring";
  }
  if (f.state === "deprecated") return "deprecated";
  if (
    f.notSoonerThan &&
    daysLeft !== undefined &&
    daysLeft >= 0 &&
    daysLeft <= WARN_WINDOW_DAYS
  ) {
    return "possible";
  }
  return undefined;
}

function sentence(
  model: string,
  sev: RetirementSeverity,
  f: Facts,
  daysLeft: number | undefined,
  replacement: string | undefined,
): string {
  const tail = replacement ? ` Suggested replacement: ${replacement}.` : "";
  switch (sev) {
    case "retired":
      return `${model} was retired${f.retiresAt ? ` on ${f.retiresAt}` : ""} and requests to it fail.${tail}`;
    case "retiring":
      return `${model} is deprecated and retires on ${f.retiresAt} (${daysLeft} day${daysLeft === 1 ? "" : "s"}).${tail}`;
    case "deprecated":
      return `${model} is deprecated; no retirement date is announced yet.${tail}`;
    case "possible":
      return `${model} may retire from ${f.retiresAt} (Anthropic's earliest date; no retirement is announced yet).${tail}`;
  }
}

/** The notice for one configured model, or undefined when there is nothing to say. */
export function retirementNotice(
  input: RetirementInput,
): RetirementNotice | undefined {
  const { model } = input;
  if (!model) return undefined;
  if (input.provider !== "anthropic") {
    if (input.provider !== "openai" || !input.live) return undefined;
  }
  const row = findRetirementRow(input.provider, model, input.rows);
  if (!row && !input.live) return undefined;
  const f = mergeFacts(row, input.live);
  const daysLeft = f.retiresAt
    ? dayNumber(f.retiresAt) - dayNumber(input.now)
    : undefined;
  const severity = severityOf(f, daysLeft);
  if (!severity) return undefined;
  const replacement = row?.replacement ?? undefined;
  const from = input.live ? "live" : "table";
  return {
    model,
    severity,
    ...(f.retiresAt ? { retiresAt: f.retiresAt } : {}),
    ...(f.deprecatedAt ? { deprecatedAt: f.deprecatedAt } : {}),
    ...(daysLeft === undefined ? {} : { daysLeft }),
    ...(replacement ? { replacement } : {}),
    from,
    ...(from === "table" && row
      ? { sourceUrl: row.source, fetchedOn: row.fetchedOn }
      : {}),
    message: sentence(model, severity, f, daysLeft, replacement),
    key: `${model}@${f.retiresAt ?? "-"}:${severity}`,
  };
}

/**
 * Lifecycle facts from a provider's model list as the person fetched it
 * (`deprecated` and `retiresAt` of core/llm/fetchModels.ts), in the shape the
 * notices read. Only the providers whose notices read live facts (Anthropic
 * and OpenAI). A model the list reports active is kept as "active", so a
 * stale deprecation recorded earlier does not linger; a model whose entry
 * carries no lifecycle field and no date yields nothing.
 */
export function liveFromFetched(
  provider: string,
  fetched: {
    modelId?: string;
    name: string;
    deprecated?: boolean;
    retiresAt?: string;
  }[],
): { model: string; live: LiveLifecycle }[] {
  if (provider !== "anthropic" && provider !== "openai") return [];
  const out: { model: string; live: LiveLifecycle }[] = [];
  for (const m of fetched) {
    const model = m.modelId ?? m.name;
    if (!model || (m.deprecated === undefined && !m.retiresAt)) continue;
    out.push({
      model,
      live: {
        ...(m.deprecated === undefined
          ? {}
          : { lifecycle: m.deprecated ? "deprecated" : "active" }),
        ...(m.retiresAt ? { retiresAt: m.retiresAt } : {}),
      },
    });
  }
  return out;
}
