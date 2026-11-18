import type { AuditStatus } from "core/tools/permissions/audit/listingHandlers";
import { Button } from "../../../../../components/ui";
import { howToTurnOn } from "./auditVocab";

/** Grey rows where the calls will be, then the slow line with Try again. */
export function AuditLoading({
  slow,
  onRetry,
  what,
}: {
  slow: boolean;
  onRetry: () => void;
  what: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy={!slow}
      data-testid="audit-loading"
      className="flex flex-col gap-2"
    >
      <span className="sr-only">Reading {what}</span>
      <div className="flex flex-col gap-1" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-10 w-full animate-pulse rounded-sm bg-lightgray/20"
          />
        ))}
      </div>
      {slow && (
        <div data-testid="audit-slow" className="text-xs">
          <p className="my-1">
            Reading {what} is taking longer than usual. It comes from the audit
            files on this computer.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="min-h-6"
            onClick={onRetry}
            data-testid="audit-retry"
          >
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}

/** The read failed: say so, and that this is not an empty list. */
export function AuditError({
  onRetry,
  what,
}: {
  onRetry: () => void;
  what: string;
}) {
  return (
    <div
      role="alert"
      data-testid="audit-error"
      className="flex flex-col items-start gap-1 rounded-sm border border-solid border-error px-2 py-1 text-xs"
    >
      <span>
        {what[0].toUpperCase() + what.slice(1)} could not be read. This is not
        an empty list: nothing was loaded.
      </span>
      <Button
        variant="outline"
        size="sm"
        className="min-h-6"
        onClick={onRetry}
        data-testid="audit-retry"
      >
        Retry
      </Button>
    </div>
  );
}

/** The trail is off: say so and how to turn it on. Shown above whatever older records exist. */
export function AuditOff({ status }: { status: AuditStatus }) {
  return (
    <div
      role="status"
      data-testid="audit-off"
      className="mb-2 rounded-sm border border-solid border-warning px-2 py-1 text-xs"
    >
      <strong>The audit trail is off.</strong> New calls are not being recorded.{" "}
      {howToTurnOn(status)}
    </div>
  );
}

export type EmptyKind =
  "audit-off" | "none" | "filtered" | "reviewer" | "inbox" | "inbox-older";

const EMPTY_TEXT: Record<EmptyKind, { title: string; body: string }> = {
  "audit-off": {
    title: "Nothing to show: the audit trail is off",
    body: "Calls are not being recorded, so there is no list to read.",
  },
  none: {
    title: "No calls recorded yet",
    body: "Each time the agent runs a tool, the call and what decided it are written here. Nothing has been recorded on this computer in the last 90 days.",
  },
  filtered: {
    title: "No calls match these filters",
    body: "Change or clear a filter to see more.",
  },
  reviewer: {
    title: "No call was decided by a reviewer",
    body: "Choose a reviewer model and use the Automatic level, and its decisions are listed here with its reason. Until then your rules and you decide.",
  },
  inbox: {
    title: "Nothing is waiting for you",
    body: "Asks that nobody has answered appear here, oldest first, with the agent that is waiting.",
  },
  "inbox-older": {
    title: "Nothing recent is waiting for you",
    body: "Every open ask is older than 24 hours.",
  },
};

export function AuditEmpty({
  kind,
  status,
  onClear,
}: {
  kind: EmptyKind;
  status?: AuditStatus;
  onClear?: () => void;
}) {
  const t = EMPTY_TEXT[kind];
  return (
    <div
      data-testid={`audit-empty-${kind}`}
      className="flex flex-col items-start gap-1 rounded-sm border border-solid border-border px-2 py-2 text-xs"
    >
      <strong>{t.title}</strong>
      <span className="text-description-muted">{t.body}</span>
      {kind === "audit-off" && status && (
        <span className="text-description-muted">{howToTurnOn(status)}</span>
      )}
      {kind === "filtered" && onClear && (
        <Button
          variant="outline"
          size="sm"
          className="min-h-6"
          onClick={onClear}
          data-testid="audit-clear-filters"
        >
          Clear filters
        </Button>
      )}
    </div>
  );
}
