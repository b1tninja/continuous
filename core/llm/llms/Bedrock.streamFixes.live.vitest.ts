import { describe, expect, it } from "vitest";

import { ChatMessage, Tool, ToolCallDelta, Usage } from "../../index.js";
import { stoppedForLength } from "../../util/truncatedJson.js";
import {
  contextCorrectionFor,
  parseContextOverflow,
  resetContextCorrections,
} from "../contextOverflow.js";
import { calculateRequestCost } from "../utils/calculateRequestCost.js";
import Bedrock from "./Bedrock";

/**
 * Live check of the 2026-11-14 stream fixes against real Bedrock models:
 *
 * - every streamed tool-call fragment carries its call's id, so parallel
 *   calls assemble into complete, valid arguments (block-index stamping);
 * - a closed GPT or Grok model accepts the request although stop sequences
 *   and a small maxTokens were asked for (family rules drop and raise them);
 * - a reply cut at its output limit reports a length stop reason, and one
 *   that ended for a tool call does not ("cut off" only on a real cut);
 * - the cost of each answer is priced (GPT and Grok rows, regional premium);
 * - a prompt over the window is refused, the refusal is recognised, and a
 *   correction is learned when the provider gave the counts.
 *
 * Opt-in, and paid (well under a cent; the overflow request is refused
 * before inference):
 *
 *   RUN_LIVE_PROVIDER_TESTS=1 RUN_BEDROCK_LIVE=1 npx vitest run llm/llms/Bedrock.streamFixes.live.vitest.ts
 *
 * Knobs: LIVE_MODELS (comma-separated), LIVE_CUT_MODEL, LIVE_OVERFLOW_MODEL,
 * AWS_REGION. Credentials: AWS_BEARER_TOKEN_BEDROCK or the default chain.
 */
const live =
  process.env.RUN_LIVE_PROVIDER_TESTS === "1" &&
  process.env.RUN_BEDROCK_LIVE === "1"
    ? describe
    : (name: string, fn: () => void) =>
        describe.skip(
          `${name} (skipped: set RUN_LIVE_PROVIDER_TESTS=1 and RUN_BEDROCK_LIVE=1)`,
          fn,
        );

const REGION = process.env.AWS_REGION ?? "us-east-1";

const MODELS = (
  process.env.LIVE_MODELS ??
  "us.openai.gpt-6-luna,us.xai.grok-4.6,openai.gpt-oss-120b-1:0,us.anthropic.claude-haiku-4-5-20251001-v1:0"
)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

/**
 * Models the probes saw make both calls in one reply. GPT OSS makes one call
 * per reply by choice, so only the fragment ids and arguments are checked.
 */
const PARALLEL = /openai\.gpt-(?!oss)|xai\.grok|anthropic\./i;

/**
 * A model without a maxTokens floor (the family rules raise GPT OSS, closed
 * GPT and Grok to 1024), so a short limit really cuts.
 */
const CUT_MODEL =
  process.env.LIVE_CUT_MODEL ?? "us.anthropic.claude-haiku-4-5-20251001-v1:0";
/** A model with a small window: GPT OSS has 128k. */
const OVERFLOW_MODEL =
  process.env.LIVE_OVERFLOW_MODEL ?? "openai.gpt-oss-120b-1:0";

const weather: Tool = {
  type: "function",
  displayTitle: "Get weather",
  readonly: true,
  group: "test",
  function: {
    name: "get_weather",
    description: "Get the current weather for a city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
};

const writeFile: Tool = {
  type: "function",
  displayTitle: "Write file",
  readonly: false,
  group: "test",
  function: {
    name: "write_file",
    description: "Write text to a file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, contents: { type: "string" } },
      required: ["path", "contents"],
    },
  },
};

interface StreamResult {
  fragments: ToolCallDelta[];
  calls: Map<string, { name: string; args: string }>;
  usage?: Usage;
  text: string;
}

async function stream(
  llm: Bedrock,
  messages: ChatMessage[],
  options: Parameters<Bedrock["streamChat"]>[2],
): Promise<StreamResult> {
  const result: StreamResult = { fragments: [], calls: new Map(), text: "" };
  for await (const message of llm.streamChat(
    messages,
    new AbortController().signal,
    options,
  )) {
    if (message.role !== "assistant") continue;
    if (typeof message.content === "string") result.text += message.content;
    if (message.usage) result.usage = message.usage;
    for (const tc of message.toolCalls ?? []) {
      result.fragments.push(tc);
      // The GUI assembles fragments by id, so that is what is checked here
      const id = tc.id ?? "";
      const call = result.calls.get(id) ?? { name: "", args: "" };
      if (tc.function?.name) call.name = tc.function.name;
      call.args += tc.function?.arguments ?? "";
      result.calls.set(id, call);
    }
  }
  return result;
}

