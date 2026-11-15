import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelCatalogSettings } from "../modelCatalogStore";
import { modelIdKey, nameMatchesModelId } from "./bedrockModelNames";
import {
  API_KEY_QUOTA_NOTE,
  checkBedrockQuotas,
  classifyQuotaError,
  inferenceQuotas,
  parseQuotaName,
  quotaCacheFile,
  quotaRouteOf,
  quotasForModel,
  serviceQuotasConsoleUrl,
  zeroQuotaWarning,
  type QuotaCheckOptions,
  type RawServiceQuota,
} from "./bedrockQuotas";

/**
 * Two pages of ListServiceQuotas for service code `bedrock`, shaped like the
 * real answer (ServiceQuota fields, an ARN per quota, `NextToken` on the
 * first page). The quota names follow the patterns Service Quotas uses for
 * Bedrock; the values are made up, with 0 where the owner's account has 0.
 */
const FIXTURE = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures", "service-quotas-bedrock.json"),
    "utf8",
  ),
) as { pages: { Quotas: RawServiceQuota[]; NextToken?: string }[] };
const ALL_RAW = FIXTURE.pages.flatMap((p) => p.Quotas);

const AUTOMATIC: ModelCatalogSettings = {
  policy: "automatic",
  refreshHours: 24,
};
const NOW = Date.parse("2026-11-13T12:00:00Z");

function awsError(name: string, message: string, status?: number): Error {
  const e = new Error(message);
  e.name = name;
  if (status) (e as any).$metadata = { httpStatusCode: status };
  return e;
}

