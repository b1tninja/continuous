import type {
  AuditOverview,
  MostAskedRow,
  RuleUse,
} from "core/tools/permissions/audit/auditOverview";
import { Button } from "../../../../components/ui";
import { DecisionChip } from "./badges";

/** What the person reviews in the rule editor: the rule and the way they answered. */
export interface ReviewRequest {
  rule: string;
  decision: "allow" | "deny";
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One line under a rule: how often it asked and matched, and the unused hint. */
export function RuleUseNote({
  use,
  coverageDays,
}: {
  use: RuleUse;
  coverageDays: number;
}) {
  return (
    <div className="text-2xs text-description-muted" data-testid="rule-use">
      <span>
        Asked {plural(use.asked, "time")}, matched {plural(use.matched, "time")}{" "}
        in 30 days.
      </span>
      {use.unused && (
        <span data-testid="rule-unused">
          {" "}
          No use in the {plural(coverageDays, "day")} the audit covers. This is
          only a hint: nothing is removed or changed for you.
        </span>
      )}
    </div>
  );
}

function MostAskedItem({
  row,
  canEdit,
  onReview,
}: {
  row: MostAskedRow;
  canEdit: boolean;
  onReview: (r: ReviewRequest) => void;
}) {
  return (
    <li
      className="list-none rounded-sm border border-solid border-border px-2 py-1"
      data-testid="most-asked-item"
    >
      <div className="flex flex-wrap items-center gap-1">
        <DecisionChip decision={row.answer === "allow" ? "allow" : "deny"} />
        <span className="text-2xs text-description">
          Asked {plural(row.asks, "time")}; you answered{" "}
          {row.answer === "allow" ? "allow" : "deny"} all {row.answered}{" "}
          {row.answered === 1 ? "time" : "times"}.
        </span>
      </div>
      <code className="mt-1 block font-mono text-2xs break-all">
        {row.rule}
      </code>
      {canEdit && (
        <div className="mt-1 flex flex-wrap gap-1">
          <Button
            variant="outline"
            size="sm"
            className="min-h-6"
            aria-label={`Review rule ${row.rule} in the rule editor`}
            onClick={() => onReview({ rule: row.rule, decision: row.answer })}
          >
            Review in the editor
          </Button>
        </div>
      )}
    </li>
  );
}

/**
 * The most-asked list: asks the person answered the same way every time, for
 * a rule that passed the guards of `continuous audit suggest`. Nothing is
 * saved from here: Review opens the rule editor with the rule filled in, and
 * the editor shows the diff, asks for the confirmations and keeps Undo.
 */
export function AuditOverviewPanel({
  overview,
  loading,
  slow,
  error,
  canEdit,
  onReview,
  onRetry,
}: {
  overview?: AuditOverview;
  loading: boolean;
  slow: boolean;
  error: boolean;
  canEdit: boolean;
  onReview: (r: ReviewRequest) => void;
  onRetry: () => void;
}) {
  return (
    <section
      aria-label="Most asked"
      data-testid="audit-overview"
      className="mb-3 min-w-0"
    >
      <h5 className="my-1 text-xs font-semibold">Most asked in 30 days</h5>
      {loading && (
        <p
          role="status"
          aria-live="polite"
          className="my-1 text-2xs text-description-muted"
          data-testid="audit-loading"
        >
          {slow
            ? "Reading the audit figures is taking longer than usual. The rules below are not affected."
            : "Reading the audit figures"}
          {slow && (
            <>
              {" "}
              <Button
                variant="outline"
                size="sm"
                className="min-h-6"
                onClick={onRetry}
                data-testid="audit-retry"
              >
                Try again
              </Button>
            </>
          )}
        </p>
      )}
      {error && (
        <p
          role="status"
          className="my-1 flex flex-wrap items-center gap-1 text-2xs text-description-muted"
          data-testid="audit-error"
        >
          The audit figures could not be read. Your rules are shown without
          them.
          <Button
            variant="outline"
            size="sm"
            className="min-h-6"
            onClick={onRetry}
            data-testid="audit-retry"
          >
            Retry
          </Button>
        </p>
      )}
      {overview?.state === "empty" && (
        <p
          className="my-1 text-2xs text-description-muted"
          data-testid="audit-empty"
        >
          There is no audit history yet, so there is nothing to count.
          {overview.partial ? " It is being read now." : ""}
        </p>
      )}
      {overview?.state === "ready" && !!overview.idgafObjections && (
        <p
          className="my-1 text-2xs text-description-muted"
          data-testid="audit-idgaf-objections"
        >
          IDGAF ran {plural(overview.idgafObjections, "call")} in the last 30
          days that a rule or guard would have refused or asked about. Each is
          in the audit trail with what would have stopped it.
        </p>
      )}
      {overview?.state === "ready" && overview.mostAsked.length === 0 && (
        <p
          className="my-1 text-2xs text-description-muted"
          data-testid="most-asked-empty"
        >
          No ask has been answered the same way three times or more that a rule
          could safely settle.
        </p>
      )}
      {overview?.state === "ready" && overview.mostAsked.length > 0 && (
        <>
          <p className="my-1 text-2xs text-description-muted">
            Asks you answered the same way every time. Review opens the rule
            editor with the rule filled in; nothing is saved until you save
            there. The same list is in the terminal:{" "}
            <code className="font-mono">continuous audit suggest</code>
          </p>
          <ul className="m-0 flex flex-col gap-1 p-0">
            {overview.mostAsked.map((row) => (
              <MostAskedItem
                key={`${row.answer}:${row.rule}`}
                row={row}
                canEdit={canEdit}
                onReview={onReview}
              />
            ))}
          </ul>
        </>
      )}
      {overview?.state === "ready" &&
        (overview.partial || overview.guardsCut) && (
          <p
            className="my-1 text-2xs text-description-muted"
            data-testid="audit-partial"
          >
            {overview.partial
              ? "The audit is still being read, so counts may be low. "
              : ""}
            {overview.guardsCut
              ? "Some asks were not checked in time; more may appear the next time you open this page."
              : ""}
          </p>
        )}
    </section>
  );
}
