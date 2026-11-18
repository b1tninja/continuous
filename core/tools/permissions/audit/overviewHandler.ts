import type { RuleSourcesInput } from "../effectiveRules";
import { auditDir } from "./global";
import { readIndex, updateIndex } from "./auditIndex";
import { buildOverview, type AuditOverview } from "./auditOverview";
import { makeGuard } from "./overviewGuard";

/**
 * `audit/overview`: the Permissions page's audit figures (ROADMAP B69). A
 * protocol message, not a tool: the model cannot call it. It reads the index
 * file only, never the trail, so the answer takes the same time however large
 * the trail is. After answering it brings the index up to date in the
 * background, a slice at a time, so the next open is current.
 */
export interface AuditOverviewRequest {
  /** The rule texts on the page; each gets an entry in `rules` */
  rules?: string[];
}

export interface OverviewHost {
  sources: () => Promise<RuleSourcesInput>;
  cwd: () => Promise<string | undefined>;
  dir?: () => string;
  now?: () => Date;
}

const SLICE_BYTES = 4 * 1024 * 1024;
let refreshing = false;

/** Bring the index up to date in slices, yielding between them. */
export function refreshIndexInBackground(dir: string): void {
  if (refreshing) return;
  refreshing = true;
  const step = () => {
    try {
      const { index, stats } = updateIndex(dir, { maxBytes: SLICE_BYTES });
      if (!index.complete && stats.bytesRead > 0) {
        setImmediate(step);
        return;
      }
    } catch {
      // derived data: a failed refresh is tried again at the next open
    }
    refreshing = false;
  };
  setImmediate(step);
}

export async function auditOverview(
  req: AuditOverviewRequest | undefined,
  host: OverviewHost,
): Promise<AuditOverview> {
  const dir = host.dir?.() ?? auditDir();
  const now = host.now?.() ?? new Date();
  const index = readIndex(dir);
  const sources = await host.sources();
  const cwd = await host.cwd();
  const guard = makeGuard(sources, cwd);
  const out = buildOverview(index, req?.rules ?? [], now, guard.keep);
  return guard.cut ? { ...out, guardsCut: true } : out;
}

export function registerAuditOverview(
  on: (
    name: "audit/overview",
    handler: (msg: {
      data: AuditOverviewRequest | undefined;
    }) => Promise<AuditOverview>,
  ) => void,
  host: OverviewHost,
): void {
  on("audit/overview", async ({ data }) => {
    const out = await auditOverview(data, host);
    refreshIndexInBackground(host.dir?.() ?? auditDir());
    return out;
  });
}
