import { act, fireEvent, screen, within } from "@testing-library/react";
import type {
  AuditListResponse,
  CallDetail,
  InboxEntry,
  InboxResponse,
  ListedCall,
} from "core/tools/permissions/audit/listing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../../../../context/MockIdeMessenger";
import { setupStore } from "../../../../../redux/store";
import { renderWithProviders } from "../../../../../util/test/render";
import { SLOW_AFTER_MS } from "../PermissionsStates";
import { AuditInbox } from "./AuditInbox";
import { AuditList } from "./AuditList";

const call = (over: Partial<ListedCall> = {}): ListedCall => ({
  session: "s1",
  callId: "c1",
  tool: "run_terminal_command",
  ts: "2026-11-11T10:00:00.000Z",
  policy: "allow",
  by: "rules",
  asked: false,
  summary: "git status",
  ...over,
});

const list = (
  rows: ListedCall[],
  over: Partial<AuditListResponse> = {},
): AuditListResponse => ({
  rows,
  facets: {
    tools: ["read_file", "run_terminal_command"],
    agents: ["main", "Explore"],
  },
  ...over,
});

const ROWS = [
  call({ callId: "a", policy: "deny", by: "rules", summary: "rm -rf /" }),
  call({
    callId: "b",
    policy: "allow",
    by: "reviewer",
    tool: "read_file",
    summary: "src/index.ts",
    agent: { id: "sub-1", kind: "subagent", role: "Explore" },
  }),
  call({ callId: "c", policy: "ask", by: "person", summary: "git push" }),
];

async function renderIt(
  ui: React.ReactElement,
  handlers: Record<string, unknown>,
) {
  const ideMessenger = new MockIdeMessenger();
  Object.assign(ideMessenger.responseHandlers as any, {
    "audit/status": async () => ({
      enabled: true,
      retentionDays: 30,
      via: "default",
    }),
    ...handlers,
  });
  const store = setupStore({ ideMessenger });
  await renderWithProviders(ui, { store, mockIdeMessenger: ideMessenger });
  await act(async () => {});
}

afterEach(() => vi.useRealTimers());

