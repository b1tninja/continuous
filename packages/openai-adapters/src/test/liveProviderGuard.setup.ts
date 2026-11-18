// Runs before every test file (vitest setupFiles). See liveProviderGuard.ts.
import { scrubProviderCredentials } from "./liveProviderGuard.js";

scrubProviderCredentials();
