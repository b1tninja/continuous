import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContinueConfig, IDE } from "../../..";
import DocsCrawler from "./DocsCrawler";

// Crawl requests go through the shared fetch; stand in for it with the global
// replacement each test installs, and for DNS with a public answer.
vi.mock("@continuedev/fetch", () => ({
  fetchwithRequestOptions: (...args: unknown[]) =>
    (globalThis as any).fetch(...args),
}));
vi.mock("../../../util/networkAddress", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../util/networkAddress")>()),
  classifyHost: async () => ({ addresses: [], nonPublic: false }),
}));

const ide = { showToast: async () => undefined } as unknown as IDE;
const config = { experimental: {} } as ContinueConfig;

async function crawl() {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    return new Response("<html><body><p>local</p></body></html>", {
      status: 200,
    });
  }) as typeof fetch;
  try {
    const crawler = new DocsCrawler(ide, config, 0, 1);
    const pages = [];
    const generator = crawler.crawl(new URL("https://example.com/docs"));
    let kind = "";
    for (;;) {
      const step = await generator.next();
      if (step.done) {
        kind = step.value;
        break;
      }
      pages.push(step.value);
    }
    return { calls, pages, kind };
  } finally {
    globalThis.fetch = original;
  }
}

describe("docs crawl reporting", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches only from the site the user named, never a crawl service", async () => {
    const result = await crawl();
    expect(result.kind).toBe("cheerio");
    expect(result.calls.length).toBeGreaterThan(0);
    for (const url of result.calls) {
      expect(new URL(url).host).toBe("example.com");
    }
  });
});
