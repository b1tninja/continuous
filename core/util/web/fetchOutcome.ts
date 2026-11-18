import type { ContextItem } from "../..";
import { FetchDeadlineError } from "../boundedBody";
import {
  FetchRefusedError,
  provenanceLine,
  type FetchRecord,
} from "../fetchRecord";
import {
  RedirectLimitError,
  recordOfError,
  requestUrlOfError,
} from "../guardedFetch";
import { lastResolveFailure } from "../networkAddress";
import {
  classifyNetworkError,
  needsCookiesOutcome,
  notTextOutcome,
  outcomeForNetworkFailure,
  outcomeForStatus,
  refusedOutcome,
  type StatusInput,
  type WebOutcome,
  type WebOutcomeCode,
} from "./outcomes";

/**
 * From what `guardedWebRequest()` threw or returned to a typed outcome
 * (plans/research/web-fetch-large-pages-and-policy.md, section 6.2, row
 * WB41). Every web path maps through here: `getUrlContextItems` throws a
 * `WebOutcomeError`, `fetch_url_content` (and so the CLI `Fetch`) turns it
 * into a normal tool result with the code as `status`, and `@url` shows the
 * outcome's first sentence to the person.
 *
 * No response body reaches an outcome: the guard does not read the body of
 * a status of 400 or more, and the texts take only the status, the host, the
 * path and two cleaned header values (`WWW-Authenticate`, `Retry-After`).
 */

/** A fetch that ended in an outcome other than a page. */
export class WebOutcomeError extends Error {
  constructor(
    readonly outcome: WebOutcome,
    /** The request's record when one was made, for the provenance line. */
    readonly record?: FetchRecord,
  ) {
    // What a person reads for `@url`: what happened, without the advice to the model
    super(outcome.summary);
    this.name = "WebOutcomeError";
  }
}

/** The content type was refused before the body was read. */
export class NotTextRefusal extends FetchRefusedError {
  constructor(readonly mediaType: string) {
    super(`Refused: the response is ${mediaType || "binary data"}, not text`);
    this.name = "NotTextRefusal";
  }
}

export interface OutcomeContext {
  /** The URL the fetch started from. */
  url: URL;
  /** The deadline, for the `timeout` text. */
  deadlineMs: number;
}

/** A request was made and something came back, so the provenance line belongs ahead of the text. */
function requestMade(record: FetchRecord | undefined): record is FetchRecord {
  return !!record && record.hops.length > 0;
}

/**
 * The outcome for an error thrown by `guardedWebRequest()` or by the URL
 * checks ahead of it, or undefined when the error is not one this maps (it
 * is then rethrown as it was).
 */
export function outcomeForError(
  error: unknown,
  ctx: OutcomeContext,
): WebOutcome | undefined {
  if (error instanceof WebOutcomeError) return error.outcome;
  const failedUrl = requestUrlOfError(error) ?? ctx.url;
  const host = failedUrl.host;
  if (error instanceof NotTextRefusal) {
    const record = recordOfError(error);
    return notTextOutcome({
      host: record?.finalUrl ? new URL(record.finalUrl).host : host,
      mediaType: error.mediaType,
      httpStatus: record?.status,
    });
  }
  if (error instanceof RedirectLimitError && error.cookieHops > 0) {
    return needsCookiesOutcome({ host: error.host, hops: error.hops });
  }
  if (error instanceof FetchDeadlineError) {
    return outcomeForNetworkFailure(
      { kind: "timeout" },
      { host, deadlineSeconds: (error.ms ?? ctx.deadlineMs) / 1000 },
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof FetchRefusedError || /^Refused\b/.test(message)) {
    return refusedOutcome({ message, host });
  }
  const failure = classifyNetworkError(
    error,
    lastResolveFailure(failedUrl.hostname),
  );
  if (failure) {
    return outcomeForNetworkFailure(failure, {
      host:
        failure.kind === "dns" || failure.kind === "dns-temporary"
          ? failedUrl.hostname
          : host,
      deadlineSeconds: ctx.deadlineMs / 1000,
    });
  }
  return undefined;
}

/**
 * The error to throw for what a fetch threw: a `WebOutcomeError` carrying the
 * record when the error maps to an outcome, else the error itself.
 */
export function toOutcomeError(error: unknown, ctx: OutcomeContext): unknown {
  if (error instanceof WebOutcomeError) return error;
  const outcome = outcomeForError(error, ctx);
  return outcome ? new WebOutcomeError(outcome, recordOfError(error)) : error;
}

/** The outcome for a response that is not 2xx, with its record. */
export function statusOutcomeError(
  input: StatusInput,
  record: FetchRecord,
): WebOutcomeError {
  return new WebOutcomeError(outcomeForStatus(input), record);
}

/** The name of a tool result item that is an outcome rather than a page. */
export const OUTCOME_ITEM_NAME = "Web fetch outcome";

/** The provenance line (when a request was made), a blank line, then the outcome's text. */
export function outcomeContent(
  outcome: WebOutcome,
  record?: FetchRecord,
): string {
  return requestMade(record)
    ? `${provenanceLine(record)}\n\n${outcome.text}`
    : outcome.text;
}

/** The tool result for an outcome: one item, its code as `status`. */
export function outcomeItem(
  outcome: WebOutcome,
  record: FetchRecord | undefined,
  url: string,
): ContextItem & { status: WebOutcomeCode } {
  const where = record?.finalUrl ?? url;
  return {
    name: OUTCOME_ITEM_NAME,
    description: where,
    content: outcomeContent(outcome, record),
    status: outcome.code,
    uri: { type: "url", value: where },
  };
}
