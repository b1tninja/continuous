import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
} from "@aws-sdk/client-bedrock-runtime";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../..";
import { BuiltInToolNames } from "../../../tools/builtIn";
import { answerRead, systemMessageFor, type ScoredCall } from "./runner";
import { TURN_SCENARIOS } from "./scenarios";

/**
 * K2 probe (plans/turn-prompt-eval.md section 4, item 3): Nova 2 Lite, after
 * two rounds of reads in a plan turn, writes its deliberation as plain text
 * up to the output budget and never calls present_plan. Core used to send
 * Nova 2 no `reasoningConfig` unless reasoning was switched on; since this
 * probe it sends low by default (bedrockReasoningFields). This sends the eval's
 * reserved-choice conversation straight to Bedrock Converse under three
 * settings and reports what came back: text length, reasoning blocks, tool
 * calls, stop reason. It decides nothing by itself; read the table.
 *
 * Opt-in, billed (under a cent per run on Nova 2 Lite):
 *
 *   RUN_LIVE_PROVIDER_TESTS=1 RUN_BEDROCK_LIVE=1 AWS_PROFILE=torgate npx vitest run llm/prompts/evaluation/novaReasoning.live.vitest.ts
 *
 * Knobs: LIVE_MODEL (default us.amazon.nova-2-lite-v1:0), AWS_REGION
 * (default us-east-1), LIVE_RUNS (default 2), LIVE_SCENARIO (default
 * plan-reserved-choice), LIVE_PROFILE (default full).
 */
// Paid calls: RUN_LIVE_PROVIDER_TESTS=1 is the consent, RUN_BEDROCK_LIVE=1 selects Bedrock.
// AWS credentials come from the default chain, so there is no key to check here.
const live =
  process.env.RUN_LIVE_PROVIDER_TESTS === "1" &&
  process.env.RUN_BEDROCK_LIVE === "1"
    ? describe
    : (name: string, fn: () => void) =>
        describe.skip(
          `${name} (skipped: set RUN_LIVE_PROVIDER_TESTS=1 and RUN_BEDROCK_LIVE=1)`,
          fn,
        );

const MODEL = process.env.LIVE_MODEL ?? "us.amazon.nova-2-lite-v1:0";
const REGION = process.env.AWS_REGION ?? "us-east-1";
const RUNS = Number(process.env.LIVE_RUNS ?? 2);
const SCENARIO = process.env.LIVE_SCENARIO ?? "plan-reserved-choice";
const PROFILE = (process.env.LIVE_PROFILE ?? "full") as "full" | "short";
const MAX_TOKENS = 4000;
const MAX_READ_ROUNDS = 3;

const SETTINGS: Record<string, Record<string, unknown> | undefined> = {
  none: undefined,
  disabled: { reasoningConfig: { type: "disabled" } },
  "enabled-low": {
    reasoningConfig: { type: "enabled", maxReasoningEffort: "low" },
  },
};

const READ_TOOLS = new Set<string>([
  BuiltInToolNames.ReadFile,
  BuiltInToolNames.LSTool,
  BuiltInToolNames.GrepSearch,
]);

function toConverse(messages: ChatMessage[]): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({
        role: "user",
        content: [{ text: typeof m.content === "string" ? m.content : "" }],
      });
    } else if (m.role === "assistant") {
      const content: any[] = [];
      if (typeof m.content === "string" && m.content) {
        content.push({ text: m.content });
      }
      for (const c of m.toolCalls ?? []) {
        content.push({
          toolUse: {
            toolUseId: c.id,
            name: c.function?.name,
            input: JSON.parse(c.function?.arguments || "{}"),
          },
        });
      }
      out.push({ role: "assistant", content });
    } else if (m.role === "tool") {
      const block = {
        toolResult: { toolUseId: m.toolCallId, content: [{ text: m.content }] },
      };
      const last = out[out.length - 1];
      if (last?.role === "user" && (last.content as any[])[0]?.toolResult) {
        (last.content as any[]).push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    }
  }
  return out;
}

