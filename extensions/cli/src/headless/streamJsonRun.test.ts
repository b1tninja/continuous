import fs from "fs";
import path from "path";

import type { ChatHistoryItem, SessionUsage } from "core/index.js";
import { z } from "zod";

import {
  STREAM_JSON_EVENT_TYPES,
  STREAM_JSON_SCHEMA_VERSION,
} from "./streamJsonEvents.js";
import {
  STREAM_JSON_ARG_CHARS,
  STREAM_JSON_OUTPUT_CHARS,
  StreamJsonRun,
} from "./streamJsonRun.js";

const SCHEMA_FILE = path.resolve(
  __dirname,
  "../../spec/stream-json.schema.json",
);
const schemaJson = JSON.parse(fs.readFileSync(SCHEMA_FILE, "utf-8"));
const lineSchema = z.fromJSONSchema(schemaJson);

/** A planted credential: it must never reach a line. */
const CANARY = "sk-ant-api03-CANARYCANARYCANARYCANARY0123456789";

function usage(total: number, prompt: number, completion: number) {
  return {
    totalCost: total,
    promptTokens: prompt,
    completionTokens: completion,
    promptTokensDetails: { cachedTokens: 0, cacheWriteTokens: 0 },
  } as SessionUsage;
}

function call(
  id: string,
  args: Record<string, unknown>,
  status: string,
  output?: string,
): ChatHistoryItem {
  return {
    message: { role: "assistant", content: "" },
    contextItems: [],
    toolCallStates: [
      {
        toolCallId: id,
        toolCall: {
          id,
          type: "function",
          function: { name: "Bash", arguments: JSON.stringify(args) },
        },
        status: status as never,
        parsedArgs: args,
        ...(output === undefined
          ? {}
          : { output: [{ name: "r", description: "r", content: output }] }),
      },
    ],
  };
}

function harness() {
  const lines: string[] = [];
  let clock = Date.parse("2026-11-12T10:00:00.000Z");
  let current = usage(0.5, 1000, 100); // restored with a resumed session
  const run = new StreamJsonRun({
    write: (l) => lines.push(l),
    now: () => (clock += 10),
    usage: () => current,
  });
  return {
    run,
    lines,
    events: () => lines.map((l) => JSON.parse(l)),
    setUsage: (u: SessionUsage) => (current = u),
  };
}

function fullRun() {
  const h = harness();
  h.run.init(
    {
      sessionId: "s1",
      cliVersion: "1.0.0",
      model: "m",
      provider: "openai",
      cwd: "/w",
      mode: "normal",
      limits: { maxTurns: 3 },
    },
    [call("old", { command: "ls" }, "done", "a")],
  );
  h.setUsage(usage(0.52, 1600, 140));
  h.run.requestDone();
  h.run.message(`Running it with ANTHROPIC_API_KEY=${CANARY}`);
  const args = { command: `curl -H "x-api-key: ${CANARY}" x` };
  h.run.observeHistory([
    call("old", { command: "ls" }, "done", "a"),
    call("c1", args, "generated"),
  ]);
  h.run.toolDecision(
    { id: "c1", name: "Bash" },
    {
      verdict: {
        by: "rules",
        source: "config",
        rule: "deny: Bash(curl *)",
        reason: `no ${CANARY}`,
      },
    },
    { approved: false },
  );
  h.run.observeHistory([
    call("c1", args, "canceled", `refused; key was ${CANARY}`),
  ]);
  h.run.finish({ status: "success", exitCode: 0, result: "Done." });
  return h;
}

