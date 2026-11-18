import { getGlobalDirPath } from "core/util/paths.js";

/**
 * The global folder, shared with the VS Code extension: ~/.continuous
 * (copied once from ~/.continue), or CONTINUOUS_GLOBAL_DIR /
 * CONTINUE_GLOBAL_DIR. Resolved by core so both agree.
 *
 * A working-directory .env is not copied into this process. The global
 * file still supplies CLI settings, and CLIPlatformClient still reads it
 * (and the workspace .env files) when resolving secrets.
 */
const continueHome = getGlobalDirPath();

export const env = {
  continueHome,
};
