import historyManager from "core/util/history.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSession,
  isSessionPersistenceEnabled,
  saveSession,
  setSessionPersistence,
  updateSessionHistory,
  updateSessionTitle,
} from "./session.js";

const message = (content: string) => ({
  message: { role: "user" as const, content },
  contextItems: [],
});

describe("setSessionPersistence (-p --no-session-persistence, V11)", () => {
  afterEach(() => {
    setSessionPersistence(true);
    vi.restoreAllMocks();
  });

  it("is on by default", () => {
    expect(isSessionPersistenceEnabled()).toBe(true);
  });

  it("off: no save of the history, the title or the usage writes anything", () => {
    const save = vi.spyOn(historyManager, "save");
    setSessionPersistence(false);
    createSession([message("hello")]);
    updateSessionHistory([message("hello"), message("again")]);
    updateSessionTitle("A title");
    saveSession();
    expect(save).not.toHaveBeenCalled();
  });

  it("on again: the next save writes", () => {
    const save = vi
      .spyOn(historyManager, "save")
      .mockReturnValue({ ok: true } as any);
    setSessionPersistence(false);
    createSession([message("hello")]);
    saveSession();
    expect(save).not.toHaveBeenCalled();
    setSessionPersistence(true);
    saveSession();
    expect(save).toHaveBeenCalledTimes(1);
  });
});
