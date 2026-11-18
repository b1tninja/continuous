import type { InboxEntry } from "core/tools/permissions/audit/listing";
import { canonicalRuleName } from "core/tools/permissions/names";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../../../../components/ui";
import type { EditorEnv } from "../EditableRules";
import { RuleChangeForm } from "../RuleChangeForm";
import { SAVED_TEXT } from "../useRuleChange";
import { AuditDetail } from "./AuditDetail";
import { AuditFilters, NO_FILTERS } from "./AuditFilters";
import { AuditRow } from "./AuditRow";
import { AuditEmpty, AuditError, AuditLoading, AuditOff } from "./AuditStates";
import { formatAge } from "./auditVocab";
import { useAuditPages } from "./useAuditPages";
import { useAuditStatus } from "./useAuditStatus";

interface Meta {
  hiddenOlder: number;
  maxAgeHours?: number;
  partial?: "bytes" | "rows";
}

const WHAT = "the inbox";

function AgeNote({ item }: { item: InboxEntry }) {
  return (
    <>
      <span>Asked {formatAge(item.ageMs)}</span>
      {item.possiblyEnded && (
        <span
          className="ml-1 inline-block rounded-sm border border-solid border-warning px-1 text-2xs leading-4 text-foreground"
          title="Nothing has been written to this ask's session for a while, so the session may have ended. Nothing is waiting on your answer if it has."
          data-testid="possibly-ended"
        >
          Possibly from an ended session
        </span>
      )}
    </>
  );
}

/**
 * Asks nobody has answered, oldest first. Asks older than 24 hours are behind
 * "Show older": a session that ended with an ask open looks like a live one,
 * and nothing records whether a session is still running, so an old ask whose
 * session has stopped writing says it may be from an ended session.
 * "Adopt as rule" opens the same editor as the rules: a dry run first, and the
 * editor's own confirmation for anything that loosens.
 */
export function AuditInbox({ env }: { env: EditorEnv }) {
  const status = useAuditStatus();
  const [agent, setAgent] = useState("");
  const [older, setOlder] = useState(false);
  const [open, setOpen] = useState<InboxEntry | undefined>();
  const [adopting, setAdopting] = useState<string | undefined>();
  const [saved, setSaved] = useState<string | undefined>();
  const opener = useRef<Element | null>(null);
  const page = useAuditPages<InboxEntry, Meta>(
    async (cursor, ideMessenger) => {
      const res = await ideMessenger.request("audit/inbox", {
        ...(agent ? { agent } : {}),
        ...(older ? { includeOlder: true } : {}),
        ...(cursor ? { cursor } : {}),
      });
      if (res.status !== "success") return undefined;
      const { items, nextCursor, ...meta } = res.content;
      return { items, nextCursor, meta };
    },
    [agent, older],
  );
  const [agents, setAgents] = useState<string[]>(["main"]);
  useEffect(() => {
    setAgents((old) => [
      ...new Set([
        ...old,
        ...page.items.flatMap((i) =>
          i.agent && i.agent.kind !== "main"
            ? [i.agent.role ?? i.agent.kind]
            : [],
        ),
      ]),
    ]);
  }, [page.items]);

  const hidden = page.meta?.hiddenOlder ?? 0;
  const empty = !page.loading && !page.error && page.items.length === 0;

  const adoptForm = (item: InboxEntry) => (
    <div className="mt-1">
      <RuleChangeForm
        mode={{
          kind: "add",
          decision: "allow",
          prefix: item.suggestedRule ?? `${canonicalRuleName(item.tool)}(`,
          example: item.suggestedRule ?? `${canonicalRuleName(item.tool)}(...)`,
        }}
        baseHash={env.baseHash}
        onSaved={(res) => {
          setAdopting(undefined);
          setSaved(SAVED_TEXT[res.result] ?? "Saved.");
          env.onChanged(SAVED_TEXT[res.result] ?? "Saved.");
        }}
        onCancel={() => setAdopting(undefined)}
      />
    </div>
  );

  return (
    <section
      aria-label="Inbox"
      data-testid="audit-inbox"
      className="flex min-w-0 flex-col"
    >
      <p className="mt-0 mb-2 text-2xs text-description-muted">
        Questions no one has answered, oldest first, with the agent that is
        waiting. Adopting a rule here does not answer the question: it saves a
        rule for next time.
      </p>
      {status && !status.enabled && <AuditOff status={status} />}
      <AuditFilters
        value={{ ...NO_FILTERS, agent }}
        onChange={(v) => setAgent(v.agent)}
        agents={agents}
        tools={[]}
        show={["agent"]}
      />
      <div role="status" aria-live="polite" data-testid="inbox-status">
        {saved && <p className="my-1 text-xs text-success">{saved}</p>}
      </div>
      {hidden > 0 && !older && (
        <div
          className="mb-2 flex flex-wrap items-center gap-2 text-xs"
          data-testid="inbox-hidden"
        >
          <span>
            {hidden} older {hidden === 1 ? "ask is" : "asks are"} hidden: asked
            more than {page.meta?.maxAgeHours ?? 24} hours ago.
          </span>
          <Button
            variant="outline"
            size="sm"
            className="min-h-6"
            onClick={() => setOlder(true)}
            data-testid="inbox-show-older"
          >
            Show older
          </Button>
        </div>
      )}
      {older && (
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
          <span>Showing asks of any age.</span>
          <Button
            variant="outline"
            size="sm"
            className="min-h-6"
            onClick={() => setOlder(false)}
            data-testid="inbox-hide-older"
          >
            Hide older
          </Button>
        </div>
      )}
      {page.loading && (
        <AuditLoading slow={page.slow} onRetry={page.reload} what={WHAT} />
      )}
      {page.error && <AuditError onRetry={page.reload} what={WHAT} />}
      {empty && (
        <AuditEmpty
          kind={
            status?.enabled === false
              ? "audit-off"
              : hidden > 0
                ? "inbox-older"
                : "inbox"
          }
          status={status}
        />
      )}
      {page.items.length > 0 && !page.error && (
        <ul className="m-0 flex flex-col gap-1 p-0" aria-label="Open asks">
          {page.items.map((item) => (
            <AuditRow
              key={`${item.session}/${item.callId}`}
              call={item}
              when={<AgeNote item={item} />}
              onOpen={() => {
                opener.current = document.activeElement;
                setOpen(item);
              }}
              extra={
                env.editable && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="min-h-6"
                    aria-label={`Adopt as rule: ${item.tool} ${item.summary}`}
                    aria-expanded={adopting === item.callId}
                    onClick={() => setAdopting(item.callId)}
                    data-testid={`adopt-${item.callId}`}
                  >
                    Adopt as rule
                  </Button>
                )
              }
              below={adopting === item.callId ? adoptForm(item) : undefined}
            />
          ))}
        </ul>
      )}
      {page.hasMore && (
        <div className="mt-2">
          <Button
            variant="outline"
            size="sm"
            className="min-h-6"
            disabled={page.loadingMore}
            onClick={page.more}
          >
            {page.loadingMore ? "Loading" : "Show more"}
          </Button>
        </div>
      )}
      {page.meta?.partial && (
        <p className="my-1 text-2xs text-description-muted">
          This is the newest part of a large trail: older asks were not read.
        </p>
      )}
      {open && (
        <AuditDetail
          session={open.session}
          callId={open.callId}
          onClose={() => {
            setOpen(undefined);
            const el = opener.current as HTMLElement | null;
            queueMicrotask(() => el?.focus?.());
          }}
        />
      )}
    </section>
  );
}
