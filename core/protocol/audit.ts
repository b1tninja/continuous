import type {
  AuditListRequest,
  AuditListResponse,
  CallDetail,
  InboxRequest,
  InboxResponse,
} from "../tools/permissions/audit/listing";
import type { AuditStatus } from "../tools/permissions/audit/listingHandlers";

/**
 * Read-only views of the audit trail for the Permissions page. Pages are capped
 * (`LIST_PAGE_MAX`), and every field is masked text; see audit/listing.ts.
 */
export type AuditListProtocol = {
  "audit/status": [undefined, AuditStatus];
  "audit/list": [AuditListRequest | undefined, AuditListResponse];
  "audit/inbox": [InboxRequest | undefined, InboxResponse];
  "audit/get": [{ session: string; callId: string }, CallDetail | null];
};
