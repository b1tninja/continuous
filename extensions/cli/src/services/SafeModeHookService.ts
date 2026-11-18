import { HookService, type HookServiceState } from "../hooks/HookService.js";
import { isSafeMode } from "../safeMode.js";

/**
 * The hook service, with `--safe`: in safe mode no settings file is read, so
 * a broken or blocking hook cannot stop the start, and nothing runs. Every
 * hook goes through this one instance (`services.hooks`), so this is the
 * single place the switch is needed.
 */
export class SafeModeHookService extends HookService {
  override async doInitialize(cwd?: string): Promise<HookServiceState> {
    if (isSafeMode()) {
      return { config: {}, disabled: true, onceKeys: new Set<string>() };
    }
    return super.doInitialize(cwd);
  }

  override async reloadConfig(): Promise<void> {
    if (isSafeMode()) return;
    await super.reloadConfig();
  }
}
