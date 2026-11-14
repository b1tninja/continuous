import { beforeEach, describe, expect, it, vi } from "vitest";

const { showInformationMessage, scan, estimate } = vi.hoisted(() => ({
  showInformationMessage: vi.fn(),
  scan: vi.fn(),
  estimate: vi.fn(),
}));

vi.mock("vscode", () => ({
  window: { showInformationMessage, withProgress: vi.fn() },
  workspace: { getConfiguration: () => ({ get: () => 0 }) },
  commands: { registerCommand: vi.fn() },
  ProgressLocation: { Notification: 15 },
}));

vi.mock("core/util/sessionCleanup/index", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scanForCleanup: scan,
  quickCleanupEstimate: estimate,
}));

import { offerAfterUpdate, shouldScanForNotice } from "./sessionCleanup";

const MB = 1024 * 1024;
const packageJSON = require("../package.json");

function context(state: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(state));
  return {
    store,
    extension: { packageJSON: { version: "2.21.0" } },
    globalState: {
      get: (k: string) => store.get(k),
      update: async (k: string, v: unknown) => void store.set(k, v),
    },
  } as any;
}

function scanResult(bytes: number) {
  return {
    root: "/g",
    stores: ["sessions"],
    sessions: [],
    devData: [],
    logs: [],
    skipped: [],
    devDataDays: 90,
    logsDays: 14,
    totals: {
      sessionsBytes: bytes,
      devDataBytes: 0,
      logsBytes: 0,
      reclaimableBytes: bytes,
    },
  };
}

beforeEach(() => {
  showInformationMessage.mockReset();
  scan.mockReset();
  estimate.mockReset();
});

describe("Clean up old sessions", () => {
  it("is a command in the palette", () => {
    const command = packageJSON.contributes.commands.find(
      (c: any) => c.command === "continuous.cleanUpOldSessions",
    );
    expect(command).toMatchObject({
      category: "Continuous",
      title: "Clean up old sessions",
    });
  });

  it("looks once per version, and never after Don't ask again", () => {
    expect(shouldScanForNotice({ version: "2" })).toBe(true);
    expect(shouldScanForNotice({ version: "2", lastNoticeVersion: "2" })).toBe(
      false,
    );
    expect(shouldScanForNotice({ version: "3", lastNoticeVersion: "2" })).toBe(
      true,
    );
    expect(shouldScanForNotice({ version: "3", declined: true })).toBe(false);
  });

  it("says nothing when less than 100 MB could be reclaimed, and does not scan when sizes rule it out", async () => {
    estimate.mockResolvedValue(50 * MB);
    const ctx = context();
    await offerAfterUpdate(ctx);
    expect(scan).not.toHaveBeenCalled();
    expect(showInformationMessage).not.toHaveBeenCalled();
    expect(ctx.store.get("continuous.sessionCleanup.noticeVersion")).toBe(
      "2.21.0",
    );

    estimate.mockResolvedValue(500 * MB);
    scan.mockResolvedValue(scanResult(80 * MB));
    await offerAfterUpdate(context());
    expect(showInformationMessage).not.toHaveBeenCalled();
  });

  it("offers a review above 100 MB, changes nothing by itself, and remembers a decline", async () => {
    estimate.mockResolvedValue(500 * MB);
    scan.mockResolvedValue(scanResult(300 * MB));
    showInformationMessage.mockResolvedValue("Don't ask again");
    const ctx = context();
    await offerAfterUpdate(ctx);
    expect(showInformationMessage).toHaveBeenCalledTimes(1);
    expect(showInformationMessage.mock.calls[0][0]).toContain("300.0 MB");
    expect(ctx.store.get("continuous.sessionCleanup.noticeDeclined")).toBe(
      true,
    );

    showInformationMessage.mockReset();
    ctx.store.set("continuous.sessionCleanup.noticeVersion", "older");
    await offerAfterUpdate(ctx);
    expect(showInformationMessage).not.toHaveBeenCalled();
  });
});
