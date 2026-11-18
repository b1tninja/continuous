// Runs before every test file (jest setupFiles, vitest setupFiles). See liveProviderGuard.ts.
import { scrubProviderCredentials } from "./liveProviderGuard";

scrubProviderCredentials();
