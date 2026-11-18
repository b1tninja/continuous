import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CATALOG_REQUEST_HEADERS,
  loadOpenRouterPrices,
  modelInfoFetchBlocked,
  pullOpenRouterCatalog,
  readModelCatalogPolicy,
  readModelCatalogSettings,
  readOpenRouterCatalog,
  writeOpenRouterCatalog,
} from "./modelCatalogStore";
import { MAX_CATALOG_BYTES } from "./openRouterCatalog";
import { sonnetEntry } from "./openRouterCatalogFixtures";

vi.mock("@continuedev/fetch", () => ({
  fetchwithRequestOptions: (...args: unknown[]) =>
    (globalThis as any).fetch(...args),
}));

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "modelcatalog-"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

const stubFetch = (response: () => Response) => {
  const f = vi.fn(async () => response());
  vi.stubGlobal("fetch", f);
  return f;
};

describe("pullOpenRouterCatalog", () => {
  it("makes one GET to the public list, with no key or body, and writes a dated file", async () => {
    const f = stubFetch(
      () => new Response(JSON.stringify({ data: [sonnetEntry] })),
    );
    const file = path.join(dir, "model-catalog", "openrouter.json");
    const c = await pullOpenRouterCatalog(undefined, {
      file,
      now: () => new Date("2026-11-12T10:00:00Z"),
    });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, any];
    expect(url).toBe("https://openrouter.ai/api/v1/models");
    expect(init?.body).toBeUndefined();
    expect(JSON.stringify(init?.headers ?? {})).not.toMatch(/authorization/i);
    // Only what is wanted back and a fixed, versionless User-Agent
    expect(init?.method).toBe("GET");
    expect(init?.headers).toEqual(CATALOG_REQUEST_HEADERS);
    expect(Object.keys(init.headers).sort()).toEqual(["accept", "user-agent"]);
    expect(init.headers["user-agent"]).toBe("continuous");
    expect(c.fetchedAt).toBe("2026-11-12T10:00:00.000Z");

    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(onDisk).toMatchObject({
      schemaVersion: 1,
      source: "https://openrouter.ai/api/v1/models",
      fetchedAt: "2026-11-12T10:00:00.000Z",
    });
    expect(readOpenRouterCatalog(file)?.models[0].pricing?.prompt).toBe(
      0.000003,
    );
    // no temporary files are left behind
    expect(fs.readdirSync(path.dirname(file))).toEqual(["openrouter.json"]);
  });

  it("keeps the older file when the request fails", async () => {
    const file = path.join(dir, "openrouter.json");
    stubFetch(() => new Response(JSON.stringify({ data: [sonnetEntry] })));
    await pullOpenRouterCatalog(undefined, { file });
    const before = fs.readFileSync(file, "utf8");
    stubFetch(() => new Response("down", { status: 503 }));
    await expect(pullOpenRouterCatalog(undefined, { file })).rejects.toThrow(
      /503/,
    );
    stubFetch(() => new Response("<html>", { status: 200 }));
    await expect(pullOpenRouterCatalog(undefined, { file })).rejects.toThrow(
      /did not return a model list/,
    );
    stubFetch(() => new Response(JSON.stringify({ data: [] })));
    await expect(pullOpenRouterCatalog(undefined, { file })).rejects.toThrow(
      /no models/,
    );
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("refuses an answer over the size cap", async () => {
    stubFetch(
      () => new Response("x".repeat(MAX_CATALOG_BYTES + 1), { status: 200 }),
    );
    await expect(
      pullOpenRouterCatalog(undefined, { file: path.join(dir, "o.json") }),
    ).rejects.toThrow(/size limit/);
  });
});

describe("readOpenRouterCatalog", () => {
  it("ignores a missing, corrupt, old-schema or oversize file", () => {
    const file = path.join(dir, "openrouter.json");
    expect(readOpenRouterCatalog(file)).toBeUndefined();
    fs.writeFileSync(file, "{not json");
    expect(readOpenRouterCatalog(file)).toBeUndefined();
    fs.writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 0,
        source: "s",
        fetchedAt: "2026-11-01T00:00:00Z",
        models: [{ id: "a", name: "A" }],
      }),
    );
    expect(readOpenRouterCatalog(file)).toBeUndefined();
    fs.writeFileSync(file, " ".repeat(MAX_CATALOG_BYTES + 1));
    expect(readOpenRouterCatalog(file)).toBeUndefined();
  });

  it("round-trips a written catalogue", () => {
    const file = path.join(dir, "sub", "openrouter.json");
    const catalog = {
      schemaVersion: 1,
      source: "https://openrouter.ai/api/v1/models",
      fetchedAt: "2026-11-10T00:00:00.000Z",
      models: [{ id: "a/b", name: "B", supportsTools: false }],
    };
    writeOpenRouterCatalog(catalog, file);
    expect(readOpenRouterCatalog(file)).toEqual(catalog);
  });
});

