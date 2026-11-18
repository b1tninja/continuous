import { afterEach, describe, expect, it, vi } from "vitest";

import { loadHooksConfig } from "../hooks/hookConfig.js";
import { setSafeMode } from "../safeMode.js";

import { SafeModeHookService } from "./SafeModeHookService.js";

vi.mock("../hooks/hookConfig.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadHooksConfig: vi.fn(() => ({ hooks: {}, disabled: false })),
}));

afterEach(() => {
  setSafeMode(false);
  vi.mocked(loadHooksConfig).mockClear();
});

describe("SafeModeHookService", () => {
  it("reads no settings file and runs nothing in safe mode", async () => {
    setSafeMode(true);
    const service = new SafeModeHookService();
    const state = await service.initialize(process.cwd());
    expect(state.disabled).toBe(true);
    await service.reloadConfig();
    expect(loadHooksConfig).not.toHaveBeenCalled();
    expect(
      await service.fireEvent({ hook_event_name: "PreToolUse" } as never),
    ).toEqual({ blocked: false, results: [] });
  });

  it("loads the settings files as before without safe mode", async () => {
    const service = new SafeModeHookService();
    await service.initialize(process.cwd());
    await service.reloadConfig();
    expect(loadHooksConfig).toHaveBeenCalledTimes(2);
  });
});