interface Round {
  text: number;
  reasoning: number;
  calls: string[];
  stopReason: string | undefined;
}

live("Nova 2 reasoningConfig and plain-text deliberation", () => {
  it(
    "reports text length, reasoning blocks, calls and stop reason per setting",
    async () => {
      const scenario = TURN_SCENARIOS.find((s) => s.id === SCENARIO);
      if (!scenario?.seed) throw new Error(`no plan scenario ${SCENARIO}`);
      const client = new BedrockRuntimeClient({
        region: REGION,
        credentials: fromNodeProviderChain({
          profile: process.env.AWS_PROFILE,
          ignoreCache: true,
        }),
      });
      const toolConfig = {
        tools: scenario.tools.map((t) => ({
          toolSpec: {
            name: t.function.name,
            description: t.function.description,
            inputSchema: { json: t.function.parameters },
          },
        })),
        toolChoice: { auto: {} },
      } as any;

      const rows: string[] = [];
      for (const [setting, fields] of Object.entries(SETTINGS)) {
        for (let run = 1; run <= RUNS; run++) {
          const history: ChatMessage[] = [...scenario.messages];
          const rounds: Round[] = [];
          let error: string | undefined;
          for (let round = 0; round <= MAX_READ_ROUNDS; round++) {
            let res: any;
            try {
              // Built loosely on purpose: the probe's point is the raw field.
              const input: any = {
                modelId: MODEL,
                system: [{ text: systemMessageFor("plan", PROFILE) }],
                messages: toConverse(history),
                toolConfig,
                inferenceConfig: { maxTokens: MAX_TOKENS, temperature: 0 },
                ...(fields ? { additionalModelRequestFields: fields } : {}),
              };
              res = await client.send(new ConverseCommand(input));
            } catch (e: any) {
              error = String(e?.message ?? e).slice(0, 160);
              break;
            }
            const blocks: any[] = res.output?.message?.content ?? [];
            const text = blocks
              .filter((b) => b.text)
              .map((b) => b.text as string)
              .join("");
            const reasoning = blocks
              .filter((b) => b.reasoningContent)
              .map(
                (b) =>
                  b.reasoningContent?.reasoningText?.text ??
                  (b.reasoningContent?.redactedContent ? "[redacted]" : ""),
              )
              .join("");
            const calls: ScoredCall[] = blocks
              .filter((b) => b.toolUse)
              .map((b) => ({
                name: b.toolUse.name as string,
                args: (b.toolUse.input ?? {}) as Record<string, unknown>,
                id: b.toolUse.toolUseId as string,
              }));
            rounds.push({
              text: text.length,
              reasoning: reasoning.length,
              calls: calls.map((c) => c.name),
              stopReason: res.stopReason,
            });
            const onlyReads =
              calls.length > 0 && calls.every((c) => READ_TOOLS.has(c.name));
            if (!onlyReads || round === MAX_READ_ROUNDS) break;
            history.push({
              role: "assistant",
              content: text,
              toolCalls: calls.map((c: any) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              })),
            });
            for (const c of calls as any[]) {
              history.push({
                role: "tool",
                toolCallId: c.id,
                content: answerRead(scenario.seed, c),
              });
            }
          }
          const last = rounds[rounds.length - 1];
          rows.push(
            `| ${setting} | ${run} | ${error ? `error: ${error}` : rounds.length - 1} | ${last ? last.text : "-"} | ${last ? last.reasoning : "-"} | ${last ? last.calls.join(", ") || "(none)" : "-"} | ${last?.stopReason ?? "-"} |`,
          );
        }
      }
      const table = [
        `### ${MODEL}, ${SCENARIO}, ${PROFILE} profile, ${MAX_TOKENS} max tokens`,
        "",
        "| Setting | Run | Read rounds | Final text chars | Final reasoning chars | Final calls | Stop reason |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        ...rows,
      ].join("\n");
      process.stdout.write(`\n${table}\n`);
      expect(rows.length).toBeGreaterThan(0);
    },
    20 * 60_000,
  );
});
