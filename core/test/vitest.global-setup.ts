import fs from "fs";
import path from "path";

import { scrubProviderCredentialsAndReport } from "./liveProviderGuard";

// Sets up the GLOBAL directory for testing - equivalent to ~/.continuous
// IMPORTANT: the CONTINUE_GLOBAL_DIR environment variable is used in utils/paths for getting all local paths
export default async function () {
  // Before any worker starts, so child processes inherit the scrubbed environment too.
  scrubProviderCredentialsAndReport();
  process.env.CONTINUE_GLOBAL_DIR = path.join(__dirname, ".continue-test");
  if (fs.existsSync(process.env.CONTINUE_GLOBAL_DIR)) {
    fs.rmSync(process.env.CONTINUE_GLOBAL_DIR, {
      recursive: true,
      force: true,
    });
  }
}
