import { describe, expect, it } from "vitest";

import {
  readSessionIdgaf,
  SESSION_IDGAF_KEY,
  writeSessionIdgaf,
} from "./sessionIdgaf";

function memory() {
  const data = new Map<string, unknown>();
  return {
    data,
    get: (k: string) => data.get(k),
    update: async (k: string, v: unknown) => {
      if (v === undefined) data.delete(k);
      else data.set(k, v);
    },
  };
}

describe("IDGAF for the editor session", () => {
  it("a webview reload or an extension host restart (same session) keeps it", async () => {
    const store = memory();
    await writeSessionIdgaf(store, "session-1", ["tools", "edits"]);
    expect(readSessionIdgaf(store, "session-1")).toEqual(["tools", "edits"]);
  });

  it("a restarted editor or a new window (new session) starts without it", async () => {
    const store = memory();
    await writeSessionIdgaf(store, "session-1", ["tools"]);
    expect(readSessionIdgaf(store, "session-2")).toEqual([]);
  });

  it("leaving IDGAF clears the entry", async () => {
    const store = memory();
    await writeSessionIdgaf(store, "s", ["tools"]);
    await writeSessionIdgaf(store, "s", []);
    expect(store.data.has(SESSION_IDGAF_KEY)).toBe(false);
    expect(readSessionIdgaf(store, "s")).toEqual([]);
  });

  it("keeps only real areas, from whatever the webview sent", async () => {
    const store = memory();
    expect(
      await writeSessionIdgaf(store, "s", ["tools", "bogus", 3, "questions"]),
    ).toEqual(["tools", "questions"]);
    await writeSessionIdgaf(store, "s", "tools");
    expect(readSessionIdgaf(store, "s")).toEqual([]);
  });

  it("an unreadable store reads as nothing", () => {
    const broken = {
      get: () => {
        throw new Error("gone");
      },
      update: async () => {},
    };
    expect(readSessionIdgaf(broken, "s")).toEqual([]);
  });
});