describe("AuditList", () => {
  it("shows time, tool, decision words, who decided, the agent and a preview", async () => {
    await renderIt(<AuditList />, { "audit/list": async () => list(ROWS) });
    const a = screen.getByTestId("audit-row-a");
    expect(a.textContent).toContain("Never");
    expect(a.textContent).toContain("Rules");
    expect(a.textContent).toContain("run_terminal_command");
    expect(a.textContent).toContain("rm -rf /");
    const b = screen.getByTestId("audit-row-b");
    expect(b.textContent).toContain("Always");
    expect(b.textContent).toContain("Reviewer");
    expect(within(b).getByTestId("agent-chip").textContent).toContain(
      "Explore",
    );
    const c = screen.getByTestId("audit-row-c");
    expect(c.textContent).toContain("Ask");
    expect(c.textContent).toContain("You");
    // A record with no agent is the main agent's
    expect(within(a).getByTestId("agent-chip").textContent).toBe("Main");
  });

  it("asks core with the filters chosen and a page at a time", async () => {
    const handler = vi.fn(async (data: any) =>
      data?.cursor
        ? list([call({ callId: "z", summary: "older" })])
        : list(ROWS, { nextCursor: "cur1" }),
    );
    await renderIt(<AuditList />, { "audit/list": handler });
    expect(handler).toHaveBeenLastCalledWith({});
    await act(async () => fireEvent.click(screen.getByTestId("audit-more")));
    expect(handler).toHaveBeenLastCalledWith({ cursor: "cur1" });
    expect(screen.getByTestId("audit-row-z")).toBeTruthy();
    expect(screen.queryByTestId("audit-more")).toBeNull();

    await act(async () =>
      fireEvent.change(screen.getByLabelText("Agent"), {
        target: { value: "Explore" },
      }),
    );
    expect(handler).toHaveBeenLastCalledWith({ agent: "Explore" });
    await act(async () =>
      fireEvent.change(screen.getByLabelText("Decision"), {
        target: { value: "deny" },
      }),
    );
    await act(async () =>
      fireEvent.change(screen.getByLabelText("Tool"), {
        target: { value: "read_file" },
      }),
    );
    expect(handler).toHaveBeenLastCalledWith({
      agent: "Explore",
      decision: "deny",
      tool: "read_file",
    });
  });

  it("says nothing matches the filters, with Clear filters", async () => {
    await renderIt(<AuditList />, {
      "audit/list": async (d: any) => list(d?.tool ? [] : ROWS),
    });
    await act(async () =>
      fireEvent.change(screen.getByLabelText("Tool"), {
        target: { value: "read_file" },
      }),
    );
    expect(screen.getByTestId("audit-empty-filtered")).toBeTruthy();
    await act(async () =>
      fireEvent.click(screen.getByTestId("audit-clear-filters")),
    );
    expect(screen.getByTestId("audit-row-a")).toBeTruthy();
  });

  it("opens a drawer with the masked record, the reason and the outcome", async () => {
    const detail: CallDetail = {
      ...call({ callId: "a", policy: "deny" }),
      argsMasked: '{"command":"curl -H «secret» x"}',
      maskedKinds: ["bearer"],
      decisions: [
        {
          ts: "2026-11-11T10:00:00.000Z",
          policy: "deny",
          by: "rules",
          reason: "Your rule blocks curl",
          rule: "runTerminalCommand(curl*)",
        },
      ],
      outcome: { ts: "2026-11-11T10:00:01.000Z", ran: false },
    };
    const get = vi.fn(async () => detail);
    await renderIt(<AuditList />, {
      "audit/list": async () => list(ROWS),
      "audit/get": get,
    });
    await act(async () =>
      fireEvent.click(
        within(screen.getByTestId("audit-row-a")).getByRole("button", {
          name: /Show details/,
        }),
      ),
    );
    expect(get).toHaveBeenCalledWith({ session: "s1", callId: "a" });
    const drawer = screen.getByRole("dialog");
    expect(within(drawer).getByTestId("detail-args").textContent).toContain(
      "«secret»",
    );
    expect(drawer.textContent).toContain("Your rule blocks curl");
    expect(drawer.textContent).toContain("runTerminalCommand(curl*)");
    expect(drawer.textContent).toContain("Ran");
    expect(document.activeElement).toBe(
      screen.getByTestId("audit-detail-close"),
    );
    fireEvent.keyDown(drawer, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says when a call is gone from what is read", async () => {
    await renderIt(<AuditList />, {
      "audit/list": async () => list(ROWS),
      "audit/get": async () => null,
    });
    await act(async () =>
      fireEvent.click(
        within(screen.getByTestId("audit-row-a")).getByRole("button", {
          name: /Show details/,
        }),
      ),
    );
    expect(screen.getByTestId("detail-gone")).toBeTruthy();
  });

  it("shows loading, then slow after 8 seconds with Try again", async () => {
    vi.useFakeTimers();
    let n = 0;
    await renderIt(<AuditList />, {
      "audit/list": () => {
        n++;
        return new Promise(() => {});
      },
    });
    expect(screen.getByTestId("audit-loading").textContent).toContain(
      "Reading the audit list",
    );
    expect(screen.queryByTestId("audit-slow")).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(SLOW_AFTER_MS + 10);
    });
    expect(screen.getByTestId("audit-slow")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByTestId("audit-retry")));
    expect(n).toBe(2);
  });

  it("shows an error with Retry that is not an empty list, then recovers", async () => {
    let fail = true;
    await renderIt(<AuditList />, {
      "audit/list": async () => {
        if (fail) throw new Error("boom");
        return list(ROWS);
      },
    });
    expect(screen.getByTestId("audit-error").textContent).toContain(
      "not an empty list",
    );
    expect(screen.queryByTestId("audit-empty-none")).toBeNull();
    fail = false;
    await act(async () => fireEvent.click(screen.getByTestId("audit-retry")));
    expect(screen.queryByTestId("audit-error")).toBeNull();
    expect(screen.getByTestId("audit-row-a")).toBeTruthy();
  });

  it("says the audit trail is off, and how to turn it on", async () => {
    await renderIt(<AuditList />, {
      "audit/status": async () => ({
        enabled: false,
        retentionDays: 30,
        via: "env",
      }),
      "audit/list": async () => list([]),
    });
    expect(screen.getByTestId("audit-off").textContent).toContain(
      "The audit trail is off",
    );
    expect(screen.getByTestId("audit-off").textContent).toContain(
      "CONTINUE_AUDIT",
    );
    expect(screen.getByTestId("audit-empty-audit-off")).toBeTruthy();
  });

  it("has an empty state for no calls and one for no reviewer decisions", async () => {
    await renderIt(<AuditList />, { "audit/list": async () => list([]) });
    expect(screen.getByTestId("audit-empty-none")).toBeTruthy();
    await act(async () =>
      fireEvent.change(screen.getByLabelText("Decision"), {
        target: { value: "reviewer" },
      }),
    );
    expect(screen.getByTestId("audit-empty-reviewer").textContent).toContain(
      "reviewer model",
    );
  });

  it("says a read was partial", async () => {
    await renderIt(<AuditList />, {
      "audit/list": async () => list(ROWS, { partial: "bytes" }),
    });
    expect(screen.getByTestId("partial").textContent).toContain("newest part");
  });
});

