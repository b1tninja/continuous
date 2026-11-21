import { act, fireEvent, screen, within } from "@testing-library/react";
import type {
  AuditListResponse,
  CallDetail,
  ListedCall,
} from "core/tools/permissions/audit/listing";
import { describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../../../../context/MockIdeMessenger";
import { setupStore } from "../../../../../redux/store";
import { renderWithProviders } from "../../../../../util/test/render";
import { AuditList } from "./AuditList";

/**
 * How a command ended, in the audit detail. A command a signal ended has no
 * exit code, so the drawer says what ended it; before, it showed "Ran: Yes"
 * and nothing about the command having been killed.
 */
const row = (over: Partial<ListedCall> = {}): ListedCall => ({
  session: "s1",
  callId: "a",
  tool: "run_terminal_command",
  ts: "2026-11-11T10:00:00.000Z",
  policy: "allow",
  by: "rules",
  asked: false,
  summary: "npm test",
  ...over,
});

const list = (rows: ListedCall[]): AuditListResponse => ({
  rows,
  facets: { tools: ["run_terminal_command"], agents: ["main"] },
});

async function open(outcome: NonNullable<CallDetail["outcome"]>) {
  const detail: CallDetail = {
    ...row(),
    argsMasked: '{"command":"npm test"}',
    maskedKinds: [],
    decisions: [
      { ts: "2026-11-11T10:00:00.000Z", policy: "allow", by: "rules" },
    ],
    outcome,
  };
  const ideMessenger = new MockIdeMessenger();
  Object.assign(ideMessenger.responseHandlers as never, {
    "audit/status": async () => ({
      enabled: true,
      retentionDays: 30,
      via: "default",
    }),
    "audit/list": async () => list([row()]),
    "audit/get": vi.fn(async () => detail),
  });
  const store = setupStore({ ideMessenger });
  await renderWithProviders(<AuditList />, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  await act(async () => {});
  await act(async () =>
    fireEvent.click(
      within(screen.getByTestId("audit-row-a")).getByRole("button", {
        name: /Show details/,
      }),
    ),
  );
  return within(screen.getByRole("dialog")).getByTestId("outcome");
}

const TS = "2026-11-11T10:00:01.000Z";

describe("the audit detail: how a command ended", () => {
  it("a normal exit shows its code and nothing about signals", async () => {
    const outcome = await open({ ts: TS, ran: true, exit: 3 });
    expect(outcome.textContent).toContain("Exit code");
    expect(outcome.textContent).toContain("3");
    expect(outcome.textContent).not.toContain("Ended by");
    expect(outcome.textContent).not.toContain("Time limit");
  });

  it("a command a signal ended says which, and has no exit code", async () => {
    const outcome = await open({ ts: TS, ran: true, signal: "SIGKILL" });
    expect(outcome.textContent).toContain("Ended by");
    expect(outcome.textContent).toContain("SIGKILL");
    expect(outcome.textContent).not.toContain("Exit code");
  });

  it("a command that hit its time limit says so", async () => {
    const outcome = await open({
      ts: TS,
      ran: true,
      signal: "SIGTERM",
      timedOut: true,
    });
    expect(outcome.textContent).toContain("Time limit");
    expect(outcome.textContent).toContain("hit its time limit");
    expect(outcome.textContent).toContain("SIGTERM");
    expect(outcome.textContent).not.toContain("Exit code");
  });

  it("shows a code and a signal together when both are known", async () => {
    const outcome = await open({
      ts: TS,
      ran: true,
      exit: 143,
      signal: "SIGTERM",
    });
    expect(outcome.textContent).toContain("143");
    expect(outcome.textContent).toContain("SIGTERM");
  });

  it("an exit code of 0 is still shown", async () => {
    const outcome = await open({ ts: TS, ran: true, exit: 0 });
    expect(outcome.textContent).toContain("Exit code");
  });
});
