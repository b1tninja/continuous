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

import { getDefaultToolPolicies } from "../permissions/defaultPolicies.js";
import { resetHeadlessRefusalNotes } from "../permissions/headlessPolicy.js";
import {
  resetPolicyLevels,
  setPolicyLevels,
} from "../permissions/policyLevels.js";
import type { ToolPermissions } from "../permissions/types.js";
import { grantWebHostForSession } from "../permissions/webSession.js";

import { checkToolPermissionApproval } from "./streamChatResponse.helpers.js";

/**
 * WB45 in `cn`: a Fetch that only the product's default list allowed follows
 * the Web level. Interactive Cautious asks for a host nobody allowed;
 * headless keeps today's behaviour for one release and says so once.
 */

const fetchCall = (url: string): any => ({
  id: "call-fetch",
  name: "Fetch",
  arguments: { url },
  argumentsStr: JSON.stringify({ url }),
  tool: {},
});

const lists = (
  headless: boolean,
  extra: ToolPermissions["policies"] = [],
): ToolPermissions => ({
  policies: [...extra, ...getDefaultToolPolicies(headless)],
});

const WEB_AT = (web: "permissive" | "listed") => ({
  context: "permissive" as const,
  tools: "cautious" as const,
  edits: "manual" as const,
  plan: "cautious" as const,
  questions: "cautious" as const,
  web,
});

afterEach(() => {
  resetPolicyLevels();
  resetWebGrantsForTests();
  resetHeadlessRefusalNotes();
  vi.restoreAllMocks();
});

describe("interactive cn: Fetch follows the Web level", () => {
  it("Cautious asks for a host nobody allowed (nobody answers here, so not approved)", async () => {
    const r = await checkToolPermissionApproval(
      lists(false),
      fetchCall("https://new.example/"),
      {},
      false,
    );
    expect(r).toMatchObject({ approved: false, denialReason: "user" });
  });

  it("a session grant runs it", async () => {
    grantWebHostForSession("docs.example.com");
    const r = await checkToolPermissionApproval(
      lists(false),
      fetchCall("https://docs.example.com/guide"),
      {},
      false,
    );
    expect(r).toEqual({ approved: true });
  });

  it("an Always allow host: rule in the lists runs it, the exact host only", async () => {
    const withRule = lists(false, [
      { tool: "host:docs.example.com", permission: "allow" },
    ]);
    expect(
      await checkToolPermissionApproval(
        withRule,
        fetchCall("https://docs.example.com/a"),
        {},
        false,
      ),
    ).toEqual({ approved: true });
    const sub = await checkToolPermissionApproval(
      withRule,
      fetchCall("https://api.docs.example.com/a"),
      {},
      false,
    );
    expect(sub.approved).toBe(false);
  });

  it("the person's own --allow Fetch keeps every host running", async () => {
    const r = await checkToolPermissionApproval(
      lists(false, [{ tool: "Fetch", permission: "allow" }]),
      fetchCall("https://new.example/"),
      {},
      false,
    );
    expect(r).toEqual({ approved: true });
  });

  it("Web Permissive keeps the default allow", async () => {
    setPolicyLevels(WEB_AT("permissive"));
    const r = await checkToolPermissionApproval(
      lists(false),
      fetchCall("https://new.example/"),
      {},
      false,
    );
    expect(r).toEqual({ approved: true });
  });
});

describe("headless cn: the one-release transition (flag false)", () => {
  it("a public host still runs at Cautious, and one stderr line says this changes", async () => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((l: any) => {
      lines.push(String(l));
      return true;
    });
    for (const url of ["https://new.example/", "https://other.example/"]) {
      const r = await checkToolPermissionApproval(
        lists(true),
        fetchCall(url),
        {},
        true,
      );
      expect(r, url).toEqual({ approved: true });
    }
    expect(lines.filter((l) => l.includes("from 2.36"))).toEqual([
      "continuous: Headless fetches follow your Web level from 2.36: keep this with --allow Fetch, --policy web=permissive, or allow the domains in permissions.yaml.\n",
    ]);
  });

  it("Listed still refuses an unlisted host headless", async () => {
    setPolicyLevels(WEB_AT("listed"));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const r = await checkToolPermissionApproval(
      lists(true),
      fetchCall("https://new.example/"),
      {},
      true,
    );
    expect(r.approved).toBe(false);
  });
});