describe("stream-json events", () => {
  it("every line is one JSON object the schema accepts", () => {
    const { lines } = fullRun();
    expect(lines.length).toBeGreaterThan(5);
    for (const line of lines) {
      expect(line.endsWith("\n")).toBe(true);
      expect(line.slice(0, -1)).not.toContain("\n");
      const parsed = lineSchema.safeParse(JSON.parse(line));
      expect(parsed.success, line).toBe(true);
    }
  });

  it("orders the run: init first, result last, seq 1..n, one call's events in order", () => {
    const events = fullRun().events();
    expect(events.map((e) => e.type)).toEqual([
      "init",
      "usage",
      "message",
      "tool_use",
      "tool_decision",
      "tool_result",
      "result",
    ]);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events[0].schemaVersion).toBe(STREAM_JSON_SCHEMA_VERSION);
    expect(events.at(-1).schemaVersion).toBe(STREAM_JSON_SCHEMA_VERSION);
  });

  it("never writes the canary, in any field", () => {
    const { lines } = fullRun();
    const all = lines.join("");
    expect(all).not.toContain(CANARY);
    expect(all).toContain("«masked:");
  });

  it("counts this run only: a resumed session's calls and spend are left out", () => {
    const events = fullRun().events();
    const usageLine = events.find((e) => e.type === "usage");
    expect(usageLine).toMatchObject({
      request: 1,
      inputTokens: 600,
      outputTokens: 40,
      costUsd: 0.02,
      totalCostUsd: 0.02,
    });
    expect(events.filter((e) => e.type === "tool_use")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      status: "success",
      exitCode: 0,
      result: "Done.",
      numRequests: 1,
      numToolCalls: 1,
      numRefusals: 1,
      totalCostUsd: 0.02,
    });
  });

  it("reports a refusal with who decided and why", () => {
    const decision = fullRun()
      .events()
      .find((e) => e.type === "tool_decision");
    expect(decision).toMatchObject({
      callId: "c1",
      decision: "refused",
      by: "rules",
      source: "config",
      rule: "deny: Bash(curl *)",
    });
  });

  it("marks a call put to a person as asked, with the answer", () => {
    const h = harness();
    h.run.toolDecision(
      { id: "c", name: "Write" },
      { askedPerson: true },
      { approved: true },
    );
    h.run.toolDecision(
      { id: "d", name: "Write" },
      { held: true },
      { approved: false, denialMessage: "Held for the person." },
    );
    const [asked, held] = h.events();
    expect(asked).toMatchObject({
      decision: "asked",
      by: "person",
      answer: "approved",
    });
    expect(held).toMatchObject({ decision: "asked", held: true });
  });

  it("caps tool output and long arguments", () => {
    const h = harness();
    const big = "x".repeat(STREAM_JSON_OUTPUT_CHARS * 3);
    h.run.observeHistory([
      call(
        "c",
        { content: "y".repeat(STREAM_JSON_ARG_CHARS * 2) },
        "done",
        big,
      ),
    ]);
    const [use, result] = h.events();
    expect(use.args.content.length).toBeLessThan(STREAM_JSON_ARG_CHARS + 10);
    expect(result.output.length).toBeLessThan(STREAM_JSON_OUTPUT_CHARS + 10);
    expect(result).toMatchObject({
      truncated: true,
      outputLength: big.length,
    });
  });

  it("writes nothing after result, and result only once", () => {
    const h = harness();
    h.run.finish({ status: "interrupted", exitCode: 130 });
    h.run.message("late");
    h.run.finish({ status: "success", exitCode: 0 });
    expect(h.events().map((e) => e.type)).toEqual(["result"]);
    expect(h.events()[0].status).toBe("interrupted");
  });

  it("writes error then result on a failure", () => {
    const h = harness();
    h.run.error("provider", `401 for key ${CANARY}`, "auth");
    h.run.finish({ status: "error", exitCode: 1 });
    const lines = h.lines.join("");
    expect(lines).not.toContain(CANARY);
    expect(h.events().map((e) => e.type)).toEqual(["error", "result"]);
    for (const l of h.lines) {
      expect(lineSchema.safeParse(JSON.parse(l)).success).toBe(true);
    }
  });

  it("the JSON Schema and the TypeScript type list the same event types", () => {
    expect(Object.keys(schemaJson.$defs).sort()).toEqual(
      [...STREAM_JSON_EVENT_TYPES].sort(),
    );
    for (const type of STREAM_JSON_EVENT_TYPES) {
      expect(schemaJson.$defs[type].properties.type.const).toBe(type);
      expect(schemaJson.$defs[type].additionalProperties).toBe(false);
    }
    expect(schemaJson.$defs.init.properties.schemaVersion.const).toBe(
      STREAM_JSON_SCHEMA_VERSION,
    );
  });

  it("the schema rejects an unknown field and a wrong decision", () => {
    const base = {
      type: "tool_decision",
      seq: 1,
      time: "t",
      callId: "c",
      tool: "Bash",
      by: "rules",
    };
    expect(lineSchema.safeParse({ ...base, decision: "allowed" }).success).toBe(
      true,
    );
    expect(lineSchema.safeParse({ ...base, decision: "maybe" }).success).toBe(
      false,
    );
    expect(
      lineSchema.safeParse({ ...base, decision: "allowed", extra: 1 }).success,
    ).toBe(false);
  });
});

