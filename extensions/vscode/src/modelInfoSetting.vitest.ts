import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  listener: undefined as undefined | ((e: any) => void),
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      inspect: (k: string) => ({ globalValue: state.config[k] }),
    }),
    onDidChangeConfiguration: (cb: (e: any) => void) => {
      state.listener = cb;
      return { dispose() {} };
    },
  },
}));

import {
  MODEL_INFO_REFRESH_HOURS,
  MODEL_INFO_UPDATES,
  registerModelInfoSetting,
  syncModelInfoSetting,
} from "./modelInfoSetting";

import type { ModelCatalogSettings } from "core/llm/modelCatalogStore";

function store(initial: ModelCatalogSettings) {
  let current = { ...initial };
  const saves: unknown[] = [];
  return {
    saves,
    deps: {
      read: () => current,
      save: (change: any) => {
        saves.push(change);
        current = { ...current, ...change };
        return true;
      },
    },
  };
}

describe("syncModelInfoSetting", () => {
  it("leaves the shared setting alone while the VS Code setting is unset", () => {
    const s = store({ policy: "off", refreshHours: 24 });
    expect(syncModelInfoSetting(undefined, undefined, s.deps)).toBeUndefined();
    expect(s.saves).toHaveLength(0);
  });

  it("writes each choice, manual as ask, and the interval", () => {
    const s = store({ policy: "automatic", refreshHours: 24 });
    syncModelInfoSetting("off", undefined, s.deps);
    syncModelInfoSetting("manual", undefined, s.deps);
    syncModelInfoSetting("automatic", 6, s.deps);
    expect(s.saves).toEqual([
      { policy: "off" },
      { policy: "ask" },
      { policy: "automatic", refreshHours: 6 },
    ]);
  });

  it("keeps a 'don't ask again' answer when the setting says manual", () => {
    const s = store({ policy: "never", refreshHours: 24 });
    expect(syncModelInfoSetting("manual", undefined, s.deps)).toBeUndefined();
    expect(s.saves).toHaveLength(0);
  });

  it("ignores values that are not a mode", () => {
    const s = store({ policy: "automatic", refreshHours: 24 });
    syncModelInfoSetting("sometimes", -1, s.deps);
    expect(s.saves).toHaveLength(0);
  });
});

describe("registerModelInfoSetting", () => {
  it("applies the setting at activation and on change", () => {
    const s = store({ policy: "automatic", refreshHours: 24 });
    state.config = { [MODEL_INFO_UPDATES]: "manual" };
    registerModelInfoSetting({ subscriptions: [] } as any, s.deps);
    expect(s.saves).toEqual([{ policy: "ask" }]);
    state.config = {
      [MODEL_INFO_UPDATES]: "off",
      [MODEL_INFO_REFRESH_HOURS]: 12,
    };
    state.listener?.({
      affectsConfiguration: (k: string) => k === MODEL_INFO_UPDATES,
    });
    expect(s.saves).toEqual([
      { policy: "ask" },
      { policy: "off", refreshHours: 12 },
    ]);
  });
});
