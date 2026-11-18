import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ServiceQuotasClient } from "@aws-sdk/client-service-quotas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BedrockMetadataTracker,
  withQuotaWarnings,
  type SelectedBedrockModel,
} from "./bedrockMetadata";
import Bedrock from "./llms/Bedrock";
import {
  inferenceQuotas,
  type BedrockQuotaReport,
  type RawServiceQuota,
} from "./llms/bedrockQuotas";
import type { ModelCatalogSettings } from "./modelCatalogStore";
import { setBedrockPriceList } from "./utils/bedrockPriceListPricing";

const FIXTURE = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "llms", "fixtures", "service-quotas-bedrock.json"),
    "utf8",
  ),
) as { pages: { Quotas: RawServiceQuota[]; NextToken?: string }[] };
const pages = async (token: string | undefined) =>
  token ? FIXTURE.pages[1] : FIXTURE.pages[0];

const AUTOMATIC: ModelCatalogSettings = {
  policy: "automatic",
  refreshHours: 24,
};
const MANUAL: ModelCatalogSettings = { policy: "ask", refreshHours: 24 };

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bedrock-metadata-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  setBedrockPriceList(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

function bedrock(options: Record<string, unknown> = {}) {
  return new Bedrock({
    model: "anthropic.claude-opus-5-5",
    region: "us-east-1",
    accessKeyId: "AKIAEXAMPLEEXAMPLE01",
    secretAccessKey: "not-a-real-secret",
    ...options,
  } as any);
}

describe("Bedrock.checkQuotas", () => {
  it("warns before the first request when the selected model's quota on its route is 0", async () => {
    const llm = bedrock({
      crossRegionInference: "us",
      title: "Claude Opus 5.5",
    });
    const report = await llm.checkQuotas("test-connection", {
      settings: AUTOMATIC,
      dir,
      listPage: pages,
    });
    expect(report.status).toBe("ok");
    expect(llm.zeroQuotaWarning(report)).toBe(
      "Claude Opus 5.5 has a 0 tokens-per-minute quota in us-east-1 for this account; request an increase in Service Quotas: https://console.aws.amazon.com/servicequotas/home/services/bedrock/quotas?region=us-east-1",
    );
    // A model whose route has a quota is not warned about
    const sonnet = bedrock({
      model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    });
    expect(sonnet.zeroQuotaWarning(report)).toBeUndefined();
  });

  it("asks Service Quotas for service code bedrock with the configured credentials and region, and turns AccessDenied into a quiet note", async () => {
    const send = vi
      .spyOn(ServiceQuotasClient.prototype, "send")
      .mockImplementation(((command: any, options: any) => {
        expect(command.input).toMatchObject({
          ServiceCode: "bedrock",
          MaxResults: 100,
        });
        expect(options?.abortSignal).toBeDefined();
        const e = new Error(
          "User: arn:aws:iam::123456789012:user/dev is not authorized to perform: servicequotas:ListServiceQuotas",
        );
        e.name = "AccessDeniedException";
        return Promise.reject(e);
      }) as any);
    const llm = bedrock({ region: "eu-west-1" });
    const report = await llm.checkQuotas("test-connection", {
      settings: AUTOMATIC,
      dir,
    });
    expect(send).toHaveBeenCalledTimes(1);
    const client = send.mock.contexts[0] as ServiceQuotasClient;
    expect(await client.config.region()).toBe("eu-west-1");
    const creds = await (client.config.credentials as any)();
    expect(creds.accessKeyId).toBe("AKIAEXAMPLEEXAMPLE01");
    expect(report).toMatchObject({
      status: "skipped",
      failure: "denied",
      note: "Quota check skipped: this profile lacks servicequotas:ListServiceQuotas",
    });
    // Not asked again for a day
    await llm.checkQuotas("model-selected", { settings: AUTOMATIC, dir });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not ask with a Bedrock API key", async () => {
    const send = vi.spyOn(ServiceQuotasClient.prototype, "send");
    const report = await bedrock({
      apiKey: "bedrock-api-key-example",
      accessKeyId: undefined,
      secretAccessKey: undefined,
    }).checkQuotas("test-connection", { settings: AUTOMATIC, dir });
    expect(send).not.toHaveBeenCalled();
    expect(report.note).toMatch(/a Bedrock API key cannot read Service Quotas/);
  });
});

describe("withQuotaWarnings", () => {
  it("marks listed models with a 0 quota and keeps one quiet line", () => {
    const report: BedrockQuotaReport = {
      status: "ok",
      region: "us-east-1",
      quotas: inferenceQuotas(FIXTURE.pages.flatMap((p) => p.Quotas)),
    };
    const { models, quota } = withQuotaWarnings(
      [
        { id: "us.anthropic.claude-opus-5-5", name: "Claude Opus 5.5" },
        { id: "amazon.nova-pro-v1:0", name: "Nova Pro" },
      ],
      report,
      (id, name) => (id.includes("opus") ? `${name}: 0` : undefined),
    );
    expect(models[0].quotaWarning).toBe("Claude Opus 5.5: 0");
    expect(models[1]).not.toHaveProperty("quotaWarning");
    expect(quota).toEqual({ status: "ok", zeroQuotaModels: 1 });

    const skipped = withQuotaWarnings(
      [{ id: "amazon.nova-pro-v1:0", name: "Nova Pro" }],
      {
        status: "skipped",
        region: "us-east-1",
        note: "Quota check skipped: this profile lacks servicequotas:ListServiceQuotas",
        docsUrl: "https://b1tninja.github.io/continuous/x",
      },
      () => "never called",
    );
    expect(skipped.models[0]).not.toHaveProperty("quotaWarning");
    expect(skipped.quota.note).toMatch(/lacks servicequotas/);
  });
});

describe("BedrockMetadataTracker", () => {
  function fakeModel(
    model: string,
    report: BedrockQuotaReport,
  ): SelectedBedrockModel & { checkQuotas: ReturnType<typeof vi.fn> } {
    return {
      model,
      region: "us-east-1",
      checkQuotas: vi.fn(async () => report),
      zeroQuotaWarning: (r) =>
        r.quotas?.some((q) => q.value === 0)
          ? `${model} has a 0 tokens-per-minute quota`
          : undefined,
    };
  }
  const zero: BedrockQuotaReport = {
    status: "ok",
    region: "us-east-1",
    quotas: [
      {
        name: "x",
        value: 0,
        route: "cross-region",
        metric: "tokens",
        model: "x",
      },
    ],
  };

  it("checks on selection and warns once per model and region", async () => {
    const onZeroQuota = vi.fn();
    const tracker = new BedrockMetadataTracker({
      requestOptions: () => undefined,
      onZeroQuota,
      settings: () => MANUAL,
      dir,
    });
    const opus = fakeModel("us.anthropic.claude-opus-5-5", zero);
    await tracker.select(opus);
    expect(opus.checkQuotas).toHaveBeenCalledWith("model-selected");
    expect(onZeroQuota).toHaveBeenCalledWith(
      "us.anthropic.claude-opus-5-5 has a 0 tokens-per-minute quota",
    );
    // The same selection again (a config reload) does nothing
    await tracker.select(opus);
    expect(opus.checkQuotas).toHaveBeenCalledTimes(1);
    // Selected again after another model: checked, not warned twice
    await tracker.select(undefined);
    await tracker.select(opus);
    expect(opus.checkQuotas).toHaveBeenCalledTimes(2);
    expect(onZeroQuota).toHaveBeenCalledTimes(1);
  });

  it("does nothing in the background without a selected Bedrock model", async () => {
    const tracker = new BedrockMetadataTracker({
      requestOptions: () => undefined,
      onZeroQuota: vi.fn(),
      settings: () => AUTOMATIC,
      dir,
    });
    expect(await tracker.refresher.check()).toBe("fresh");
  });

  it("is disabled in the background when updates are not automatic", async () => {
    const tracker = new BedrockMetadataTracker({
      requestOptions: () => undefined,
      onZeroQuota: vi.fn(),
      settings: () => MANUAL,
      dir,
    });
    const opus = fakeModel("us.anthropic.claude-opus-5-5", zero);
    await tracker.select(opus);
    expect(await tracker.refresher.check()).toBe("disabled");
    expect(opus.checkQuotas).toHaveBeenCalledTimes(1);
  });
});
