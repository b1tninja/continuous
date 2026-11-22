import type { MockIdeMessenger } from "../../../../context/MockIdeMessenger";

/**
 * For tests that open the Protections view without being about it: answers
 * the two reads its folded controls make when they mount (Commands and
 * secrets, Shadow review), with nothing set.
 */
export function answerProtectionsReads(ideMessenger: MockIdeMessenger): void {
  const h = ideMessenger.responseHandlers as Record<string, unknown>;
  h["config/getTerminalEnvironment"] = async () => ({
    mode: "scrub",
    source: "default",
    passEnv: [],
    allow: [],
    notices: [],
    hostEnvNames: [],
    credentialUrlNames: [],
    platform: "linux",
  });
  h["audit/shadowSettings"] = async () => ({
    form: { enabled: false, timeoutMs: 5000 },
    trailEnabled: true,
    spentUsd: 0,
    reservedUsd: 0,
    reviews: 0,
  });
}
