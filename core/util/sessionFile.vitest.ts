import { describe, expect, it } from "vitest";

import {
  formatFileSize,
  isOverSessionBudget,
  orderSession,
  serializeSession,
  SESSION_FILE_BUDGET_BYTES,
} from "./sessionFile";

describe("formatFileSize", () => {
  it("names bytes, KB and MB", () => {
    expect(formatFileSize(0)).toBe("0 bytes");
    expect(formatFileSize(640)).toBe("640 bytes");
    expect(formatFileSize(812 * 1024)).toBe("812 KB");
    expect(formatFileSize(3.44 * 1024 * 1024)).toBe("3.4 MB");
    expect(formatFileSize(432 * 1024 * 1024 + 7)).toBe("432 MB");
  });
});

describe("isOverSessionBudget", () => {
  it("is false for an unknown size and true from the budget up", () => {
    expect(isOverSessionBudget(undefined)).toBe(false);
    expect(isOverSessionBudget(SESSION_FILE_BUDGET_BYTES - 1)).toBe(false);
    expect(isOverSessionBudget(SESSION_FILE_BUDGET_BYTES)).toBe(true);
    expect(isOverSessionBudget(10, 10)).toBe(true);
  });
});

describe("serializeSession", () => {
  it("writes the id, title and workspace first and leaves out empty parts", () => {
    const text = serializeSession({
      history: [],
      workspaceDirectory: "w",
      title: "t",
      sessionId: "s",
      checkpoints: [],
      queuedMessages: [],
    });
    expect(Object.keys(JSON.parse(text))).toEqual([
      "sessionId",
      "title",
      "workspaceDirectory",
      "history",
    ]);
    expect(text).toBe(
      JSON.stringify(
        orderSession({
          history: [],
          workspaceDirectory: "w",
          title: "t",
          sessionId: "s",
        }),
        undefined,
        2,
      ),
    );
  });
});
