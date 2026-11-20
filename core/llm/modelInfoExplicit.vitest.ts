import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MODELS_DEV_TRIMMED } from "./communityCatalogFixtures";
import {
  createCommunityRefresher,
  pullCommunityCatalog,
} from "./communityCatalogStore";
import {
  ensureBedrockPriceList,
  resetBedrockPriceListState,
} from "./bedrockPriceList";
import { setBedrockPriceList } from "./utils/bedrockPriceListPricing";
import {
  createOpenRouterRefresher,
  STARTUP_DELAY_MS,
  STARTUP_JITTER_MS,
} from "./modelCatalogRefresh";
import {
  modelInfoRefreshesInBackground,
  pullRequestedModelInfo,
  readModelCatalogSettings,
  type ModelCatalogSettings,
} from "./modelCatalogStore";
import { sonnetEntry } from "./openRouterCatalogFixtures";
import {
  createSelectedModelRefresher,
  SELECT_DELAY_MS,
  SELECT_JITTER_MS,
} from "./providerModelRefresh";

vi.mock("@continuedev/fetch", () => ({
  fetchwithRequestOptions: (...args: unknown[]) =>
    (globalThis as any).fetch(...args),
}));

const FORBIDDEN = [
  "openrouter.ai",
  "models.dev",
  "pricing.us-east-1.amazonaws.com",
  "api.openai.com",
  "api.anthropic.com",
];

describe("model information is explicit", () => {
  let dir: string;
  let urls: string[];
  const fetchSpy = vi.fn(async (url: string) => {
    urls.push(String(url));
    const host = new URL(String(url)).host;
    if (host === "models.dev") {
      return new Response(JSON.stringify(MODELS_DEV_TRIMMED));
    }
    if (host === "openrouter.ai") {
      return new Response(JSON.stringify({ data: [sonnetEntry] }));
    }
    return new Response("no", { status: 404 });
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-info-explicit-"));
    urls = [];
    fetchSpy.mockClear();
    vi.stubGlobal("fetch", fetchSpy);
    vi.useFakeTimers();
    resetBedrockPriceListState();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setBedrockPriceList(undefined);
    resetBedrockPriceListState();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function freshSettings(): ModelCatalogSettings {
    return readModelCatalogSettings(
      path.join(dir, "config.yaml"),
      path.join(dir, "policy.json"),
      {},
    );
  }

  it("a fresh config makes no request at start-up, and Refresh now makes one", async () => {
    const settings = freshSettings();
    expect(settings).toMatchObject({
      policy: "ask",
      community: false,
      priceList: false,
    });
    expect(modelInfoRefreshesInBackground(settings)).toBe(false);

    const openrouter = createOpenRouterRefresher({
      settings: () => settings,
      file: path.join(dir, "openrouter.json"),
    });
    openrouter.start();
    const community = createCommunityRefresher({
      settings: () => settings,
      unpriced: () => true,
      file: path.join(dir, "models-dev.json"),
    });
    community.start();
    const selected = createSelectedModelRefresher({
      settings: () => settings,
    });
    selected.select({
      provider: "openai",
      apiBase: "https://api.openai.com/v1",
      apiKey: "sk-test",
      model: "gpt-4o",
    });
    selected.select({
      provider: "anthropic",
      apiBase: "https://api.anthropic.com/v1",
      apiKey: "sk-ant-test",
      model: "claude-sonnet-4-5",
    });
    for (const trigger of [
      "background",
      "model-selected",
      "test-connection",
    ] as const) {
      await ensureBedrockPriceList("us-east-1", trigger, {
        settings,
        fetch: fetchSpy,
        dir,
      });
    }
    await vi.advanceTimersByTimeAsync(
      STARTUP_DELAY_MS +
        STARTUP_JITTER_MS +
        SELECT_DELAY_MS +
        SELECT_JITTER_MS +
        60_000,
    );
    openrouter.stop();
    community.stop();
    selected.stop();

    expect(urls, urls.join("\n")).toEqual([]);
    for (const host of FORBIDDEN) {
      expect(urls.some((u) => u.includes(host))).toBe(false);
    }

    const communityPulls: string[] = [];
    const refreshed = await pullRequestedModelInfo({
      settings,
      file: path.join(dir, "openrouter.json"),
      pullCommunity: async () => {
        communityPulls.push("models.dev");
        await pullCommunityCatalog(undefined, {
          file: path.join(dir, "models-dev.json"),
        });
      },
    });
    expect(refreshed.ok).toBe(true);
    expect(communityPulls).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(new URL(urls[0]).host).toBe("openrouter.ai");
  });

  it("models.dev is requested only with the community opt-in", async () => {
    const settings: ModelCatalogSettings = {
      ...freshSettings(),
      community: true,
    };
    await pullRequestedModelInfo({
      settings,
      file: path.join(dir, "openrouter.json"),
      pullCommunity: async () => {
        await pullCommunityCatalog(undefined, {
          file: path.join(dir, "models-dev.json"),
        });
      },
    });
    expect(urls.map((u) => new URL(u).host)).toEqual([
      "openrouter.ai",
      "models.dev",
    ]);
  });
});
