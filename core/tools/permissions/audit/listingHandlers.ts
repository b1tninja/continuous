import {
  auditCallDetail,
  auditInboxPage,
  auditListPage,
  type AuditListRequest,
  type AuditListResponse,
  type CallDetail,
  type InboxRequest,
  type InboxResponse,
} from "./listing";
import type { ReadLimits } from "./reader";

/** Whether the trail is on and who said so, for "the audit trail is off". */
export interface AuditStatus {
  enabled: boolean;
  retentionDays: number;
  /** What decided it: the environment, config.yaml, or the default */
  via: "env" | "config" | "default";
}

export interface AuditListHost {
  dir: () => string;
  status: () => AuditStatus;
  limits?: ReadLimits;
  now?: () => Date;
}

type On = (
  name: any,
  handler: (msg: { data: any }) => Promise<unknown>,
) => void;

/**
 * The webview's read-only view of the audit trail. Four messages, all answered
 * from the bounded reader, none of which writes anything or returns a raw
 * record (listing.ts).
 */
export function registerAuditListHandlers(on: On, host: AuditListHost): void {
  const opts = () => ({ limits: host.limits, now: host.now?.() });
  on("audit/status", async (): Promise<AuditStatus> => host.status());
  on("audit/list", async ({ data }): Promise<AuditListResponse> =>
    auditListPage(host.dir(), (data ?? {}) as AuditListRequest, opts()),
  );
  on("audit/inbox", async ({ data }): Promise<InboxResponse> =>
    auditInboxPage(host.dir(), (data ?? {}) as InboxRequest, opts()),
  );
  on(
    "audit/get",
    async ({ data }): Promise<CallDetail | null> =>
      auditCallDetail(host.dir(), data, opts()) ?? null,
  );
}