describe("readModelCatalogSettings", () => {
  const yaml = (value: string, extra = "") =>
    `name: x\nversion: 1\nmodelCatalog: ${value}\n${extra}`;
  const noEnv = {};

  it("defaults to automatic with a 24 hour interval", () => {
    const file = path.join(dir, "config.yaml");
    const standIn = path.join(dir, "policy.json");
    expect(readModelCatalogSettings(file, standIn, noEnv)).toEqual({
      policy: "automatic",
      refreshHours: 24,
    });
  });

  it("reads modelCatalog from config.yaml, else the stand-in file", () => {
    const file = path.join(dir, "config.yaml");
    const standIn = path.join(dir, "policy.json");
    fs.writeFileSync(standIn, JSON.stringify({ modelCatalog: "never" }));
    expect(readModelCatalogPolicy(file, standIn, noEnv)).toBe("never");
    for (const [value, policy] of [
      ["automatic", "automatic"],
      ["manual", "ask"],
      ["ask", "ask"],
      ["never", "never"],
      ["off", "off"],
    ] as const) {
      fs.writeFileSync(file, yaml(value));
      expect(readModelCatalogPolicy(file, standIn, noEnv)).toBe(policy);
    }
    fs.rmSync(standIn);
    fs.writeFileSync(file, yaml("sometimes"));
    expect(readModelCatalogPolicy(file, standIn, noEnv)).toBe("automatic");
  });

  it("reads the refresh interval and keeps it within 1 hour and 30 days", () => {
    const file = path.join(dir, "config.yaml");
    const standIn = path.join(dir, "policy.json");
    fs.writeFileSync(file, yaml("automatic", "modelCatalogRefreshHours: 6\n"));
    expect(readModelCatalogSettings(file, standIn, noEnv).refreshHours).toBe(6);
    fs.writeFileSync(
      file,
      yaml("automatic", "modelCatalogRefreshHours: 0.01\n"),
    );
    expect(readModelCatalogSettings(file, standIn, noEnv).refreshHours).toBe(1);
    fs.writeFileSync(
      file,
      yaml("automatic", "modelCatalogRefreshHours: 100000\n"),
    );
    expect(readModelCatalogSettings(file, standIn, noEnv).refreshHours).toBe(
      720,
    );
  });

  it("lets the environment override config.yaml (the terminal agent, CI)", () => {
    const file = path.join(dir, "config.yaml");
    const standIn = path.join(dir, "policy.json");
    fs.writeFileSync(file, yaml("automatic"));
    expect(
      readModelCatalogSettings(file, standIn, {
        CONTINUOUS_MODEL_INFO_UPDATES: "off",
        CONTINUOUS_MODEL_INFO_REFRESH_HOURS: "48",
      }),
    ).toEqual({ policy: "off", refreshHours: 48 });
    // An unknown value is ignored, not treated as off or on
    expect(
      readModelCatalogSettings(file, standIn, {
        CONTINUOUS_MODEL_INFO_UPDATES: "maybe",
      }).policy,
    ).toBe("automatic");
  });

  it("only off blocks a request", () => {
    expect(modelInfoFetchBlocked({ policy: "off", refreshHours: 24 })).toMatch(
      /off/,
    );
    for (const policy of ["automatic", "ask", "never"] as const) {
      expect(modelInfoFetchBlocked({ policy, refreshHours: 24 })).toBe(
        undefined,
      );
    }
  });
});

describe("loadOpenRouterPrices", () => {
  it("uses the downloaded copy, except when updates are off", () => {
    const file = path.join(dir, "o.json");
    writeOpenRouterCatalog(
      {
        schemaVersion: 1,
        source: "https://openrouter.ai/api/v1/models",
        fetchedAt: new Date().toISOString(),
        models: [{ id: "a/b", name: "B", supportsTools: false }],
      },
      file,
    );
    expect(
      loadOpenRouterPrices({
        file,
        settings: { policy: "automatic", refreshHours: 24 },
      })?.models,
    ).toHaveLength(1);
    expect(
      loadOpenRouterPrices({
        file,
        settings: { policy: "off", refreshHours: 24 },
      }),
    ).toBeUndefined();
    loadOpenRouterPrices({
      file: path.join(dir, "none.json"),
      settings: { policy: "automatic", refreshHours: 24 },
    });
  });
});
