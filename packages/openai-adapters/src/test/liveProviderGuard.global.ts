// vitest globalSetup: runs once before workers start, so child processes
// inherit the scrubbed environment too. See liveProviderGuard.ts.
import { scrubProviderCredentialsAndReport } from "./liveProviderGuard.js";

export function setup(): void {
  scrubProviderCredentialsAndReport();
}