describe("stream-json price sources", () => {
  const modelUsage = (priced: number, extra: Record<string, unknown> = {}) => ({
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    requests: priced,
    pricedRequests: priced,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    ...extra,
  });
  const curated = {
    kind: "curated",
    label: "Anthropic list prices",
    url: "https://platform.claude.com/docs/en/about-claude/pricing",
    asOf: "2026-11-02",
  };
  const community = {
    kind: "community",
    label: "community catalogue (models.dev)",
    url: "https://models.dev/api.json",
    asOf: "2026-11-10T08:00:00.000Z",
  };

  it("usage carries the request's source and tier; result lists the run's sources", () => {
    const h = harness();
    // Resumed with a model priced before this run: not one of this run's sources
    h.setUsage({
      ...usage(0.5, 1000, 100),
      byModel: {
        "openai/gpt-4o": {
          ...modelUsage(3),
          provider: "openai",
          model: "gpt-4o",
          priceSource: {
            kind: "curated",
            label: "OpenAI pricing page (Standard tier)",
          },
        },
      },
    });
    h.run.init(
      {
        sessionId: "s1",
        cliVersion: "1.0.0",
        model: "m",
        provider: "anthropic",
        cwd: "/w",
        mode: "normal",
      },
      [],
    );
    h.setUsage({
      ...usage(0.6, 2000, 200),
      byModel: {
        "openai/gpt-4o": { ...modelUsage(3), provider: "openai" },
        "anthropic/claude-sonnet-4-5": modelUsage(1, {
          priceSource: curated,
          servedTier: "priority",
        }),
      },
    });
    h.run.requestDone();
    h.setUsage({
      ...usage(0.7, 3000, 300),
      byModel: {
        "openai/gpt-4o": { ...modelUsage(3), provider: "openai" },
        "anthropic/claude-sonnet-4-5": modelUsage(1, {
          priceSource: curated,
          servedTier: "priority",
        }),
        "mistral/mistral-large-latest": modelUsage(1, {
          provider: "mistral",
          model: "mistral-large-latest",
          priceSource: community,
        }),
      },
    });
    h.run.requestDone();
    h.run.finish({ status: "success", exitCode: 0, result: "ok" });
    const events = h.events();
    const usages = events.filter((e) => e.type === "usage");
    expect(usages[0].priceSource).toEqual(curated);
    expect(usages[0].servedTier).toBe("priority");
    expect(usages[1].priceSource).toEqual(community);
    expect(usages[1].servedTier).toBeUndefined();
    const result = events.at(-1);
    expect(result.priceSources).toEqual([curated, community]);
    expect(result.servedTiers).toEqual(["priority"]);
    for (const line of h.lines) {
      expect(lineSchema.safeParse(JSON.parse(line)).success).toBe(true);
    }
  });

  it("an unpriced request has no priceSource, and the result an empty list", () => {
    const h = harness();
    h.run.init(
      {
        sessionId: "s1",
        cliVersion: "1.0.0",
        model: "m",
        provider: "ollama",
        cwd: "/w",
        mode: "normal",
      },
      [],
    );
    h.setUsage(usage(0.5, 2000, 200));
    h.run.requestDone();
    h.run.finish({ status: "success", exitCode: 0, result: "ok" });
    const events = h.events();
    expect(events.find((e) => e.type === "usage").priceSource).toBeUndefined();
    expect(events.at(-1).priceSources).toEqual([]);
  });

  it("the schema rejects an unknown price source kind", () => {
    const h = harness();
    h.run.finish({ status: "success", exitCode: 0, result: "ok" });
    const result = {
      ...h.events().at(-1),
      priceSources: [{ kind: "guess", label: "x" }],
    };
    expect(lineSchema.safeParse(result).success).toBe(false);
  });
});

describe("stream-json model lines (M7)", () => {
  it("writes a model line for each switch after init, schema-valid, masked", () => {
    const h = harness();
    // before init nothing is written: init names the start model
    h.run.modelInUse({
      name: "Early",
      model: "early",
      provider: "openai",
      reason: "use",
    });
    h.run.init(
      {
        sessionId: "s1",
        cliVersion: "1.0.0",
        model: "m",
        provider: "openai",
        cwd: "/w",
        mode: "plan",
        reasoningEffort: "high",
      },
      [],
    );
    h.run.modelInUse({
      name: "Start",
      model: "start",
      provider: "openai",
      reason: "start",
    });
    h.run.modelInUse({
      name: "Opus",
      model: "claude-opus",
      provider: "anthropic",
      effort: "high",
      reason: "use",
      use: "plan",
    });
    h.run.modelInUse({
      name: "Nova",
      model: "nova",
      provider: "bedrock",
      reason: "use",
      use: "loop",
      fallbackReason: `model "${CANARY}" is not configured; using Nova`,
    });
    h.run.modelInUse({
      name: "Helper",
      model: "helper",
      provider: "openai",
      reason: "subagent",
      use: "subagent",
      agent: "Helper",
    });
    h.run.finish({ status: "success", exitCode: 0, result: "" });
    const events = h.events();
    expect(events.map((e) => e.type)).toEqual([
      "init",
      "model",
      "model",
      "model",
      "result",
    ]);
    expect(events[0].reasoningEffort).toBe("high");
    expect(events[1]).toMatchObject({
      model: "claude-opus",
      name: "Opus",
      reasoningEffort: "high",
      reason: "use",
      use: "plan",
    });
    expect(events[2].reasoningEffort).toBeUndefined();
    expect(events[3]).toMatchObject({ reason: "subagent", agent: "Helper" });
    expect(h.lines.join("")).not.toContain(CANARY);
    for (const l of h.lines) {
      expect(lineSchema.safeParse(JSON.parse(l)).success, l).toBe(true);
    }
  });
});
