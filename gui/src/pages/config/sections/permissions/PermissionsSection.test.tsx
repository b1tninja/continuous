import { act, fireEvent, screen, within } from "@testing-library/react";
import { listEffectiveRules } from "core/tools/permissions/effectiveRules";
import { DEFAULT_POLICY_LEVELS } from "core/tools/permissions/policy";
import { describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../../../context/MockIdeMessenger";
import { setupStore } from "../../../../redux/store";
import { renderWithProviders } from "../../../../util/test/render";
import { PermissionsSection } from "./PermissionsSection";
import { answerProtectionsReads } from "./protectionsTestHost";

const report = listEffectiveRules({
  levels: DEFAULT_POLICY_LEVELS,
  floor: ["runTerminalCommand(rm -rf /*)"],
  user: {
    deny: ["runTerminalCommand(terraform apply*)"],
    ask: ["runTerminalCommand(git push*)"],
    allow: [
      "runTerminalCommand(npm test*)",
      "readFile(src/**)",
      "runTerminalCommand(npm install lodash)",
    ],
  },
  assistant: { allow: ["mcp__github__*"] },
  folder: [
    {
      file: "/repo/.continue/rules.yaml",
      permissions: { allow: ["runTerminalCommand(curl*)"] },
    },
  ],
  cliFile: { exclude: ["Write(.git/**)"] },
  maxNewPlanItems: 3,
  notices: ["permissions.yaml: levels.tools: idgaf is for one session only"],
});

const askResult = {
  decision: "ask",
  policy: "allowedWithPermission",
  source: "ask-rule",
  reason: "Your rule runTerminalCommand(git push*) asks before running this.",
  toolName: "run_terminal_command",
  area: "tools",
  level: "cautious",
  matchedRules: [
    {
      raw: "runTerminalCommand(git push*)",
      decision: "ask",
      source: "user-config",
      locked: false,
      deciding: true,
    },
  ],
  wouldAskReviewer: false,
  lint: [],
  steps: [
    {
      id: "deny",
      label: "Deny rules",
      outcome: "passed",
      detail: "No deny rule matches.",
    },
    {
      id: "ask",
      label: "Ask rules",
      outcome: "decided",
      detail: "Your rule asks.",
    },
  ],
  notes: [],
};

async function setup() {
  const ideMessenger = new MockIdeMessenger();
  answerProtectionsReads(ideMessenger);
  const rules = vi.fn(async () => report);
  const test = vi.fn(async () => askResult);
  ideMessenger.responseHandlers["policy/rules"] = rules as any;
  ideMessenger.responseHandlers["policy/test"] = test as any;
  const store = setupStore({ ideMessenger });
  await renderWithProviders(<PermissionsSection />, {
    store,
    mockIdeMessenger: ideMessenger,
    // The page opens on Levels; these tests are about the Rules view
    routerProps: {
      initialEntries: ["/config?tab=permissions&view=rules"],
    } as never,
  });
  await act(async () => {});
  return { rules, test };
}

describe("PermissionsSection", () => {
  it("has five area tabs, with the Tools tab first showing its level", async () => {
    await setup();
    const tabs = within(
      screen.getByRole("tablist", { name: "Permission areas" }),
    ).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent?.replace(/\d+$/, ""))).toEqual([
      "Context use",
      "Tool use",
      "File edits",
      "Plan edits",
      "Questions",
    ]);
    expect(screen.getByTestId("tab-tools").getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByTestId("area-level").textContent).toBe("Cautious");
  });

  it("groups the area's rules by decision with source badges", async () => {
    await setup();
    const deny = screen.getByTestId("group-deny");
    expect(deny.textContent).toContain("runTerminalCommand(terraform apply*)");
    expect(deny.textContent).toContain("Locked rule");
    expect(deny.textContent).toContain("Locked");
    expect(screen.getByTestId("group-ask").textContent).toContain("You");
    const allow = screen.getByTestId("group-allow");
    expect(allow.textContent).toContain("Assistant");
    expect(allow.textContent).toContain("Workspace");
  });

  it("marks a workspace allow rule ignored, with the reason", async () => {
    await setup();
    const row = screen.getByLabelText(
      /Always rule runTerminalCommand\(curl\*\), from Workspace, ignored/,
    );
    expect(row.textContent).toContain("Ignored");
    expect(row.textContent).toContain("came with the workspace");
  });

  it("says how many built-in protections apply, links to them, and shows the fixed decision order", async () => {
    await setup();
    // The rules are listed once, in Protections; the area counts its own
    expect(screen.getByTestId("builtins").textContent).toMatch(
      /^Built-in rules\d+ of \d+ built-in rules that apply to this area are on\./,
    );
    expect(screen.queryByTestId("builtin-row-no-fetch-and-run")).toBeNull();
    await act(async () => fireEvent.click(screen.getByTestId("tab-tools")));
    expect(screen.getByTestId("exempt-ask-dependency-change").textContent).toBe(
      "Ask before changing dependencies: exempted by your Always rule runTerminalCommand(npm install lodash)",
    );
    await act(async () =>
      fireEvent.click(screen.getByTestId("open-builtin-rules")),
    );
    expect(
      screen.getByTestId("view-protections").getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByTestId("fold-builtin-rules")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByTestId("view-rules")));
    expect(screen.getByTestId("decision-order").textContent).toContain(
      "does not matter",
    );
  });

  it("switches tabs: Edits shows its CLI-file rule in both dialects", async () => {
    await setup();
    await act(async () => fireEvent.click(screen.getByTestId("tab-edits")));
    expect(screen.getByTestId("area-level").textContent).toBe("Manual");
    const text = screen.getByTestId("group-deny").textContent;
    expect(text).toContain("Write(.git/**)");
    expect(text).toContain("CLI file");
    expect(text).toContain("In config.yaml: writeFile(.git/**)");
  });

  it("Plan and Questions show level and settings, with no rule list or tester", async () => {
    await setup();
    await act(async () => fireEvent.click(screen.getByTestId("tab-plan")));
    expect(screen.getByTestId("plan-settings").textContent).toContain("3");
    expect(screen.queryByTestId("rules")).toBeNull();
    expect(screen.queryByTestId("tester-plan")).toBeNull();
    await act(async () => fireEvent.click(screen.getByTestId("tab-questions")));
    expect(screen.getByTestId("question-settings").textContent).toContain(
      "scope, irreversible, security, cost",
    );
    expect(screen.queryByTestId("rules")).toBeNull();
  });

  it("tries a command and shows the decision, the matching rule and why", async () => {
    const { test } = await setup();
    const input = screen.getByLabelText("Run a command");
    await act(async () => {
      fireEvent.change(input, { target: { value: "git push origin main" } });
    });
    await act(async () => fireEvent.click(screen.getByText("Test")));
    expect(test).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "runTerminalCommand",
        command: "git push origin main",
        mode: "agent",
      }),
    );
    expect(screen.getByTestId("test-decision").textContent).toBe("Asks");
    expect(screen.getByTestId("test-reason").textContent).toContain(
      "Your rule runTerminalCommand(git push*)",
    );
    expect(screen.getByTestId("test-matched").textContent).toContain(
      "runTerminalCommand(git push*)",
    );
    expect(screen.getByTestId("step-ask").textContent).toContain(
      "Decided here",
    );
  });

  it("has named controls and no wide fixed widths for a 300px panel", async () => {
    await setup();
    expect(screen.getByLabelText("What to try")).toBeTruthy();
    expect(screen.getByLabelText("Mode")).toBeTruthy();
    const page = screen.getByTestId("permissions-page");
    expect(page.className).toContain("min-w-0");
    // rule text breaks instead of scrolling sideways
    const code = page.querySelector("code");
    expect(code?.className).toContain("break-all");
    expect(page.innerHTML).not.toMatch(/\bw-\[\d{3,}px\]|min-w-\[\d{3,}px\]/);
  });

  it("shows the notices the reader of the files reported", async () => {
    await setup();
    expect(screen.getByText(/idgaf is for one session only/)).toBeTruthy();
  });
});
