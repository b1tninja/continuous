import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { AuditOverview } from "core/tools/permissions/audit/auditOverview";
import { listEffectiveRules } from "core/tools/permissions/effectiveRules";
import { DEFAULT_POLICY_LEVELS } from "core/tools/permissions/policy";
import { describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../../../context/MockIdeMessenger";
import { setupStore } from "../../../../redux/store";
import { renderWithProviders } from "../../../../util/test/render";
import { PermissionsSection } from "./PermissionsSection";

const okFile = { path: "/home/u/config.yaml", state: "ok", hash: "h1" };
const report = () => ({
  ...listEffectiveRules({
    levels: DEFAULT_POLICY_LEVELS,
    user: {
      ask: ["runTerminalCommand(git push*)"],
      allow: ["runTerminalCommand(git status*)"],
    },
  }),
  userFile: okFile,
});

const overview = (over: Partial<AuditOverview> = {}): AuditOverview => ({
  state: "ready",
  coverageDays: 21,
  partial: false,
  rules: {
    "runTerminalCommand(git push*)": {
      asked: 4,
      matched: 4,
      last: "2026-11-09T10:00:00.000Z",
      unused: false,
    },
    "runTerminalCommand(git status*)": { asked: 0, matched: 0, unused: true },
  },
  mostAsked: [
    {
      rule: "runTerminalCommand(npm test)",
      answer: "allow",
      asks: 9,
      answered: 9,
      last: "2026-11-09T10:00:00.000Z",
    },
  ],
  ...over,
});

async function setup(
  audit: (data: unknown) => Promise<unknown>,
  handlers: Record<string, unknown> = {},
) {
  const ideMessenger = new MockIdeMessenger();
  const h = ideMessenger.responseHandlers as any;
  h["policy/rules"] = vi.fn(async () => report());
  h["policy/test"] = vi.fn(async () => ({}));
  h["audit/overview"] = vi.fn(audit);
  for (const [k, v] of Object.entries(handlers)) h[k] = v;
  const store = setupStore({ ideMessenger });
  await renderWithProviders(<PermissionsSection />, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  await act(async () => {});
  return h;
}

describe("Permissions: audit figures", () => {
  it("asks for the figures of the rules on the page, in config.yaml's words", async () => {
    const h = await setup(async () => overview());
    expect(h["audit/overview"]).toHaveBeenCalledWith(
      expect.objectContaining({
        rules: expect.arrayContaining([
          "runTerminalCommand(git push*)",
          "runTerminalCommand(git status*)",
        ]),
      }),
    );
  });

  it("shows asked and matched counts under a rule", async () => {
    await setup(async () => overview());
    await act(async () => fireEvent.click(screen.getByTestId("tab-tools")));
    const row = screen.getByLabelText(
      /Ask rule runTerminalCommand\(git push\*\)/,
    );
    expect(row.textContent).toContain(
      "Asked 4 times, matched 4 times in 30 days.",
    );
    expect(row.textContent).not.toContain("only a hint");
  });

  it("hints at a rule with no use, and offers nothing that changes it", async () => {
    await setup(async () => overview());
    await act(async () => fireEvent.click(screen.getByTestId("tab-tools")));
    const hint = screen.getByTestId("rule-unused");
    expect(hint.textContent).toContain(
      "No use in the 21 days the audit covers",
    );
    expect(hint.textContent).toContain("only a hint");
    // the only buttons on the row are the ones that were there before
    const row = hint.closest("li")!;
    const names = [...row.querySelectorAll("button")].map((b) =>
      b.getAttribute("aria-label"),
    );
    expect(
      names.some(
        (n) =>
          /Remove|Delete|Disable/i.test(n ?? "") &&
          !/Remove rule/.test(n ?? ""),
      ),
    ).toBe(false);
  });

  it("lists the most-asked asks, with a named button of 24 px at least", async () => {
    await setup(async () => overview());
    const item = screen.getByTestId("most-asked-item");
    expect(item.textContent).toContain("runTerminalCommand(npm test)");
    expect(item.textContent).toContain(
      "Asked 9 times; you answered allow all 9 times.",
    );
    expect(screen.getByTestId("audit-overview").textContent).toContain(
      "continuous audit suggest",
    );
    const button = screen.getByRole("button", {
      name: "Review rule runTerminalCommand(npm test) in the rule editor",
    });
    expect(button.className).toContain("min-h-6");
  });

  it("Review opens the editor with the rule filled in and saves nothing", async () => {
    const add = vi.fn(async (data: any) =>
      data.dryRun
        ? {
            result: "preview",
            analysis: {
              valid: true,
              rule: "runTerminalCommand(npm test)",
              broad: false,
              friction: "none",
              loosens: false,
              warnings: [],
            },
            diff: [{ kind: "add", text: "    - runTerminalCommand(npm test)" }],
            beforeHash: "h1",
          }
        : { result: "added" },
    );
    await setup(async () => overview(), { "config/addToolRule": add });
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", {
          name: "Review rule runTerminalCommand(npm test) in the rule editor",
        }),
      ),
    );
    const input = (await screen.findByLabelText("Rule")) as HTMLInputElement;
    expect(input.value).toBe("runTerminalCommand(npm test)");
    // the form's own dry-run diff is the preview; there is no second one
    await waitFor(() => screen.getByTestId("rule-diff"));
    expect(add).toHaveBeenCalled();
    expect(add.mock.calls.every(([d]) => (d as any).dryRun === true)).toBe(
      true,
    );
    expect(add.mock.calls[0][0]).toMatchObject({
      decision: "allow",
      rule: "runTerminalCommand(npm test)",
    });
  });

  it("says there is no history, rather than claiming rules are unused", async () => {
    await setup(async () =>
      overview({ state: "empty", rules: {}, mostAsked: [], coverageDays: 0 }),
    );
    expect(screen.getByTestId("audit-empty").textContent).toContain(
      "no audit history yet",
    );
    expect(screen.queryByTestId("rule-unused")).toBeNull();
  });

  it("counts the calls IDGAF ran that a rule or guard would have stopped", async () => {
    await setup(async () => overview({ idgafObjections: 3 }));
    expect(screen.getByTestId("audit-idgaf-objections").textContent).toContain(
      "IDGAF ran 3 calls",
    );
  });

  it("says nothing about IDGAF when nothing was objected to", async () => {
    await setup(async () => overview());
    expect(screen.queryByTestId("audit-idgaf-objections")).toBeNull();
  });

  it("shows loading, then the list", async () => {
    let release: (v: unknown) => void = () => {};
    await setup(() => new Promise((r) => (release = r)));
    expect(screen.getByTestId("audit-loading").textContent).toContain(
      "Reading the audit figures",
    );
    // the rules are already usable
    expect(
      screen.getByRole("tablist", { name: "Permission areas" }),
    ).toBeDefined();
    await act(async () => release(overview()));
    expect(screen.queryByTestId("audit-loading")).toBeNull();
    expect(screen.getByTestId("most-asked-item")).toBeDefined();
  });

  it("shows a quiet error with Retry, and the rules stay", async () => {
    let calls = 0;
    await setup(async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return overview();
    });
    expect(screen.getByTestId("audit-error").textContent).toContain(
      "could not be read",
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByRole("tablist", { name: "Permission areas" }),
    ).toBeDefined();
    await act(async () => fireEvent.click(screen.getByTestId("audit-retry")));
    await waitFor(() => screen.getByTestId("most-asked-item"));
    expect(calls).toBe(2);
  });

  it("says when the guards ran out of time or the audit is not fully read", async () => {
    await setup(async () => overview({ partial: true, guardsCut: true }));
    const note = screen.getByTestId("audit-partial").textContent;
    expect(note).toContain("counts may be low");
    expect(note).toContain("next time you open this page");
  });

  it("keeps unique ids and wraps long rule text for a narrow panel", async () => {
    await setup(async () => overview());
    const ids = [...document.querySelectorAll("[id]")].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const panel = screen.getByTestId("audit-overview");
    expect(panel.className).toContain("min-w-0");
    expect(
      screen.getByTestId("most-asked-item").querySelector("code")?.className,
    ).toContain("break-all");
  });
});
