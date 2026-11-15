import type { FetchFunction } from "..";

import { classifyHost, pinnedLookup } from "./networkAddress";

const MAX_REDIRECTS = 5;

export interface GuardedFetchOptions {
  /**
   * When the starting host is itself non-public (an internal docs site the user
   * named), a redirect may only stay on that host. Without it, a non-public
   * start may be redirected to any non-public address.
   */
  stayOnStartHost?: boolean;
  /**
   * The start URL came from page content rather than from the user (a
   * favicon link): refuse it when it is non-public.
   */
  refuseNonPublicStart?: boolean;
  /**
   * How a host is classified. Default: `classifyHost` (an address decides).
   * The fetch tool passes a stricter one that also treats a name that
   * resolves to nothing and has no delegated TLD as non-public.
   */
  classify?: (
    hostname: string,
  ) => Promise<{ addresses: string[]; nonPublic: boolean }>;
  /**
   * Called with the URL the returned response came from (the start URL when
   * nothing redirected), so a caller can label the content with where it
   * really was read.
   */
  onFinalUrl?: (url: URL) => void;
}

/**
 * Follow redirects one at a time, resolving every hop once and pinning the
 * connection to those addresses, and refuse a hop that leads from a public
 * address to a non-public one (loopback, private network, the cloud metadata
 * address 169.254.169.254). A start URL that is itself non-public is the
 * caller's decision.
 */
export async function fetchWithGuardedRedirects(
  start: URL,
  fetchFn: FetchFunction,
  options: GuardedFetchOptions = {},
  init: Record<string, unknown> = {},
): Promise<any> {
  const classify = options.classify ?? classifyHost;
  let current = start;
  let checked = await classify(current.hostname);
  const startsNonPublic = checked.nonPublic;
  if (startsNonPublic && options.refuseNonPublicStart) {
    throw new Error(`Refused to fetch a non-public address (${start.host})`);
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const resp = await fetchFn(current, {
      ...init,
      redirect: "manual",
      ...(checked.addresses.length
        ? { lookup: pinnedLookup(checked.addresses) }
        : {}),
    });
    const location: string | null | undefined = resp.headers?.get?.("location");
    if (resp.status < 300 || resp.status >= 400 || !location) {
      options.onFinalUrl?.(current);
      return resp;
    }

    const next = new URL(location, current);
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      throw new Error(`Refused to follow a redirect to ${next.protocol} URL`);
    }
    checked = await classify(next.hostname);
    const leavesStartHost =
      options.stayOnStartHost && next.hostname !== start.hostname;
    if (checked.nonPublic && (!startsNonPublic || leavesStartHost)) {
      throw new Error(
        `Refused to follow a redirect from ${start.host} to a non-public address (${next.host})`,
      );
    }
    current = next;
  }
  throw new Error(`Too many redirects fetching ${start}`);
}
