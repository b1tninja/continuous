// Fixtures for the audit views in Settings > Permissions (UX14, O19, O20): fake
// answers for the audit messages, then a click on the view's tab. The ages come
// from the fake answers, so the pictures do not depend on the clock.
import { listEffectiveRules } from "core/tools/permissions/effectiveRules";
import { DEFAULT_POLICY_LEVELS } from "core/tools/permissions/policy";
import type { Fixture, FixtureContext } from "./fixtures";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const call = (over: Record<string, unknown>) => ({
  session: "s1",
  ts: "2026-11-10T09:58:00.000Z",
  asked: false,
  ...over,
});

const ROWS = [
  call({
    callId: "c1",
    tool: "run_terminal_command",
    policy: "allow",
    by: "rules",
    summary: "git status",
  }),
  call({
    callId: "c2",
    tool: "run_terminal_command",
    policy: "deny",
    by: "rules",
    summary: "terraform apply -auto-approve",
    reason: "Your rule runTerminalCommand(terraform apply*) refuses it.",
  }),
  call({
    callId: "c3",
    tool: "read_file",
    policy: "allow",
    by: "reviewer",
    summary: "src/server/handlers/index.ts",
    agent: { id: "sub-7", kind: "subagent", role: "Explore" },
    asked: true,
  }),
  call({
    callId: "c4",
    tool: "run_terminal_command",
    policy: "ask",
    by: "person",
    summary: "git push origin feature/audit-ui with a very long branch name",
    agent: { id: "worker-3", kind: "loop-worker", role: "item 3" },
  }),
  call({
    callId: "c5",
    tool: "create_new_file",
    policy: "allow",
    by: "system",
    summary: "docs/notes.md",
  }),
];

const entry = (over: Record<string, unknown>) => ({
  ...call({ policy: "ask", by: "rules", asked: true }),
  possiblyEnded: false,
  ...over,
});

const INBOX = [
  entry({
    callId: "i1",
    tool: "run_terminal_command",
    summary: "npm publish --access public",
    ageMs: 20 * 3_600_000,
    possiblyEnded: true,
    session: "s0",
  }),
  entry({
    callId: "i2",
    tool: "run_terminal_command",
    summary: "make build",
    ageMs: 3 * 3_600_000,
    possiblyEnded: true,
    suggestedRule: "runTerminalCommand(make build)",
    agent: { id: "sub-2", kind: "subagent", role: "Explore" },
  }),
  entry({
    callId: "i3",
    tool: "edit_existing_file",
    summary: "src/index.ts",
    ageMs: 2 * 60_000,
  }),
];

const report = () => ({
  ...listEffectiveRules({
    levels: DEFAULT_POLICY_LEVELS,
    user: { ask: ["runTerminalCommand(git push*)"] },
    maxNewPlanItems: 3,
  } as never),
  userFile: { path: "config.yaml", state: "ok" as const, hash: "h1" },
});

function auditView(view: "recent" | "inbox"): Fixture {
  return async ({ messenger, navigate }: FixtureContext) => {
    const h = messenger.responseHandlers as any;
    h["policy/rules"] = async () => report();
    h["audit/status"] = async () => ({
      enabled: true,
      retentionDays: 30,
      via: "default",
    });
    h["audit/list"] = async () => ({
      rows: ROWS,
      facets: {
        tools: ["create_new_file", "read_file", "run_terminal_command"],
        agents: ["Explore", "item 3", "main"],
      },
    });
    h["audit/inbox"] = async () => ({
      items: INBOX,
      hiddenOlder: 2,
      maxAgeHours: 24,
    });
    navigate("/config?tab=permissions");
    await sleep(600);
    document
      .querySelector<HTMLButtonElement>(`[data-testid=view-${view}]`)
      ?.click();
    await sleep(400);
    document.querySelector("[data-testid=view-switch]")?.scrollIntoView();
  };
}

export const AUDIT_FIXTURES: Record<string, Fixture> = {
  "audit-list": auditView("recent"),
  "audit-inbox": auditView("inbox"),
};
