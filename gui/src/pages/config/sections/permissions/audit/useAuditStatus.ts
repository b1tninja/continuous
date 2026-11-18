import type { AuditStatus } from "core/tools/permissions/audit/listingHandlers";
import { useContext, useEffect, useState } from "react";
import { IdeMessengerContext } from "../../../../../context/IdeMessenger";

/** Whether the audit trail is on; undefined until core answers (or when it cannot). */
export function useAuditStatus(): AuditStatus | undefined {
  const ideMessenger = useContext(IdeMessengerContext);
  const [status, setStatus] = useState<AuditStatus | undefined>();
  useEffect(() => {
    let cancelled = false;
    ideMessenger
      .request("audit/status", undefined)
      .then((res) => {
        if (!cancelled && res.status === "success") setStatus(res.content);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [ideMessenger]);
  return status;
}
