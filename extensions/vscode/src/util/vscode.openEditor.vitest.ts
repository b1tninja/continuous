import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shown = vi.hoisted(() => ({
  pending: [] as Array<(editor: unknown) => void>,
}));

vi.mock("vscode", () => ({
  window: {
    tabGroups: { all: [] },
    showTextDocument: vi.fn(
      () =>
        new Promise((resolve) => {
          shown.pending.push(resolve);
        }),
    ),
  },
  workspace: {
    openTextDocument: vi.fn(async (uri: unknown) => ({ uri })),
  },
}));
vi.mock("node-machine-id", () => ({ machineIdSync: () => "id" }));

import { openEditorAndRevealRange } from "./vscode";

const uri = (path: string) => ({ toString: () => `file://${path}` }) as any;

describe("openEditorAndRevealRange", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    shown.pending = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for the editor already opening without leaving a timer running", async () => {
    const first = openEditorAndRevealRange(uri("/a.ts"));
    await vi.advanceTimersByTimeAsync(0);
    expect(shown.pending).toHaveLength(1);

    // The second waits while the first is in progress
    const second = openEditorAndRevealRange(uri("/b.ts"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(shown.pending).toHaveLength(1);

    shown.pending[0]({ revealRange: vi.fn() });
    await vi.advanceTimersByTimeAsync(200);
    expect(shown.pending).toHaveLength(2);
    shown.pending[1]({ revealRange: vi.fn() });
    await Promise.all([first, second]);

    // With setInterval, every 200 ms wait above left a timer firing forever
    expect(vi.getTimerCount()).toBe(0);
  });
});
