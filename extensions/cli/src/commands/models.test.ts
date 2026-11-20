import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { OPENROUTER_MODELS_URL } from "core/llm/openRouterCatalog.js";
import { parseOpenRouterModels } from "core/llm/openRouterCatalog.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  modelsListCommand,
  modelsRefreshCommand,
  type ModelsDeps,
} from "./models.js";

const NOW = Date.parse("2026-11-12T12:00:00Z");

const entry = {
  id: "anthropic/claude-sonnet-4.5",
  name: "Anthropic: Claude Sonnet 4.5",
  context_length: 1000000,
  top_provider: { max_completion_tokens: 64000 },
  supported_parameters: ["tools"],
  pricing: {
    prompt: "0.000003",
    completion: "0.000015",
    overrides: [
      {
        min_prompt_tokens: 200000,
        prompt: "0.000006",
        completion: "0.0000225",
      },
    ],
  },
};

function catalogAt(fetchedAt: string) {
  return {
    schemaVersion: 1,
    source: OPENROUTER_MODELS_URL,
    fetchedAt,
    models: parseOpenRouterModels({
      data: [entry, { id: "x/unpriced", name: "Unpriced" }],
    }),
  };
}

let out: string[];
let err: string[];
const io = () => ({
  out: (l: string) => out.push(l),
  err: (l: string) => err.push(l),
});
let dir: string;

beforeEach(() => {
  out = [];
  err = [];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-models-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function deps(over: Partial<ModelsDeps> = {}): ModelsDeps {
  return {
    pull: vi.fn(async () => catalogAt("2026-11-12T10:00:00.000Z")),
    read: () => undefined,
    file: () => path.join(dir, "model-catalog", "openrouter.json"),
    requestOptions: () => undefined,
    now: () => NOW,
    ...over,
  };
}

describe("continuous models refresh", () => {
  it("says which host it contacts and what it stores, then makes one request", async () => {
    const d = deps();
    const code = await modelsRefreshCommand({}, io(), d);
    expect(code).toBe(0);
    expect(d.pull).toHaveBeenCalledTimes(1);
    const text = out.join("\n");
    expect(text).toContain("Contacting openrouter.ai");
    expect(text).toContain(OPENROUTER_MODELS_URL);
    expect(text).toContain("No account, key or prompt is sent");
    expect(text).toContain("Storing the public model list");
    expect(text).toContain("model-catalog");
    expect(text).toContain(
      "Saved 2 models (1 with prices), downloaded 2026-11-12",
    );
    // the host line comes before the result
    expect(text.indexOf("Contacting")).toBeLessThan(text.indexOf("Saved"));
  });

  it("passes the user's requestOptions to the guarded fetch", async () => {
    const opts = { proxy: "http://proxy.invalid:3128" };
    const d = deps({ requestOptions: () => opts });
    await modelsRefreshCommand({}, io(), d);
    expect((d.pull as any).mock.calls[0][0]).toBe(opts);
  });

  it("is refused, with no request, when model information updates are off", async () => {
    const d = deps({ settings: () => ({ policy: "off", refreshHours: 24 }) });
    const code = await modelsRefreshCommand({}, io(), d);
    expect(code).toBe(1);
    expect(d.pull).not.toHaveBeenCalled();
    expect(err.join("\n")).toMatch(/updates are off/);
    expect(err.join("\n")).toMatch(/CONTINUOUS_MODEL_INFO_UPDATES/);
  });

  it.each(["automatic", "ask", "never"] as const)(
    "runs when typed with updates %s",
    async (policy) => {
      const d = deps({ settings: () => ({ policy, refreshHours: 24 }) });
      expect(await modelsRefreshCommand({}, io(), d)).toBe(0);
      expect(d.pull).toHaveBeenCalledTimes(1);
    },
  );

  it("reports a failure, exits 1 and leaves the old list", async () => {
    const d = deps({
      pull: vi.fn(async () => {
        throw new Error("openrouter.ai answered 503");
      }),
    });
    const code = await modelsRefreshCommand({}, io(), d);
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(
      /Could not download the model list: openrouter.ai answered 503/,
    );
    expect(err.join("\n")).toMatch(/already on this computer is unchanged/);
  });

  it("--json prints one object and nothing else", async () => {
    await modelsRefreshCommand({ json: true }, io(), deps());
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0])).toMatchObject({
      ok: true,
      fetchedAt: "2026-11-12T10:00:00.000Z",
      models: 2,
      priced: 1,
    });
  });
});

describe("continuous models list", () => {
  it("never pulls; says what to run when there is no list", () => {
    const d = deps();
    expect(modelsListCommand({}, io(), d)).toBe(0);
    expect(d.pull).not.toHaveBeenCalled();
    expect(out.join("\n")).toMatch(/continuous models refresh/);
  });

  it("--json lists cached models with prices per million tokens and tiers", () => {
    const d = deps({ read: () => catalogAt("2026-11-10T00:00:00.000Z") });
    expect(modelsListCommand({ json: true }, io(), d)).toBe(0);
    expect(out).toHaveLength(1);
    const j = JSON.parse(out[0]);
    expect(j.fetchedAt).toBe("2026-11-10T00:00:00.000Z");
    expect(j.ageDays).toBe(2);
    expect(j.pricesUsdPerMillionTokens).toBe(true);
    const sonnet = j.models.find((m: any) => m.id === entry.id);
    expect(sonnet).toMatchObject({
      input: 3,
      output: 15,
      contextLength: 1000000,
      supportsTools: true,
      tiers: [{ minPromptTokens: 200000, input: 6, output: 22.5 }],
    });
    expect(j.models.find((m: any) => m.id === "x/unpriced")).toMatchObject({
      input: null,
      output: null,
    });
  });

  it("text output carries the date and a stale warning after 30 days", () => {
    const d = deps({ read: () => catalogAt("2026-09-01T00:00:00.000Z") });
    modelsListCommand({ search: "sonnet" }, io(), d);
    expect(out[0]).toContain("Prices from openrouter.ai as of 2026-09-01");
    expect(out.join("\n")).toContain("in $3  out $15");
    expect(out.join("\n")).not.toContain("x/unpriced");
    expect(err.join("\n")).toMatch(/prices may be out of date/);
    expect(err.join("\n")).toMatch(/continuous models refresh/);
  });
});

describe("egress allowlist", () => {
  it("covers the one host `models refresh` contacts, as on by default", () => {
    const list = JSON.parse(
      fs.readFileSync(
        path.resolve(
          __dirname,
          "../../../../core/egress/egress-allowlist.json",
        ),
        "utf8",
      ),
    ) as { groups: { class: string; hosts: string[] }[] };
    const host = new URL(OPENROUTER_MODELS_URL).hostname;
    const group = list.groups.find((g) => g.hosts.includes(host));
    // The background refresh (model information updates `automatic`) is
    // the default, so the host is reachable without opting in
    expect(group?.class).toBe("D");
  });
});
