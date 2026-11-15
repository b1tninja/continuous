import type { ChatCompletionTool } from "openai/resources.mjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const recorded = vi.hoisted(() => [] as unknown[]);

vi.mock("../services/index.js", () => ({
  SERVICE_NAMES: { MODEL: "model", TOOL_PERMISSIONS: "toolPermissions" },
  serviceContainer: {
    get: vi.fn(async () => ({ assistant: undefined, authConfig: {} })),
    getSync: vi.fn(() => ({ value: { assistant: undefined } })),
  },
  services: {
    chatHistory: { getHistory: () => [] },
    toolPermissions: { getCurrentMode: () => "normal" },
  },
}));

vi.mock("../audit/cliAudit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../audit/cliAudit.js")>();
  return {
    ...actual,
    recordCliDecision: (...args: unknown[]) => {
      recorded.push(args);
    },
  };
});

import {
  cliToolListForRequest,
  noteToolHoldRequest,
  resetCliToolListHold,
} from "../tools/toolListHold.js";

import { checkToolPermissionApproval } from "./streamChatResponse.helpers.js";

const fn = (name: string): ChatCompletionTool => ({
  type: "function",
  function: { name, description: name, parameters: { type: "object" } },
});

const call = (name: string): any => ({
  id: "1",
  name,
  arguments: {},
  argumentsStr: "{}",
  tool: { name, isBuiltIn: false, mcpServer: "srv" },
});

const allowAll = { policies: [{ tool: "*", permission: "allow" as const }] };

beforeEach(() => {
  recorded.length = 0;
  resetCliToolListHold();
  const T0 = Date.now();
  cliToolListForRequest({
    live: [fn("srv_a"), fn("srv_b")],
    key: "k",
    model: "claude-sonnet-4-6",
    historyLength: 2,
    now: T0,
  });
  noteToolHoldRequest({
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    usage: {
      promptTokens: 366_000,
      completionTokens: 1,
      promptTokensDetails: { cachedTokens: 0, cacheWriteTokens: 0 },
    },
    at: T0,
  });
  // srv_b turned off while warm: still offered, so withheld
  cliToolListForRequest({
    live: [fn("srv_a")],
    key: "k",
    model: "claude-sonnet-4-6",
    historyLength: 4,
    now: T0 + 1000,
  });
});

describe("a withheld tool is refused at execution (C88)", () => {
  it("refuses with the reason and records it like other refusals", async () => {
    const r = await checkToolPermissionApproval(
      allowAll,
      call("srv_b"),
      {},
      false,
    );
    expect(r).toMatchObject({ approved: false, denialReason: "policy" });
    expect(r.denialMessage).toMatch(
      /^srv_b is turned off for this session; the change applies when the prompt cache goes cold\./,
    );
    expect(recorded).toHaveLength(1);
    const [, trace, result] = recorded[0] as [unknown, any, any];
    expect(trace.verdict).toMatchObject({
      decision: "deny",
      by: "system",
      source: "withheld",
    });
    expect(result.approved).toBe(false);
  });

  it("leaves a tool that is still on to the permission checks", async () => {
    const r = await checkToolPermissionApproval(
      allowAll,
      call("srv_a"),
      {},
      false,
    );
    expect(r.approved).toBe(true);
  });
});
