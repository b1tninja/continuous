import { XMarkIcon } from "@heroicons/react/24/outline";
import type { CallDetail } from "core/tools/permissions/audit/listing";
import { useContext, useEffect, useRef, useState } from "react";
import { Button } from "../../../../../components/ui";
import { IdeMessengerContext } from "../../../../../context/IdeMessenger";
import { DecisionChip } from "../badges";
import { AgentChip, ByChip } from "./AuditChips";
import { formatTime } from "./auditVocab";

type Load =
  | { state: "loading" }
  | { state: "error" }
  | { state: "gone" }
  | { state: "ok"; call: CallDetail };

function Field({ label, children }: { label: string; children: string }) {
  return (
    <div className="flex flex-wrap gap-x-1 text-2xs">
      <dt className="text-description-muted">{label}</dt>
      <dd className="m-0 break-all">{children}</dd>
    </div>
  );
}

function Outcome({ outcome }: { outcome: CallDetail["outcome"] }) {
  if (!outcome) {
    return (
      <p
        className="m-0 text-2xs text-description-muted"
        data-testid="no-outcome"
      >
        No outcome was recorded. The call was refused, is still waiting for an
        answer, or its session ended first.
      </p>
    );
  }
  return (
    <dl className="m-0 flex flex-col gap-0.5" data-testid="outcome">
      <Field label="Ran">{outcome.ran ? "Yes" : "No"}</Field>
      {outcome.exit !== undefined && (
        <Field label="Exit code">{String(outcome.exit)}</Field>
      )}
      {outcome.durMs !== undefined && (
        <Field label="Took">{`${outcome.durMs} ms`}</Field>
      )}
      {outcome.outBytes !== undefined && (
        <Field label="Output">{`${outcome.outBytes} bytes (not stored)`}</Field>
      )}
      {outcome.errSig && <Field label="First error">{outcome.errSig}</Field>}
      {outcome.changed?.length ? (
        <Field label="Changed">{outcome.changed.join(", ")}</Field>
      ) : null}
      <Field label="At">{formatTime(outcome.ts)}</Field>
    </dl>
  );
}

function Body({ call }: { call: CallDetail }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1">
        <DecisionChip decision={call.policy} />
        <ByChip by={call.by} />
        <AgentChip agent={call.agent} />
      </div>
      <section aria-label="Arguments">
        <h5 className="my-1 text-xs font-semibold">What it was asked to do</h5>
        <pre
          className="m-0 max-h-48 overflow-auto rounded-sm border border-solid border-border bg-input p-1 font-mono text-2xs break-all whitespace-pre-wrap"
          data-testid="detail-args"
        >
          {call.argsMasked}
        </pre>
        <p className="my-1 text-2xs text-description-muted">
          Secrets are masked before anything is written: a masked part reads
          like «secret».
          {call.maskedKinds?.length
            ? ` Masked here: ${call.maskedKinds.join(", ")}.`
            : ""}
        </p>
      </section>
      <section aria-label="Decisions">
        <h5 className="my-1 text-xs font-semibold">What decided it</h5>
        <ol className="m-0 flex flex-col gap-1 pl-0">
          {call.decisions.map((d, i) => (
            <li
              key={i}
              className="list-none rounded-sm border border-solid border-border px-2 py-1"
              data-testid="detail-decision"
            >
              <div className="flex flex-wrap items-center gap-1">
                <DecisionChip decision={d.policy} />
                <ByChip by={d.by} />
                <span className="text-2xs text-description-muted">
                  {formatTime(d.ts)}
                </span>
              </div>
              {d.reason && <p className="my-1 text-xs">{d.reason}</p>}
              <dl className="m-0 flex flex-col gap-0.5">
                {d.rule && <Field label="Rule">{d.rule}</Field>}
                {d.source && <Field label="Source">{d.source}</Field>}
                {d.level && <Field label="Level">{d.level}</Field>}
                {d.reviewerModel && (
                  <Field label="Reviewer model">{d.reviewerModel}</Field>
                )}
              </dl>
            </li>
          ))}
        </ol>
      </section>
      <section aria-label="Outcome">
        <h5 className="my-1 text-xs font-semibold">What happened</h5>
        <Outcome outcome={call.outcome} />
      </section>
      <p className="m-0 text-2xs break-all text-description-muted">
        Session {call.session}, call {call.callId}
      </p>
    </div>
  );
}

/**
 * The whole masked record of one call, in a panel beside the list. Escape or
 * Close shuts it and focus goes back to the row's button.
 */
export function AuditDetail({
  session,
  callId,
  onClose,
}: {
  session: string;
  callId: string;
  onClose: () => void;
}) {
  const ideMessenger = useContext(IdeMessengerContext);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [tries, setTries] = useState(0);
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoad({ state: "loading" });
    ideMessenger
      .request("audit/get", { session, callId })
      .then((res) => {
        if (cancelled) return;
        if (res.status !== "success") setLoad({ state: "error" });
        else if (!res.content) setLoad({ state: "gone" });
        else setLoad({ state: "ok", call: res.content });
      })
      .catch(() => !cancelled && setLoad({ state: "error" }));
    return () => {
      cancelled = true;
    };
  }, [ideMessenger, session, callId, tries]);

  useEffect(() => {
    close.current?.focus();
  }, []);

  return (
    <aside
      role="dialog"
      aria-label={`Call details for ${callId}`}
      data-testid="audit-detail"
      className="fixed inset-y-0 right-0 z-50 box-border flex w-full max-w-sm flex-col gap-2 overflow-auto border-0 border-l border-solid border-border bg-background p-3 shadow-lg"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <h4 className="m-0 text-sm font-semibold">Call details</h4>
        <Button
          ref={close}
          variant="outline"
          size="sm"
          className="min-h-6 min-w-6"
          aria-label="Close call details"
          data-testid="audit-detail-close"
          onClick={onClose}
        >
          <XMarkIcon className="h-3 w-3" aria-hidden="true" />
        </Button>
      </div>
      {load.state === "loading" && (
        <p role="status" className="m-0 text-xs">
          Reading the record
        </p>
      )}
      {load.state === "error" && (
        <div role="alert" className="flex flex-col items-start gap-1 text-xs">
          <span>The record could not be read.</span>
          <Button
            variant="outline"
            size="sm"
            className="min-h-6"
            onClick={() => setTries((n) => n + 1)}
          >
            Retry
          </Button>
        </div>
      )}
      {load.state === "gone" && (
        <p role="status" className="m-0 text-xs" data-testid="detail-gone">
          This call is no longer in the part of the audit trail that is read:
          its file was pruned or is older than 90 days.
        </p>
      )}
      {load.state === "ok" && <Body call={load.call} />}
    </aside>
  );
}