function parses(raw: string): boolean {
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

live("Bedrock stream fixes (live)", () => {
  describe.each(MODELS)("%s", (model) => {
    it("parallel tool calls: every fragment has its call's id, arguments are complete, cost is priced", async () => {
      const llm = new Bedrock({
        model,
        region: REGION,
        capabilities: { tools: true },
      });
      const r = await stream(
        llm,
        [
          {
            role: "user",
            content:
              "Get the weather in Paris and in Tokyo. Call get_weather once per city, both calls in this reply.",
          },
        ],
        // stop and a small maxTokens on purpose: the family rules must make
        // this acceptable to models that refuse them
        { tools: [weather], maxTokens: 400, stop: ["END_OF_ANSWER"] },
      );
      const stopReason = r.usage?.response?.stopReason;
      const cost = r.usage
        ? calculateRequestCost("bedrock", model, r.usage)
        : null;
      console.log(
        `LIVE ${model} | fragments=${r.fragments.length} | calls=${JSON.stringify(
          [...r.calls.entries()].map(
            ([id, c]) => `${c.name}(${c.args}) id=${id ? "yes" : "NO"}`,
          ),
        )} | stop=${stopReason} | usage=${r.usage?.promptTokens}/${r.usage?.completionTokens} | cost=${cost ? `$${cost.cost.toFixed(6)}` : "UNPRICED"}${cost ? ` (${cost.breakdown.split("\n")[1]})` : ""}`,
      );

      expect(r.fragments.length).toBeGreaterThan(0);
      for (const f of r.fragments)
        expect(f.id, "a fragment without an id").toBeTruthy();
      expect(r.calls.size).toBeGreaterThanOrEqual(PARALLEL.test(model) ? 2 : 1);
      for (const [, c] of r.calls) {
        expect(c.name).toBe("get_weather");
        expect(parses(c.args), `arguments ${c.args}`).toBe(true);
      }
      // Ended for the tool calls, not the output limit: no "cut off"
      expect(stoppedForLength(stopReason)).toBe(false);
      expect(cost, "the request should be priced").not.toBeNull();
      expect(cost!.cost).toBeGreaterThan(0);
    }, 180_000);
  });

  it(`a reply cut at its output limit says so (${CUT_MODEL})`, async () => {
    const llm = new Bedrock({
      model: CUT_MODEL,
      region: REGION,
      capabilities: { tools: true },
    });
    const r = await stream(
      llm,
      [
        {
          role: "user",
          content:
            "Use write_file to write a 300-word story about a lighthouse to story.txt. Call the tool directly, no preamble.",
        },
      ],
      { tools: [writeFile], maxTokens: 120, reasoning: false },
    );
    const stopReason = r.usage?.response?.stopReason;
    console.log(
      `LIVE cut ${CUT_MODEL} | stop=${stopReason} | calls=${JSON.stringify(
        [...r.calls.values()].map(
          (c) => `${c.name} ${c.args.length} chars, valid=${parses(c.args)}`,
        ),
      )} | text=${r.text.length}`,
    );
    expect(stoppedForLength(stopReason)).toBe(true);
  }, 120_000);

  it(`a prompt over the window is recognised as an overflow (${OVERFLOW_MODEL})`, async () => {
    resetContextCorrections();
    // Claim a large window, so the prompt is not pruned before it is sent
    const llm = new Bedrock({
      model: OVERFLOW_MODEL,
      region: REGION,
      contextLength: 2_000_000,
    });
    // About 200k tokens of varied text, over GPT OSS's 128k
    const filler = Array.from(
      { length: 40_000 },
      (_, i) => `line ${i} of the log reads value ${(i * 7919) % 10007}.`,
    ).join("\n");
    let error: unknown;
    try {
      await stream(llm, [{ role: "user", content: `${filler}\n\nSay ok.` }], {
        maxTokens: 64,
      });
    } catch (e) {
      error = e;
    }
    const message = error instanceof Error ? error.message : String(error);
    const overflow = parseContextOverflow(message);
    console.log(
      `LIVE overflow ${OVERFLOW_MODEL} | error=${JSON.stringify(message.slice(0, 300))} | parsed=${JSON.stringify(overflow)} | correction=${contextCorrectionFor(OVERFLOW_MODEL)}`,
    );
    expect(error, "the provider should refuse the prompt").toBeDefined();
    expect(overflow, "the refusal should be recognised").toBeDefined();
    if (overflow?.actualTokens) {
      expect(contextCorrectionFor(OVERFLOW_MODEL)).toBeGreaterThanOrEqual(1);
    }
  }, 180_000);
});
