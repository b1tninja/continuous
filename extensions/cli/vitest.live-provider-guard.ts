// Runs before every test file in each vitest config (setupFiles), so no test can
// read a provider credential unless RUN_LIVE_PROVIDER_TESTS=1 (or RUN_SMOKE_API=1)
// is set. Dependency-free apart from the guard itself, like
// vitest.global-dir-setup.ts. See src/test-helpers/liveProviderGuard.ts.
import { scrubProviderCredentials } from "./src/test-helpers/liveProviderGuard.js";

scrubProviderCredentials();
