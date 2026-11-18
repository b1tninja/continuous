// vitest globalSetup: runs once before workers start, so the CLI processes that
// e2e tests spawn with { ...process.env } inherit the scrubbed environment too.
// See src/test-helpers/liveProviderGuard.ts.
import { scrubProviderCredentialsAndReport } from "./src/test-helpers/liveProviderGuard.js";

export function setup(): void {
  scrubProviderCredentialsAndReport();
}
