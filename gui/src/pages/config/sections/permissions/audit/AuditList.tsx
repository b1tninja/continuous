import type {
  AuditFacets,
  ListedCall,
} from "core/tools/permissions/audit/listing";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../../../../components/ui";
import { AuditDetail } from "./AuditDetail";
import {
  AuditFilters,
  NO_FILTERS,
  type AuditFilterValues,
} from "./AuditFilters";
import { AuditRow } from "./AuditRow";
import {
  AuditEmpty,
  AuditError,
  AuditLoading,
  AuditOff,
  type EmptyKind,
} from "./AuditStates";
import { useAuditPages } from "./useAuditPages";
import { useAuditStatus } from "./useAuditStatus";

interface Meta {
  facets: AuditFacets;
  partial?: "bytes" | "rows";
}

const WHAT = "the audit list";

function emptyKind(
  filters: AuditFilterValues,
  enabled: boolean | undefined,
): EmptyKind {
  if (filters.decision === "reviewer") return "reviewer";
  if (filters.agent || filters.decision || filters.tool) return "filtered";
  return enabled === false ? "audit-off" : "none";
}

/** Keep every option seen so far, so choosing a filter does not remove the others. */
function useFacets(meta: Meta | undefined): AuditFacets {
  const [facets, setFacets] = useState<AuditFacets>({ tools: [], agents: [] });
  useEffect(() => {
    if (!meta) return;
    setFacets((old) => ({
      tools: [...new Set([...old.tools, ...meta.facets.tools])].sort(),
      agents: [...new Set([...old.agents, ...meta.facets.agents])].sort(),
    }));
  }, [meta]);
  return facets;
}

/**
 * Recent calls, newest first: when, tool, the decision in Never, Ask, Always
 * words and who made it, the agent, and a masked preview. Read-only; a row
 * opens the whole masked record in a panel.
 */
export function AuditList() {
  const status = useAuditStatus();
  const [filters, setFilters] = useState<AuditFilterValues>(NO_FILTERS);
  const [open, setOpen] = useState<ListedCall | undefined>();
  const opener = useRef<Element | null>(null);
  const page = useAuditPages<ListedCall, Meta>(
    async (cursor, ideMessenger) => {
      const res = await ideMessenger.request("audit/list", {
        ...(filters.agent ? { agent: filters.agent } : {}),
        ...(filters.decision ? { decision: filters.decision } : {}),
        ...(filters.tool ? { tool: filters.tool } : {}),
        ...(cursor ? { cursor } : {}),
      });
      if (res.status !== "success") return undefined;
      const { rows, nextCursor, ...meta } = res.content;
      return { items: rows, nextCursor, meta };
    },
    [filters.agent, filters.decision, filters.tool],
  );
  const facets = useFacets(page.meta);
  const clear = () => setFilters(NO_FILTERS);

  return (
    <section
      aria-label="Recent calls"
      data-testid="audit-list"
      className="flex min-w-0 flex-col"
    >
      <p className="mt-0 mb-2 text-2xs text-description-muted">
        The calls the agent made, newest first, and what decided each: your
        rules, the reviewer, you, or the system. Read from the audit files on
        this computer. Secrets are masked.
      </p>
      {status && !status.enabled && <AuditOff status={status} />}
      <AuditFilters
        value={filters}
        onChange={setFilters}
        agents={facets.agents}
        tools={facets.tools}
      />
      {page.loading && (
        <AuditLoading slow={page.slow} onRetry={page.reload} what={WHAT} />
      )}
      {page.error && <AuditError onRetry={page.reload} what={WHAT} />}
      {!page.loading && !page.error && page.items.length === 0 && (
        <AuditEmpty
          kind={emptyKind(filters, status?.enabled)}
          status={status}
          onClear={clear}
        />
      )}
      {page.items.length > 0 && !page.error && (
        <ul className="m-0 flex flex-col gap-1 p-0" aria-label="Calls">
          {page.items.map((call) => (
            <AuditRow
              key={`${call.session}/${call.callId}`}
              call={call}
              onOpen={() => {
                opener.current = document.activeElement;
                setOpen(call);
              }}
            />
          ))}
        </ul>
      )}
      {page.meta?.partial && (
        <p
          className="my-1 text-2xs text-description-muted"
          data-testid="partial"
        >
          This is the newest part of a large trail: older records were not read.
        </p>
      )}
      {page.hasMore && (
        <div className="mt-2">
          <Button
            variant="outline"
            size="sm"
            className="min-h-6"
            disabled={page.loadingMore}
            onClick={page.more}
            data-testid="audit-more"
          >
            {page.loadingMore ? "Loading" : "Show more"}
          </Button>
        </div>
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
