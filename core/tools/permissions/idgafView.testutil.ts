import { expect } from "vitest";

import type { ToolPolicyResult } from "./evaluate";

/**
 * What the permission layer would have decided. At IDGAF every call runs and
 * the decision carries what would have stopped it (`idgafOverride`); tests of
 * a guard read that, so they keep checking the guard at every level. Each
 * such call is also checked to have run.
 */
export function wouldDecide<T extends ToolPolicyResult>(r: T): T {
  const o = r.idgafOverride;
  if (!o) return r;
  expect(r.policy).toBe("allowedWithoutPermission");
  expect(r.source).toBe("idgaf");
  const { idgafOverride: _o, protection: _p, rule: _r, ...rest } = r;
  return {
    ...rest,
    policy: o.policy,
    source: o.source,
    reason: o.reason,
    ...(o.protection ? { protection: o.protection } : {}),
    ...(o.rule ? { rule: o.rule } : {}),
  } as T;
}