const entry = (over: Partial<InboxEntry> = {}): InboxEntry => ({
  ...call({ policy: "ask", by: "rules", asked: true }),
  askedAt: "2026-11-11T09:00:00.000Z",
  ageMs: 3 * 3_600_000,
  possiblyEnded: false,
  ...over,
});

const inbox = (
  items: InboxEntry[],
  over: Partial<InboxResponse> = {},
): InboxResponse => ({ items, hiddenOlder: 0, maxAgeHours: 24, ...over });

const env = { editable: true, baseHash: "h1", onChanged: vi.fn() };

describe("AuditInbox", () => {
  it("shows the age, and labels a possibly ended session", async () => {
    await renderIt(<AuditInbox env={env} />, {
      "audit/inbox": async () =>
        inbox([
          entry({ callId: "x", ageMs: 5 * 60_000, summary: "make build" }),
          entry({ callId: "y", ageMs: 5 * 3_600_000, possiblyEnded: true }),
        ]),
    });
    const x = screen.getByTestId("audit-row-x");
    expect(x.textContent).toContain("Asked 5 min ago");
    expect(within(x).queryByTestId("possibly-ended")).toBeNull();
    expect(
      within(screen.getByTestId("audit-row-y")).getByTestId("possibly-ended")
        .textContent,
    ).toBe("Possibly from an ended session");
  });

  it("hides asks older than 24 hours behind Show older, and Hide older goes back", async () => {
    const handler = vi.fn(async (d: any) =>
      d?.includeOlder
        ? inbox([entry({ callId: "old", ageMs: 40 * 3_600_000 })], {
            maxAgeHours: undefined,
          })
        : inbox([entry({ callId: "new" })], { hiddenOlder: 2 }),
    );
    await renderIt(<AuditInbox env={env} />, { "audit/inbox": handler });
    expect(screen.getByTestId("inbox-hidden").textContent).toContain(
      "2 older asks are hidden",
    );
    await act(async () =>
      fireEvent.click(screen.getByTestId("inbox-show-older")),
    );
    expect(handler).toHaveBeenLastCalledWith({ includeOlder: true });
    expect(screen.getByTestId("audit-row-old").textContent).toContain(
      "40 h ago",
    );
    await act(async () =>
      fireEvent.click(screen.getByTestId("inbox-hide-older")),
    );
    expect(screen.getByTestId("audit-row-new")).toBeTruthy();
  });

  it("says nothing is waiting, or only older asks are", async () => {
    await renderIt(<AuditInbox env={env} />, {
      "audit/inbox": async () => inbox([]),
    });
    expect(screen.getByTestId("audit-empty-inbox")).toBeTruthy();
  });

  it("says every open ask is older when all are hidden", async () => {
    await renderIt(<AuditInbox env={env} />, {
      "audit/inbox": async () => inbox([], { hiddenOlder: 3 }),
    });
    expect(screen.getByTestId("audit-empty-inbox-older")).toBeTruthy();
  });

  it("filters by agent, main included", async () => {
    const handler = vi.fn(async () =>
      inbox([
        entry({
          callId: "s",
          agent: { id: "sub-2", kind: "subagent", role: "Explore" },
        }),
      ]),
    );
    await renderIt(<AuditInbox env={env} />, { "audit/inbox": handler });
    expect(
      within(screen.getByLabelText("Agent")).getByText("Explore"),
    ).toBeTruthy();
    await act(async () =>
      fireEvent.change(screen.getByLabelText("Agent"), {
        target: { value: "main" },
      }),
    );
    expect(handler).toHaveBeenLastCalledWith({ agent: "main" });
  });

  it("Adopt as rule opens the rule editor with a dry run, then saves through it", async () => {
    const add = vi.fn(async (data: any) =>
      data.dryRun
        ? {
            result: "preview",
            analysis: {
              valid: true,
              rule: "runTerminalCommand(make build)",
              broad: false,
              friction: "none",
              loosens: true,
              warnings: [],
            },
            diff: [
              { kind: "add", text: "    - runTerminalCommand(make build)" },
            ],
          }
        : { result: "added" },
    );
    const onChanged = vi.fn();
    await renderIt(<AuditInbox env={{ ...env, onChanged }} />, {
      "audit/inbox": async () =>
        inbox([
          entry({
            callId: "p",
            summary: "make build",
            suggestedRule: "runTerminalCommand(make build)",
          }),
        ]),
      "config/addToolRule": add,
    });
    await act(async () => fireEvent.click(screen.getByTestId("adopt-p")));
    const input = screen.getByLabelText("Rule") as HTMLInputElement;
    expect(input.value).toBe("runTerminalCommand(make build)");
    expect(
      (screen.getByLabelText("What should happen") as HTMLSelectElement).value,
    ).toBe("allow");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    // The first call is a dry run: nothing is written yet
    expect(add).toHaveBeenCalled();
    expect(add.mock.calls.every(([d]) => (d as any).dryRun === true)).toBe(
      true,
    );
    expect(screen.getByTestId("rule-diff").textContent).toContain("make build");
    // Loosening is said to be confirmed in the editor's own dialog
    expect(screen.getByTestId("rule-preview").textContent).toMatch(
      /editor|dialog/i,
    );
    await act(async () => fireEvent.click(screen.getByTestId("rule-save")));
    expect(add.mock.calls.at(-1)?.[0]).toMatchObject({
      decision: "allow",
      rule: "runTerminalCommand(make build)",
    });
    expect((add.mock.calls.at(-1)?.[0] as any).dryRun).toBeUndefined();
    expect(onChanged).toHaveBeenCalled();
    expect(screen.queryByTestId("rule-form")).toBeNull();
  });

  it("Details and Adopt as rule are the same kind of button", async () => {
    await renderIt(<AuditInbox env={env} />, {
      "audit/inbox": async () =>
        inbox([entry({ callId: "p", summary: "make build" })]),
    });
    const details = await screen.findByRole("button", { name: /Show details/ });
    expect(details.className).toBe(screen.getByTestId("adopt-p").className);
  });

  it("offers no Adopt when the rules file cannot be edited", async () => {
    await renderIt(<AuditInbox env={{ ...env, editable: false }} />, {
      "audit/inbox": async () => inbox([entry({ callId: "p" })]),
    });
    expect(screen.queryByTestId("adopt-p")).toBeNull();
  });

  it("shows error with Retry", async () => {
    await renderIt(<AuditInbox env={env} />, {
      "audit/inbox": async () => {
        throw new Error("x");
      },
    });
    expect(screen.getByTestId("audit-error").textContent).toContain(
      "the inbox could not be read".replace("the", "The"),
    );
  });
});
