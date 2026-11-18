import type { EffectiveRule } from "core/tools/permissions/effectiveRules";
import type { AuditOverview } from "core/tools/permissions/audit/auditOverview";
import { useEffect, useState } from "react";
import type { IIdeMessenger } from "../../../../context/IdeMessenger";
import { SLOW_AFTER_MS } from "./PermissionsStates";

/** The rule text the audit records for a rule: config.yaml's dialect. */
export const auditKeyOf = (r: EffectiveRule) =>
  r.dialect === "core" ? r.raw : (r.core ?? r.raw);

/**
 * The audit figures for the Permissions page: per-rule use, the most-asked
 * list and unused hints. Read-only. The page works without them, so a failure
 * is a quiet note with a Retry, never a block. `rules` are the rule texts on
 * the page; the figures are asked for again when they change.
 */
export function useAuditOverview(
  ideMessenger: IIdeMessenger,
  rules: string[],
  enabled: boolean,
) {
  const [overview, setOverview] = useState<AuditOverview | undefined>();
  const [error, setError] = useState(false);
  const [slow, setSlow] = useState(false);
  const [reloads, setReloads] = useState(0);
  const key = rules.join("\n");

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setError(false);
    const timer = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    const finish = (content?: AuditOverview) => {
      if (cancelled) return;
      clearTimeout(timer);
      setSlow(false);
      if (content) setOverview(content);
      setError(!content);
    };
    ideMessenger
      .request("audit/overview", { rules: key ? key.split("\n") : [] })
      .then((res) => finish(res.status === "success" ? res.content : undefined))
      .catch(() => finish(undefined));
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [ideMessenger, key, enabled, reloads]);

  return {
    overview,
    error,
    slow,
    loading: enabled && !overview && !error,
    reload: () => setReloads((n) => n + 1),
  };
}