describe("quota names", () => {
  it("reads route, metric and model from inference quota names", () => {
    expect(
      parseQuotaName(
        "Cross-region model inference tokens per minute for Anthropic Claude Sonnet 4.5 V1",
      ),
    ).toEqual({
      route: "cross-region",
      metric: "tokens",
      model: "Anthropic Claude Sonnet 4.5 V1",
    });
    expect(
      parseQuotaName(
        "Global cross-region model inference requests per minute for Anthropic Claude Opus 5.5",
      ),
    ).toMatchObject({ route: "global", metric: "requests" });
    expect(
      parseQuotaName(
        "On-demand model inference tokens per minute for Amazon Nova Pro",
      ),
    ).toMatchObject({ route: "on-demand", model: "Amazon Nova Pro" });
  });

  it("ignores per-day, batch and latency-optimized quotas", () => {
    const kept = inferenceQuotas(ALL_RAW).map((q) => q.code);
    expect(kept).not.toContain("L-0A1B2C07"); // max tokens per day
    expect(kept).not.toContain("L-0A1B2C16"); // batch job size
    expect(kept).not.toContain("L-0A1B2C17"); // latency-optimized
    expect(kept).toHaveLength(ALL_RAW.length - 3);
  });

  it("turns model IDs into words with a version", () => {
    expect(modelIdKey("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toEqual({
      vendor: "anthropic",
      words: ["claude", "sonnet", "4", "5"],
      version: 1,
    });
    expect(modelIdKey("anthropic.claude-3-5-sonnet-20241022-v2:0")).toEqual({
      vendor: "anthropic",
      words: ["claude", "3", "5", "sonnet"],
      version: 2,
    });
    expect(modelIdKey("openai.gpt-oss-120b-1:0")?.words).toEqual([
      "gpt",
      "oss",
      "120",
      "b",
    ]);
    expect(modelIdKey("arn:aws:bedrock:us-east-1:1:inference-profile/x")).toBe(
      undefined,
    );
  });

  it("matches quota names to model IDs by words, vendor and version", () => {
    const yes: [string, string][] = [
      [
        "Anthropic Claude Sonnet 4.5 V1",
        "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      ],
      ["Anthropic Claude Opus 5.5", "us.anthropic.claude-opus-5-5"],
      [
        "Anthropic Claude 3.5 Sonnet",
        "anthropic.claude-3-5-sonnet-20240620-v1:0",
      ],
      [
        "Anthropic Claude 3.5 Sonnet V2",
        "anthropic.claude-3-5-sonnet-20241022-v2:0",
      ],
      ["Amazon Nova Pro", "amazon.nova-pro-v1:0"],
      ["Amazon Nova 2.0 Lite", "us.amazon.nova-2-lite-v1:0"],
      [
        "Meta Llama 4 Scout 17B Instruct",
        "meta.llama4-scout-17b-instruct-v1:0",
      ],
      ["Mistral AI Mistral Large 3", "mistral.mistral-large-3"],
      ["Qwen Qwen3 32B", "qwen.qwen3-32b-v1:0"],
    ];
    for (const [name, id] of yes) {
      expect(nameMatchesModelId(name, id), `${name} ~ ${id}`).toBe(true);
    }
    const no: [string, string][] = [
      // a different version
      [
        "Anthropic Claude 3.5 Sonnet V2",
        "anthropic.claude-3-5-sonnet-20240620-v1:0",
      ],
      [
        "Anthropic Claude 3.5 Sonnet",
        "anthropic.claude-3-5-sonnet-20241022-v2:0",
      ],
      // a later minor version is another model
      [
        "Anthropic Claude Sonnet 4 V1",
        "anthropic.claude-sonnet-4-5-20250929-v1:0",
      ],
      // a variant of the model
      [
        "Anthropic Claude Sonnet 4 V1 1M Context Length",
        "anthropic.claude-sonnet-4-20250514-v1:0",
      ],
      ["Amazon Nova Lite", "amazon.nova-2-lite-v1:0"],
    ];
    for (const [name, id] of no) {
      expect(nameMatchesModelId(name, id), `${name} !~ ${id}`).toBe(false);
    }
  });

  it("picks the quota of the route the request takes", () => {
    const quotas = inferenceQuotas(ALL_RAW);
    expect(quotaRouteOf("global.anthropic.claude-opus-5-5")).toBe("global");
    expect(quotaRouteOf("us.anthropic.claude-opus-5-5")).toBe("cross-region");
    expect(quotaRouteOf("amazon.nova-pro-v1:0")).toBe("on-demand");
    expect(
      quotasForModel(
        quotas,
        "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      ).map((q) => [q.metric, q.value]),
    ).toEqual([
      ["tokens", 2000000],
      ["requests", 200],
    ]);
    expect(
      quotasForModel(
        quotas,
        "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
      ),
    ).toHaveLength(1);
  });
});

describe("the 0-quota warning", () => {
  const quotas = inferenceQuotas(ALL_RAW);

  it("names the model, the region and Service Quotas, with the console link", () => {
    expect(
      zeroQuotaWarning(quotas, "us.anthropic.claude-opus-5-5", "us-east-1"),
    ).toBe(
      `us.anthropic.claude-opus-5-5 has a 0 tokens-per-minute quota in us-east-1 for this account; request an increase in Service Quotas: ${serviceQuotasConsoleUrl("us-east-1")}`,
    );
    expect(serviceQuotasConsoleUrl("eu-west-1")).toBe(
      "https://console.aws.amazon.com/servicequotas/home/services/bedrock/quotas?region=eu-west-1",
    );
  });

  it("uses a display name when given", () => {
    expect(
      zeroQuotaWarning(
        quotas,
        "global.anthropic.claude-opus-5-5",
        "us-east-1",
        "Claude Opus 5.5",
      ),
    ).toMatch(/^Claude Opus 5\.5 has a 0 tokens-per-minute quota in us-east-1/);
  });

  it("says nothing for a model with a quota, or one Service Quotas does not name", () => {
    expect(
      zeroQuotaWarning(
        quotas,
        "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        "us-east-1",
      ),
    ).toBeUndefined();
    expect(
      zeroQuotaWarning(
        quotas,
        "anthropic.claude-3-5-sonnet-20240620-v1:0",
        "us-east-1",
      ),
    ).toBeUndefined();
    expect(
      zeroQuotaWarning(quotas, "deepseek.v3.2", "us-east-1"),
    ).toBeUndefined();
    // The V2 model's quota is 0, the V1 model's is not
    expect(
      zeroQuotaWarning(
        quotas,
        "anthropic.claude-3-5-sonnet-20241022-v2:0",
        "us-east-1",
      ),
    ).toMatch(/0 tokens-per-minute/);
  });

  it("falls back to a 0 requests-per-minute quota", () => {
    const only = inferenceQuotas([
      {
        QuotaName:
          "On-demand model inference requests per minute for Amazon Nova Pro",
        Value: 0,
      },
    ]);
    expect(zeroQuotaWarning(only, "amazon.nova-pro-v1:0", "us-west-2")).toMatch(
      /has a 0 requests-per-minute quota in us-west-2/,
    );
  });
});

describe("classifyQuotaError", () => {
  it("sorts AWS errors into kinds", () => {
    expect(
      classifyQuotaError(
        awsError(
          "AccessDeniedException",
          "User: arn:aws:sts::123456789012:assumed-role/dev/me is not authorized to perform: servicequotas:ListServiceQuotas",
          400,
        ),
      ),
    ).toBe("denied");
    expect(
      classifyQuotaError(awsError("UnauthorizedOperation", "denied")),
    ).toBe("denied");
    expect(
      classifyQuotaError(
        awsError("TooManyRequestsException", "Rate exceeded", 400),
      ),
    ).toBe("throttled");
    expect(classifyQuotaError(awsError("TimeoutError", "timed out"))).toBe(
      "timeout",
    );
    expect(
      classifyQuotaError(
        awsError(
          "Error",
          "getaddrinfo ENOTFOUND servicequotas.xx-east-9.amazonaws.com",
        ),
      ),
    ).toBe("network");
    expect(
      classifyQuotaError(awsError("UnknownEndpoint", "Inaccessible host")),
    ).toBe("region-unavailable");
    expect(
      classifyQuotaError(
        awsError(
          "NoSuchResourceException",
          "The service is not available in this Region",
        ),
      ),
    ).toBe("region-unavailable");
    expect(
      classifyQuotaError(
        awsError(
          "CredentialsProviderError",
          "Could not load credentials from any providers",
        ),
      ),
    ).toBe("credentials");
  });
});

describe("checkBedrockQuotas", () => {
  let dir: string;
  let now: number;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bedrock-quotas-"));
    now = NOW;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function options(
    overrides: Partial<QuotaCheckOptions> = {},
  ): QuotaCheckOptions {
    return {
      key: "profile:dev@us-east-1",
      region: "us-east-1",
      trigger: "test-connection",
      settings: AUTOMATIC,
      dir,
      credentials: async () => "fingerprint-a",
      listPage: async (token) => (token ? FIXTURE.pages[1] : FIXTURE.pages[0]),
      now: () => now,
      ...overrides,
    };
  }

  it("reads every page and keeps the inference quotas", async () => {
    const listPage = vi.fn(async (token: string | undefined) =>
      token ? FIXTURE.pages[1] : FIXTURE.pages[0],
    );
    const report = await checkBedrockQuotas(options({ listPage }));
    expect(listPage).toHaveBeenCalledTimes(2);
    expect(listPage.mock.calls[1][0]).toBe(FIXTURE.pages[0].NextToken);
    expect(report.status).toBe("ok");
    expect(report.note).toBeUndefined();
    expect(report.quotas).toHaveLength(ALL_RAW.length - 3);
    expect(report.fetchedAt).toBe(new Date(NOW).toISOString());
    // Cached atomically, no temporary file left
    const files = fs.readdirSync(dir);
    expect(files).toEqual([
      path.basename(quotaCacheFile(dir, "profile:dev@us-east-1")),
    ]);
    const kept = JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf8"));
    expect(kept).not.toHaveProperty("credentials");
    expect(JSON.stringify(kept)).not.toContain("fingerprint-a");
  });

  it("reuses the cache for a selected model within the refresh interval", async () => {
    await checkBedrockQuotas(options());
    const listPage = vi.fn();
    now += 23 * 60 * 60 * 1000;
    const again = await checkBedrockQuotas(
      options({ trigger: "model-selected", listPage }),
    );
    expect(listPage).not.toHaveBeenCalled();
    expect(again).toMatchObject({ status: "ok", fromCache: true });
    expect(again.quotas).toHaveLength(ALL_RAW.length - 3);
    // The background refresh asks again once the interval has passed
    now += 2 * 60 * 60 * 1000;
    const listAgain = vi.fn(async () => FIXTURE.pages[1]);
    await checkBedrockQuotas(
      options({ trigger: "background", listPage: listAgain }),
    );
    expect(listAgain).toHaveBeenCalledTimes(1);
  });

  it("does not ask on selection under manual, but uses what is kept", async () => {
    const listPage = vi.fn();
    const manual = { policy: "ask", refreshHours: 24 } as const;
    expect(
      await checkBedrockQuotas(
        options({ trigger: "model-selected", settings: manual, listPage }),
      ),
    ).toMatchObject({ status: "skipped", fromCache: true });
    expect(listPage).not.toHaveBeenCalled();
    // Test connection is the person asking
    await checkBedrockQuotas(options({ settings: manual }));
    now += 48 * 60 * 60 * 1000;
    const report = await checkBedrockQuotas(
      options({ trigger: "model-selected", settings: manual, listPage }),
    );
    expect(listPage).not.toHaveBeenCalled();
    expect(report.status).toBe("ok");
  });

  it("requests nothing and uses nothing when model information updates are off", async () => {
    await checkBedrockQuotas(options());
    const listPage = vi.fn();
    const report = await checkBedrockQuotas(
      options({ settings: { policy: "off", refreshHours: 24 }, listPage }),
    );
    expect(report).toEqual({ status: "off", region: "us-east-1" });
    expect(listPage).not.toHaveBeenCalled();
  });

  it("does not ask with a Bedrock API key, and says why in one line", async () => {
    const listPage = vi.fn();
    const report = await checkBedrockQuotas(
      options({ apiKey: true, listPage }),
    );
    expect(listPage).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      status: "skipped",
      note: API_KEY_QUOTA_NOTE,
    });
  });

  describe("AccessDenied", () => {
    const denied = () =>
      Promise.reject(
        awsError(
          "AccessDeniedException",
          "User: arn:aws:iam::123456789012:user/dev is not authorized to perform: servicequotas:ListServiceQuotas",
          400,
        ),
      );

    it("is a quiet skip with the permission named, never an error", async () => {
      const report = await checkBedrockQuotas(options({ listPage: denied }));
      expect(report).toMatchObject({
        status: "skipped",
        failure: "denied",
        note: "Quota check skipped: this profile lacks servicequotas:ListServiceQuotas",
      });
      expect(report.docsUrl).toMatch(/bedrock#optional-quota-check$/);
    });

    it("is remembered per profile and region for a day, Test connection included", async () => {
      await checkBedrockQuotas(options({ listPage: denied }));
      const listPage = vi.fn(denied);
      now += 23 * 60 * 60 * 1000;
      for (const trigger of [
        "test-connection",
        "model-selected",
        "background",
      ] as const) {
        const report = await checkBedrockQuotas(options({ trigger, listPage }));
        expect(report.note).toMatch(/lacks servicequotas:ListServiceQuotas/);
      }
      expect(listPage).not.toHaveBeenCalled();
      // Another region (another key) is asked
      await checkBedrockQuotas(
        options({
          key: "profile:dev@eu-west-1",
          region: "eu-west-1",
          listPage,
        }),
      );
      expect(listPage).toHaveBeenCalledTimes(1);
    });

    it("is tried again after a day", async () => {
      await checkBedrockQuotas(options({ listPage: denied }));
      now += 24 * 60 * 60 * 1000 + 1;
      const report = await checkBedrockQuotas(options());
      expect(report.status).toBe("ok");
      expect(report.note).toBeUndefined();
    });

    it("is tried again at once when the credentials change", async () => {
      await checkBedrockQuotas(options({ listPage: denied }));
      now += 60 * 1000;
      const report = await checkBedrockQuotas(
        options({ credentials: async () => "fingerprint-b" }),
      );
      expect(report.status).toBe("ok");
    });

    it("keeps quotas read earlier in use", async () => {
      await checkBedrockQuotas(options());
      now += 25 * 60 * 60 * 1000;
      const report = await checkBedrockQuotas(options({ listPage: denied }));
      expect(report).toMatchObject({ status: "ok", failure: "denied" });
      expect(report.quotas?.length).toBeGreaterThan(0);
    });
  });

  it("backs off for 15 minutes after throttling, except for Test connection", async () => {
    const throttled = vi.fn(() =>
      Promise.reject(awsError("TooManyRequestsException", "Rate exceeded")),
    );
    const report = await checkBedrockQuotas(options({ listPage: throttled }));
    expect(report).toMatchObject({ status: "skipped", failure: "throttled" });
    expect(report.note).toMatch(/throttling requests/);
    now += 10 * 60 * 1000;
    await checkBedrockQuotas(
      options({ trigger: "background", listPage: throttled }),
    );
    expect(throttled).toHaveBeenCalledTimes(1);
    await checkBedrockQuotas(options({ listPage: throttled }));
    expect(throttled).toHaveBeenCalledTimes(2);
    now += 16 * 60 * 1000;
    expect(
      (await checkBedrockQuotas(options({ trigger: "background" }))).status,
    ).toBe("ok");
  });

  it("gives up after the timeout without waiting for the answer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let seen: AbortSignal | undefined;
      const hang = (_: string | undefined, signal: AbortSignal) => {
        seen = signal;
        return new Promise<never>(() => {});
      };
      const pending = checkBedrockQuotas(
        options({ listPage: hang, timeoutMs: 5000 }),
      );
      await vi.advanceTimersByTimeAsync(5000);
      const report = await pending;
      expect(report).toMatchObject({ status: "skipped", failure: "timeout" });
      expect(report.note).toBe(
        "Quota check skipped: Service Quotas did not answer within 5 seconds",
      );
      expect(seen?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says when Service Quotas is not available in the region, and waits a day", async () => {
    const unavailable = vi.fn(() =>
      Promise.reject(
        awsError(
          "Error",
          "getaddrinfo ENOTFOUND servicequotas.xx-test-1.amazonaws.com",
        ),
      ),
    );
    const network = await checkBedrockQuotas(
      options({
        region: "xx-test-1",
        key: "k@xx-test-1",
        listPage: unavailable,
      }),
    );
    expect(network.note).toBe(
      "Quota check skipped: Service Quotas in xx-test-1 could not be reached",
    );
    const regionGone = vi.fn(() =>
      Promise.reject(awsError("UnknownEndpoint", "Could not resolve endpoint")),
    );
    const report = await checkBedrockQuotas(
      options({
        region: "xx-test-2",
        key: "k@xx-test-2",
        listPage: regionGone,
      }),
    );
    expect(report.note).toBe(
      "Quota check skipped: Service Quotas is not available in xx-test-2",
    );
    now += 12 * 60 * 60 * 1000;
    await checkBedrockQuotas(
      options({
        region: "xx-test-2",
        key: "k@xx-test-2",
        trigger: "background",
        listPage: regionGone,
      }),
    );
    expect(regionGone).toHaveBeenCalledTimes(1);
  });

  it("stays quiet and remembers nothing when there are no credentials", async () => {
    const listPage = vi.fn();
    const report = await checkBedrockQuotas(
      options({
        credentials: () =>
          Promise.reject(
            awsError("CredentialsProviderError", "Could not load credentials"),
          ),
        listPage,
      }),
    );
    expect(report.note).toBeUndefined();
    expect(listPage).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("ignores a cache file of another key or schema", async () => {
    await checkBedrockQuotas(options());
    const file = quotaCacheFile(dir, "profile:dev@us-east-1");
    const kept = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...kept, schemaVersion: 99 }));
    const listPage = vi.fn(async () => FIXTURE.pages[1]);
    await checkBedrockQuotas(options({ trigger: "model-selected", listPage }));
    expect(listPage).toHaveBeenCalledTimes(1);
  });
});
