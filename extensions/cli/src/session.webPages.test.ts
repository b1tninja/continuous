import { webContentStore } from "core/util/web/contentStore.js";
import { preparePage } from "core/util/web/window.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  clearSession,
  createSession,
  forkIntoNewSession,
  getCurrentSession,
  startNewSession,
} from "./session.js";

const count = (text: string) => Math.ceil(text.length / 4);

function fetchInto(sessionId: string, url = "https://docs.example.com/"): void {
  const text = "# Page\n\nBody.";
  webContentStore.recordFetchedPage({
    sessionId,
    finalUrl: url,
    acceptVariant: "text/markdown",
    text,
    page: preparePage(text, { windowTokens: 2_000, count }),
  });
}

afterEach(() => {
  webContentStore.clearAll();
});

describe("the CLI session and the web content store", () => {
  it("a new session drops the previous session's pages", () => {
    const first = createSession([], "web-first");
    fetchInto(first.sessionId);
    const next = startNewSession();
    expect(webContentStore.usage(first.sessionId).entries).toBe(0);
    expect(webContentStore.session(next.sessionId).list()).toEqual([]);
  });

  it("resuming another session drops the current one's pages", () => {
    createSession([], "web-a");
    fetchInto("web-a");
    createSession([], "web-b");
    expect(webContentStore.usage("web-a").entries).toBe(0);
  });

  it("setting the same session again keeps its pages", () => {
    createSession([], "web-same");
    fetchInto("web-same");
    createSession([], "web-same");
    expect(webContentStore.usage("web-same").entries).toBe(1);
  });

  it("a fork starts with no pages, and the parent's go", () => {
    const parent = createSession([], "web-parent");
    fetchInto(parent.sessionId);
    const fork = forkIntoNewSession(getCurrentSession());
    expect(fork.sessionId).not.toBe(parent.sessionId);
    expect(webContentStore.session(fork.sessionId).list()).toEqual([]);
    expect(webContentStore.usage(parent.sessionId).entries).toBe(0);
  });

  it("clearing the session drops its pages", () => {
    createSession([], "web-cleared");
    fetchInto("web-cleared");
    clearSession();
    expect(webContentStore.usage("web-cleared").entries).toBe(0);
  });
});
