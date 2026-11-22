import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { listEffectiveRules } from "core/tools/permissions/effectiveRules";
import { DEFAULT_POLICY_LEVELS } from "core/tools/permissions/policy";
import { CONFIRM_PHRASE } from "core/tools/permissions/ruleWords";
import { describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../../../context/MockIdeMessenger";
import { setupStore } from "../../../../redux/store";
import { renderWithProviders } from "../../../../util/test/render";
import { PermissionsSection } from "./PermissionsSection";
import { answerProtectionsReads } from "./protectionsTestHost";

type UserFile = {
  path: string;
  state: "ok" | "missing" | "broken";
  error?: string;
  hash?: string;
  undoable?: boolean;
};

const okFile: UserFile = {
  path: "/home/u/config.yaml",
  state: "ok",
  hash: "h1",
};

function reportWith(
  userFile: UserFile,
  extra: Record<string, unknown> = {},
  user: Record<string, string[]> | null = {
    ask: ["runTerminalCommand(git push*)"],
  },
) {
  return {
    ...listEffectiveRules({
      levels: DEFAULT_POLICY_LEVELS,
      user: user ?? undefined,
      ...extra,
    }),
    userFile,
  };
}

const diff = [
  { kind: "same", text: "toolPermissions:" },
  { kind: "add", text: "    - runTerminalCommand(git status*)" },
];

async function setup(
  report: ReturnType<typeof reportWith>,
  handlers: Record<string, unknown> = {},
) {
  const ideMessenger = new MockIdeMessenger();
  answerProtectionsReads(ideMessenger);
  const rules = vi.fn(async () => report);
  (ideMessenger.responseHandlers as any)["policy/rules"] = rules;
  (ideMessenger.responseHandlers as any)["policy/test"] = vi.fn(
    async () => ({}),
  );
  for (const [k, v] of Object.entries(handlers)) {
    (ideMessenger.responseHandlers as any)[k] = v;
  }
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
  return { rules };
}

const preview = (over: Record<string, unknown> = {}) => ({
  result: "preview",
  analysis: {
    valid: true,
    rule: "runTerminalCommand(git status*)",
    broad: false,
    friction: "none",
    loosens: true,
    warnings: [],
  },
  diff,
  verdict: {
    probe: "git status",
    before: { decision: "ask", reason: "level" },
    after: { decision: "allow", reason: "rule" },
  },
  beforeHash: "h1",
  ...over,
});

async function openAdd() {
  fireEvent.click(screen.getByRole("button", { name: "Add a rule" }));
  const input = await screen.findByLabelText("Rule");
  return input as HTMLInputElement;
}

describe("Permissions editor", () => {
  it("shows the empty state with the locks when you have no rules", async () => {
    await setup(reportWith(okFile, {}, null));
    expect(screen.getByTestId("no-own-rules").textContent).toContain(
      "You have no rules of your own yet: these built-in protections apply.",
    );
    // The Rules view says the locks exist; they are listed once, in Protections
    const pointer = screen.getByTestId("locks-pointer");
    expect(pointer.textContent).toContain("protected paths");
    expect(pointer.textContent).toContain("your policy files");
    expect(screen.queryByTestId("locks")).toBeNull();
    await act(async () =>
      fireEvent.click(screen.getByTestId("open-protections")),
    );
    expect(
      screen.getByTestId("view-protections").getAttribute("aria-selected"),
    ).toBe("true");
    const locks = screen.getByTestId("locks");
    expect(locks.textContent).toContain("Protected paths");
    expect(locks.textContent).toContain("Your policy files");
    expect(screen.getAllByTestId("locks")).toHaveLength(1);
  });

  it("adds a rule: checks it with a dry run, shows the diff and verdict, then saves", async () => {
    const add = vi.fn(async (data: any) =>
      data.dryRun
        ? preview()
        : {
            result: "added",
            beforeHash: "h1",
            afterHash: "h2",
            undoable: true,
          },
    );
    const { rules } = await setup(reportWith(okFile), {
      "config/addToolRule": add,
    });
    const input = await openAdd();
    expect(screen.getByLabelText("What should happen")).toBeTruthy();
    fireEvent.change(input, {
      target: { value: "runTerminalCommand(git status*)" },
    });
    await waitFor(() => expect(screen.getByTestId("rule-diff")).toBeTruthy());
    expect(screen.getByTestId("rule-verdict").textContent).toContain(
      "git status",
    );
    const save = screen.getByTestId("rule-save") as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    expect(add.mock.calls.every((c: any[]) => c[0].dryRun)).toBe(true);
    expect(add.mock.calls[0][0].baseHash).toBe("h1");

    const before = rules.mock.calls.length;
    await act(async () => {
      fireEvent.click(save);
    });
    await waitFor(() =>
      expect(screen.getByTestId("change-status").textContent).toContain(
        "Rule added.",
      ),
    );
    expect(add.mock.calls.at(-1)![0].dryRun).toBeUndefined();
    expect(add.mock.calls.at(-1)![0].source).toBe("permissions-page");
    await waitFor(() =>
      expect(rules.mock.calls.length).toBeGreaterThan(before),
    );
    expect(screen.queryByTestId("rule-form")).toBeNull();
  });

  it("a broad Always rule keeps Save off until the phrase is typed", async () => {
    const add = vi.fn(async (data: any) =>
      data.dryRun
        ? preview({
            analysis: {
              valid: true,
              rule: "runTerminalCommand(*)",
              broad: true,
              broadReason: "It matches every command.",
              friction: "typed",
              loosens: true,
              warnings: [
                { kind: "broad", message: "It matches every command." },
              ],
            },
          })
        : { result: "added", afterHash: "h2" },
    );
    await setup(reportWith(okFile), { "config/addToolRule": add });
    const input = await openAdd();
    fireEvent.change(input, { target: { value: "runTerminalCommand(*)" } });
    await waitFor(() => screen.getByTestId("typed-confirmation"));
    expect(screen.getByRole("alert").textContent).toContain("very wide");
    const save = screen.getByTestId("rule-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Type/), {
      target: { value: "allow" },
    });
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Type/), {
      target: { value: CONFIRM_PHRASE },
    });
    expect(save.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(save);
    });
    await waitFor(() =>
      expect(add.mock.calls.at(-1)![0].confirm).toBe(CONFIRM_PHRASE),
    );
  });

  it("shows a refused or failed save in words and keeps the form", async () => {
    const add = vi.fn(async (data: any) =>
      data.dryRun
        ? preview()
        : { result: "failed", error: "Could not write config.yaml: disk full" },
    );
    await setup(reportWith(okFile), { "config/addToolRule": add });
    fireEvent.change(await openAdd(), {
      target: { value: "runTerminalCommand(git status*)" },
    });
    await waitFor(() => screen.getByTestId("rule-diff"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("rule-save"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("rule-error").textContent).toContain(
        "disk full",
      ),
    );
    expect(screen.getByTestId("rule-form")).toBeTruthy();
    expect(screen.getByTestId("change-status").textContent).toBe("");
  });

  it("shows shadowing warnings from the check", async () => {
    const add = vi.fn(async () =>
      preview({
        analysis: {
          valid: true,
          rule: "runTerminalCommand(git push*)",
          broad: false,
          friction: "none",
          loosens: true,
          warnings: [
            {
              kind: "shadowed",
              message:
                "Never rule runTerminalCommand(git push*) covers everything this rule allows, so it can never take effect.",
            },
          ],
        },
      }),
    );
    await setup(reportWith(okFile), { "config/addToolRule": add });
    fireEvent.change(await openAdd(), {
      target: { value: "runTerminalCommand(git push*)" },
    });
    await waitFor(() => screen.getByTestId("rule-warning"));
    expect(screen.getByTestId("rule-warning").textContent).toContain(
      "never take effect",
    );
  });

  it("Escape closes the form and returns focus to Add a rule", async () => {
    await setup(reportWith(okFile), {
      "config/addToolRule": vi.fn(async () => preview()),
    });
    const input = await openAdd();
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("rule-form")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Add a rule" }),
      ),
    );
  });

  it("removes one of your rules through the same two steps", async () => {
    const remove = vi.fn(async (data: any) =>
      data.dryRun
        ? preview({
            analysis: {
              valid: true,
              rule: "runTerminalCommand(git push*)",
              broad: false,
              friction: "confirm",
              loosens: true,
              warnings: [],
            },
            verdict: undefined,
          })
        : { result: "removed", afterHash: "h2" },
    );
    await setup(reportWith(okFile), { "config/removeToolRule": remove });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove rule runTerminalCommand(git push*)",
      }),
    );
    // The editor's own dialog is the confirmation; there is no box on the page
    await waitFor(() => screen.getByTestId("native-notice"));
    expect(screen.queryByRole("checkbox")).toBeNull();
    const save = screen.getByTestId("rule-save") as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(save);
    });
    await waitFor(() =>
      expect(remove.mock.calls.at(-1)![0]).toMatchObject({
        decision: "ask",
        rule: "runTerminalCommand(git push*)",
      }),
    );
  });

  it("changes a rule with an update request", async () => {
    const update = vi.fn(async (data: any) =>
      data.dryRun ? preview() : { result: "updated" },
    );
    await setup(reportWith(okFile), { "config/updateToolRule": update });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Change rule runTerminalCommand(git push*)",
      }),
    );
    const input = (await screen.findByLabelText("Rule")) as HTMLInputElement;
    expect(input.value).toBe("runTerminalCommand(git push*)");
    fireEvent.change(input, {
      target: { value: "runTerminalCommand(git push origin*)" },
    });
    await waitFor(() => screen.getByTestId("rule-diff"));
    expect(update.mock.calls.at(-1)![0]).toMatchObject({
      decision: "ask",
      rule: "runTerminalCommand(git push*)",
      newDecision: "ask",
      newRule: "runTerminalCommand(git push origin*)",
    });
  });

  it("offers Adopt for an ignored workspace rule, shows the verdict first, then adopts", async () => {
    const adopt = vi.fn(async (data: any) =>
      data.dryRun
        ? preview({
            verdict: {
              probe: "make build",
              before: { decision: "ask", reason: "level" },
              after: { decision: "allow", reason: "rule" },
            },
          })
        : { result: "adopted", afterHash: "h2" },
    );
    await setup(
      reportWith(okFile, {
        folder: [
          {
            file: "/repo/.continue/rules.yaml",
            permissions: { allow: ["runTerminalCommand(make build*)"] },
          },
        ],
      }),
      { "config/adoptToolRule": adopt },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Adopt rule runTerminalCommand(make build*)",
      }),
    );
    await waitFor(() => screen.getByTestId("rule-verdict"));
    expect(screen.getByTestId("rule-verdict").textContent).toContain(
      "make build",
    );
    // Nothing is written by looking
    expect(adopt.mock.calls.every((c: any[]) => c[0].dryRun)).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Adopt" }));
    });
    await waitFor(() =>
      expect(screen.getByTestId("change-status").textContent).toContain(
        "adopted",
      ),
    );
  });

  it("has no Adopt or edit controls on rules from other sources", async () => {
    await setup(
      reportWith(okFile, {
        assistant: { ask: ["runTerminalCommand(curl*)"] },
        floor: ["runTerminalCommand(rm -rf /*)"],
      }),
    );
    expect(screen.queryByRole("button", { name: /curl/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /rm -rf/ })).toBeNull();
    expect(screen.getByTestId("locked-reason").textContent).toContain(
      "permissions.yaml",
    );
  });

  it("a config.yaml that cannot be read is an error state, not no rules, and editing is off", async () => {
    await setup(
      reportWith(
        {
          path: "/home/u/config.yaml",
          state: "broken",
          error: "config.yaml cannot be parsed: unexpected end of flow.",
        },
        {},
        null,
      ),
    );
    expect(screen.getByTestId("config-broken").textContent).toContain(
      "cannot be parsed",
    );
    expect(screen.queryByRole("button", { name: "Add a rule" })).toBeNull();
    expect(screen.queryByTestId("no-own-rules")).toBeNull();
    expect(
      within(screen.getByTestId("rules")).getByRole("alert").textContent,
    ).toContain("not an empty list");
  });

  it("a missing config.yaml turns editing off with a reason", async () => {
    await setup(
      reportWith({ path: "/home/u/config.yaml", state: "missing" }, {}, null),
    );
    expect(screen.getByTestId("config-missing")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add a rule" })).toBeNull();
  });

  it("Undo restores the file and says so, or says why it did not", async () => {
    const undo = vi
      .fn()
      .mockResolvedValueOnce({ result: "undone" })
      .mockResolvedValueOnce({
        result: "conflict",
        error: "config.yaml changed after that edit, so it was not put back.",
      });
    const { rules } = await setup(reportWith({ ...okFile, undoable: true }), {
      "config/undoToolRule": undo,
    });
    const before = rules.mock.calls.length;
    await act(async () => {
      fireEvent.click(screen.getByTestId("undo-rule-change"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("change-status").textContent).toContain(
        "Put config.yaml back",
      ),
    );
    await waitFor(() =>
      expect(rules.mock.calls.length).toBeGreaterThan(before),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("undo-rule-change"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("change-status").textContent).toContain(
        "was not put back",
      ),
    );
  });

  it("uses Never, Ask and Always for the decision", async () => {
    await setup(reportWith(okFile), {
      "config/addToolRule": vi.fn(async () => preview()),
    });
    await openAdd();
    const options = within(screen.getByLabelText("What should happen"))
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toEqual([
      "Never: refuse it",
      "Ask: ask me first",
      "Always: run without asking",
    ]);
  });
});
