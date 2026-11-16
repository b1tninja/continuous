import { resetWebGrantsForTests } from "core/tools/permissions/webGrants.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  model: { assistant: undefined as any, authConfig: {} as any },
}));

vi.mock("../services/index.js", () => ({
  SERVICE_NAMES: { MODEL: "model", TOOL_PERMISSIONS: "toolPermissions" },
  serviceContainer: {
    get: vi.fn(async () => state.model),
    getSync: vi.fn(() => ({ value: state.model })),
  },
  services: { chatHistory: { getHistory: () => [] } },
}));

vi.mock("core/tools/permissions/audit/global.js", () => ({
  getAuditTrail: () => ({
    enabled: false,
    decision: vi.fn(),
    answer: vi.fn(),
    outcome: vi.fn(),
  }),
}));

// HEADLESS_FETCH_FOLLOWS_WEB_LEVEL flipped, as it will be in 2.36
vi.mock("../permissions/headlessPolicy.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../permissions/headlessPolicy.js")>();
  return {
    ...actual,
    HEADLESS_FETCH_FOLLOWS_WEB_LEVEL: true,
    webFetchDefault: (args: Parameters<typeof actual.webFetchDefault>[0]) =>
      actual.webFetchDefault({ ...args, headlessFollows: true }),
  };
});

import { getDefaultToolPolicies } from "../permissions/defaultPolicies.js";
import { resetHeadlessRefusalNotes } from "../permissions/headlessPolicy.js";

import { checkToolPermissionApproval } from "./streamChatResponse.helpers.js";

const fetchCall = (url: string): any => ({
  id: "call-fetch",
  name: "Fetch",
  arguments: { url },
  argumentsStr: JSON.stringify({ url }),
  tool: {},
});

afterEach(() => {
  resetWebGrantsForTests();
  resetHeadlessRefusalNotes();
  vi.restoreAllMocks();
});

describe("headless cn with HEADLESS_FETCH_FOLLOWS_WEB_LEVEL = true (2.36)", () => {
  it("Cautious acts as Listed: a host nobody allowed is refused, with no transition line", async () => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((l: any) => {
      lines.push(String(l));
      return true;
    });
    const r = await checkToolPermissionApproval(
      { policies: getDefaultToolPolicies(true) },
      fetchCall("https://new.example/"),
      {},
      true,
    );
    expect(r.approved).toBe(false);
    expect(r.denialMessage).toContain("headless");
    expect(lines.some((l) => l.includes("from 2.36"))).toBe(false);
  });

  it("an allowed host still runs", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const r = await checkToolPermissionApproval(
      {
        policies: [
          { tool: "host:docs.example.com", permission: "allow" },
          ...getDefaultToolPolicies(true),
        ],
      },
      fetchCall("https://docs.example.com/x"),
      {},
      true,
    );
    expect(r).toEqual({ approved: true });
  });
});
