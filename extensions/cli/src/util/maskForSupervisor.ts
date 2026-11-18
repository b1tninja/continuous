import { maskArgsForDisplay } from "core/tools/permissions/displayMask.js";
import { scrubDeep } from "core/util/secretScan/index.js";

/**
 * A copy of a JSON-shaped value for a reader outside this process: the
 * supervisor of `serve` (`GET /state`) or the editor on the other end of ACP.
 * Every string goes through the display masker (the audit trail's passes plus
 * secret-named assignments), then the shared secret scanner runs over what is
 * left. Keys, numbers and shape are kept; the input is not changed.
 *
 * Display only: the model and the tools always get the real text. Best
 * effort, like every pattern masker: a secret in a shape nobody listed passes.
 */
export function maskForSupervisor<T>(value: T): T {
  return scrubDeep(maskArgsForDisplay(value));
}
