import fs from "fs";
import http from "http";
import type { AddressInfo } from "net";
import path from "path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { constructLlmApi } from "./index.js";
import {
  appliesReasoningEffort,
  REASONING_EFFORT_NOT_APPLIED,
} from "./reasoningEffortSupport.js";

/**
 * The table in reasoningEffortSupport.ts against the code: every provider
 * constructLlmApi knows is built with `reasoning_effort: "high"` in its
 * `requestOptions.extraBodyProperties` (where the CLI puts a `modeModels`
 * effort), sends one chat request to a local server, and the request that
 * arrives says whether the effort reached the provider in a field its API
 * reads. A provider added to constructLlmApi without a row, or a request
 * path that starts or stops applying the effort, fails here.
 */

/** Every `case "<provider>":` of constructLlmApi, read from its source. */
function providersOfConstructLlmApi(): string[] {
  const source = fs.readFileSync(path.resolve(__dirname, "index.ts"), "utf-8");
  const start = source.indexOf("export function constructLlmApi");
  const end = source.indexOf("\n}\n", start);
  const body = source.slice(start, end);
  return [...body.matchAll(/case "([^"]+)":/g)].map((m) => m[1]);
}

/** A model id each provider's adapter treats as able to reason. */
const MODEL: Record<string, string> = {
  anthropic: "claude-sonnet-4-5",
  bedrock: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  "bedrock-mantle": "openai.gpt-oss-120b",
  gemini: "gemini-2.5-flash",
  vertexai: "gemini-2.5-flash",
  deepseek: "deepseek-reasoner",
  openai: "o3",
  azure: "o3",
  "ai-sdk": "openai/o3",
};

interface Seen {
  url: string;
  body: any;
}

let server: http.Server;
let base = "";
const seen: Seen[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let body: unknown = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        // not JSON: kept as text
      }
      seen.push({ url: req.url ?? "", body });
      // A client error: no adapter retries it
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "probe", type: "probe" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * The fields of a request that can carry a reasoning effort: a thinking or
 * reasoning field of the provider's own, or `reasoning_effort` on an
 * OpenAI-style Chat Completions or Responses request. The same
 * `reasoning_effort` merged into any other API's body by the transport
 * (packages/fetch adds `extraBodyProperties` to every JSON body) is not one:
 * that API does not read it.
 */
function effortFields(sent: Seen | undefined): string {
  const body = sent?.body;
  if (!body || typeof body !== "object") return "";
  const openAIShaped = /\/(chat\/completions|responses)(\?|$)/.test(sent.url);
  return JSON.stringify([
    body.thinking,
    body.reasoning,
    body.generationConfig?.thinkingConfig,
    body.thinkingConfig,
    body.additionalModelRequestFields?.thinking,
    body.additionalModelRequestFields?.reasoningConfig,
    openAIShaped ? body.reasoning_effort : undefined,
  ]);
}

/**
 * The provider applies the effort when its request differs, in those
 * fields, from the same request without one.
 */
async function applies(provider: string): Promise<{
  applied: boolean;
  sent?: Seen;
}> {
  const sent = await probe(provider, true);
  const without = await probe(provider, false);
  return {
    applied: !!sent && effortFields(sent) !== effortFields(without),
    sent,
  };
}

/** The request one provider's chat call sends, or undefined when it sends none. */
async function probe(
  provider: string,
  withEffort: boolean,
): Promise<Seen | undefined> {
  const model = MODEL[provider] ?? "probe-model";
  const config: any = {
    provider,
    model,
    apiKey: "probe-key",
    apiBase: `${base}/v1/`,
    requestOptions: withEffort
      ? { extraBodyProperties: { reasoning_effort: "high" } }
      : {},
    // Vertex in express mode takes an API key and nothing else
    env:
      provider === "vertexai"
        ? undefined
        : {
            region: "us-east-1",
            accessKeyId: "AKIAPROBE",
            secretAccessKey: "probe",
            apiVersion: "2024-10-21",
            deployment: "probe",
            apiType: "azure-openai",
            projectId: "probe",
          },
  };
  const api = constructLlmApi(config);
  if (!api) return undefined;
  const request = {
    model,
    messages: [{ role: "user" as const, content: "hi" }],
  };
  if (provider === "bedrock") {
    // The AWS SDK signs and sends the request itself; the body the adapter
    // builds is what reaches Bedrock
    const input = (api as any)._convertBody(request);
    return { url: "converse", body: input };
  }
  const before = seen.length;
  if ((api as any).genAI) {
    // Google's SDK sends with its own client: its parameters are the request
    (api as any).genAI = {
      models: {
        generateContentStream: async (params: any) => {
          seen.push({ url: "genai", body: params.config });
          throw new Error("probe");
        },
      },
    };
  }
  try {
    // The CLI streams; the first chunk is enough to have sent the request
    const stream = api.chatCompletionStream(
      { ...request, stream: true },
      new AbortController().signal,
    );
    await stream.next();
  } catch {
    // the probe server answers 400
  }
  return seen.length > before ? seen[seen.length - 1] : undefined;
}

describe("which providers apply a configured reasoning_effort (M8)", () => {
  const providers = providersOfConstructLlmApi();

  it("reads the provider list from constructLlmApi", () => {
    expect(providers).toContain("openai");
    expect(providers).toContain("anthropic");
    expect(providers.length).toBeGreaterThan(30);
  });

  it("names only providers constructLlmApi knows", () => {
    for (const p of REASONING_EFFORT_NOT_APPLIED) {
      expect(providers, p).toContain(p);
    }
  });

  it.each(providersOfConstructLlmApi())(
    "%s: the table says what the request does",
    async (provider) => {
      const { applied, sent } = await applies(provider);
      expect(
        { provider, applied },
        `${provider}: ${sent ? `${sent.url} ${JSON.stringify(sent.body).slice(0, 300)}` : "no request"}`,
      ).toEqual({ provider, applied: appliesReasoningEffort(provider) });
    },
  );
});
