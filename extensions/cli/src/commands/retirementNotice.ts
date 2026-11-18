import { startupRetirementLine } from "core/util/retirementStartup.js";

import { safeStderr } from "../init.js";
import { services } from "../services/index.js";

/**
 * One line on stderr when the active model is deprecated or retiring, at most
 * once a day and never after it was dismissed. Never blocks, never throws.
 */
export function printRetirementNotice(): void {
  try {
    const active = services.model.getModelId();
    const line = active
      ? startupRetirementLine({
          provider: active.provider,
          model: active.model,
        })
      : undefined;
    if (line) safeStderr(`${line}\n`);
  } catch {
    // A notice is optional.
  }
}
