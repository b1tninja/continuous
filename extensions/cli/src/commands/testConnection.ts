/**
 * `continuous test-connection --provider P [--api-base URL] [--api-key-env NAME]
 * [--model M] [--json]`: the add-model form's Test connection for any
 * OpenAI-compatible endpoint (core/util/openaiCompatTest.ts). It lists the
 * served models and, with --model, sends one request offering a made-up tool
 * (never run). The key is read from the named environment variable and is
 * never printed. The result is written to the local measured-facts file
 * (host name only, owner-only, never a key); `--no-record` or
 * `probes.record: false` in ~/.continuous/config.yaml turns that off. When the
 * model wrote its call as text the output ends with a config snippet to
 * paste: nothing is changed automatically. With `--provider anthropic` it
 * lists models with the user's own key (ANTHROPIC_API_KEY, or the variable
 * named by --api-key-env) and, with --model, warns when that model is deprecated
 * or retiring (core/util/anthropicSurfaceTest.ts). With --model the id itself
 * is checked (`GET /models/{id}`): an id the key cannot reach is named with
 * close matches from the list (core/util/providerModelLookup.ts).
 */

import {
  testOpenAICompatConnection,
  type OpenAICompatTestResult,
  type TestFetch,
} from "core/util/openaiCompatTest.js";
import { recoveryOffer, recoverySnippet } from "core/util/recoveryOffer.js";

export interface TestConnectionOptions {
  provider?: string;
  apiBase?: string;
  apiKeyEnv?: string;
  model?: string;
  json?: boolean;
  /** Commander's `--no-record` sets this to false. */
  record?: boolean;
  /** For tests. */
  measuredFile?: string;
  noticeFile?: string;
  now?: string;
  fetchFn?: TestFetch;
  env?: Record<string, string | undefined>;
}

export function formatTestResult(
  r: OpenAICompatTestResult,
  ctx?: { provider: string; model?: string },
): string[] {
  if (!r.ok) return [`Could not connect: ${r.error}`];
  const lines = [
    `Connected. ${r.models.length} model${r.models.length === 1 ? "" : "s"} listed${
      r.models.length ? `: ${r.models.slice(0, 10).join(", ")}` : ""
    }${r.models.length > 10 ? ", ..." : ""}`,
  ];
  if (r.modelCheck) {
    lines.push(
      r.modelCheck.status === "found"
        ? `Model: ${r.modelCheck.summary}`
        : r.modelCheck.status === "not-found"
          ? `Warning: ${r.modelCheck.message}`
          : `Model not checked: ${r.modelCheck.message}`,
    );
  }
  if (r.probe) {
    lines.push(
      r.probe.ok
        ? r.probe.label
        : `Tool use: could not tell (${r.probe.error})`,
    );
    if (r.probe.ok && r.probe.serverParses) {
      lines.push("The server parses this model's tool calls itself.");
    }
    if (r.probe.ok && r.probe.preset) {
      lines.push(`Known format for this model family: ${r.probe.preset}`);
    }
    if (r.probe.ok && r.probe.facts) lines.push(r.probe.facts);
    if (r.probe.ok && r.probe.recorded) {
      lines.push(
        `Recorded locally (${r.probe.recorded.n} probe${r.probe.recorded.n === 1 ? "" : "s"}; one probe is not enough to act on). Turn off with --no-record.`,
      );
    }
    const offer =
      ctx?.model && r.probe.ok
        ? recoveryOffer(r.probe, ctx.provider, "cli")
        : undefined;
    if (offer && ctx?.model) {
      lines.push(
        "To read these calls, add this to your config.yaml (nothing was changed):",
        ...recoverySnippet(ctx.provider, ctx.model, offer.dialect).map(
          (l) => `  ${l}`,
        ),
      );
    }
  }
  if (r.template) lines.push(r.template);
  for (const n of r.retirement ?? []) {
    lines.push(
      `Warning: ${n.message}${n.from === "live" ? " (from your key)" : ""}`,
    );
  }
  return lines;
}

/** Exit code: 0 connected, 1 failed, 2 bad arguments. */
export async function testConnectionCommand(
  options: TestConnectionOptions,
): Promise<number> {
  if (!options.provider) {
    process.stderr.write("test-connection needs --provider\n");
    return 2;
  }
  const env = options.env ?? process.env;
  // Anthropic is tested with the user's own key: ANTHROPIC_API_KEY unless --api-key-env names another.
  const keyEnv =
    options.apiKeyEnv ??
    (options.provider === "anthropic" ? "ANTHROPIC_API_KEY" : undefined);
  const apiKey = keyEnv ? env[keyEnv] : undefined;
  if (keyEnv && !apiKey) {
    process.stderr.write(`The environment variable ${keyEnv} is not set\n`);
    return 2;
  }
  const result = await testOpenAICompatConnection({
    provider: options.provider,
    apiBase: options.apiBase,
    apiKey,
    model: options.model,
    checkModel: options.model,
    fetchFn: options.fetchFn,
    record: options.record !== false,
    measuredFile: options.measuredFile,
    noticeFile: options.noticeFile,
    now: options.now,
  });
  process.stdout.write(
    options.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : `${formatTestResult(result, { provider: options.provider, model: options.model }).join("\n")}\n`,
  );
  return result.ok ? 0 : 1;
}
