import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { listEffectiveRules } from "core/tools/permissions/effectiveRules";
import { DEFAULT_POLICY_LEVELS } from "core/tools/permissions/policy";
import { describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../../../context/MockIdeMessenger";
import { setupStore } from "../../../../redux/store";
import { renderWithProviders } from "../../../../util/test/render";
import { PermissionsSection } from "./PermissionsSection";

const okFile = { path: "/home/u/config.yaml", state: "ok", hash: "h1" };

function report(user: Record<string, string[]>) {
  return {
    ...listEffectiveRules({ levels: DEFAULT_POLICY_LEVELS, user }),
    userFile: okFile,
  };
}

async function setup(
  user: Record<string, string[]>,
  handlers: Record<string, unknown> = {},
) {
  const ideMessenger = new MockIdeMessenger();
  const handlersAny = ideMessenger.responseHandlers as any;
  handlersAny["policy/rules"] = vi.fn(async () => report(user));
  handlersAny["policy/test"] = vi.fn(async () => ({}));
  for (const [k, v] of Object.entries(handlers)) handlersAny[k] = v;
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
}

const preview = (analysis: Record<string, unknown> = {}) => ({
  result: "preview",
  analysis: {
    valid: true,
    rule: "runTerminalCommand(git status*)",
    broad: false,
    friction: "none",
    loosens: true,
    warnings: [],
    ...analysis,
  },
  diff: [{ kind: "add", text: "    - runTerminalCommand(git status*)" }],
  beforeHash: "h1",
});

async function openAdd() {
  fireEvent.click(screen.getByRole("button", { name: "Add a rule" }));
  return (await screen.findByLabelText("Rule")) as HTMLInputElement;
}

describe("Permissions editor: the editor's own confirmation", () => {
  it("says a loosening is confirmed in the editor, with no checkbox on the page", async () => {
    const add = vi.fn(async (data: any) =>
      data.dryRun ? preview() : { result: "added" },
    );
    await setup({}, { "config/addToolRule": add });
    fireEvent.change(await openAdd(), {
      target: { value: "runTerminalCommand(git status*)" },
    });
    await waitFor(() => screen.getByTestId("native-notice"));
    expect(screen.getByTestId("native-notice").textContent).toContain(
      "Your editor will ask you to confirm",
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("shows that it is waiting while the dialog is open, then the result", async () => {
    let release: (v: unknown) => void = () => {};
    const add = vi.fn((data: any) =>
      data.dryRun
        ? Promise.resolve(preview())
        : new Promise((resolve) => {
            release = resolve;
          }),
    );
    await setup({}, { "config/addToolRule": add });
    fireEvent.change(await openAdd(), {
      target: { value: "runTerminalCommand(git status*)" },
    });
    await waitFor(() => screen.getByTestId("rule-diff"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("rule-save"));
    });
    expect(screen.getByTestId("native-notice").textContent).toContain(
      "Waiting for your answer",
    );
    await act(async () => {
      release({ result: "added" });
    });
    await waitFor(() =>
      expect(screen.getByTestId("change-status").textContent).toContain(
        "Rule added.",
      ),
    );
  });

  it("keeps the form and says so when the dialog was declined", async () => {
    const add = vi.fn(async (data: any) =>
      data.dryRun
        ? preview()
        : {
            result: "refused",
            error:
              "Not confirmed in the editor's own dialog, so nothing was changed.",
          },
    );
    await setup({}, { "config/addToolRule": add });
    fireEvent.change(await openAdd(), {
      target: { value: "runTerminalCommand(git status*)" },
    });
    await waitFor(() => screen.getByTestId("rule-diff"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("rule-save"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("rule-error").textContent).toContain(
        "nothing was changed",
      ),
    );
    expect(screen.getByTestId("rule-form")).toBeTruthy();
    expect(screen.getByTestId("change-status").textContent).toBe("");
  });

  it("shows a refusal of an Always rule against a built-in rule, in the check", async () => {
    const add = vi.fn(async () => ({
      result: "refused",
      error:
        "Ask for runTerminalCommand(git push*) comes from a built-in rule. Always cannot loosen a built-in rule, so this rule would never take effect. Nothing was changed.",
    }));
    await setup({}, { "config/addToolRule": add });
    fireEvent.change(await openAdd(), {
      target: { value: "runTerminalCommand(git push --force*)" },
    });
    await waitFor(() => screen.getByTestId("rule-error"));
    expect(screen.getByTestId("rule-error").textContent).toContain(
      "built-in rule",
    );
    expect(
      (screen.getByTestId("rule-save") as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("Permissions editor: one written dialect", () => {
  it("shows the rule as the CLI command and copies it", async () => {
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue(undefined);
    await setup({}, { "config/addToolRule": vi.fn(async () => preview()) });
    fireEvent.change(await openAdd(), {
      target: { value: "runTerminalCommand(git status*)" },
    });
    const line = await screen.findByTestId("written-rule");
    // The default list for a new rule is Ask
    expect(line.textContent).toContain(
      "continuous permissions add ask 'runTerminalCommand(git status*)'",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Copy the command for this rule" }),
    );
    expect(writeText).toHaveBeenCalledWith(
      "continuous permissions add ask 'runTerminalCommand(git status*)'",
    );
  });

  it("adopts text pasted from `continuous audit suggest`: the same path, a preview first", async () => {
    const add = vi.fn(async (data: any) =>
      data.dryRun ? preview() : { result: "added" },
    );
    await setup({}, { "config/addToolRule": add });
    const input = await openAdd();
    fireEvent.change(input, {
      target: {
        value:
          "continuous permissions add always 'runTerminalCommand(git status*)'",
      },
    });
    await waitFor(() =>
      expect(input.value).toBe("runTerminalCommand(git status*)"),
    );
    expect(
      (screen.getByLabelText("What should happen") as HTMLSelectElement).value,
    ).toBe("allow");
    await waitFor(() => screen.getByTestId("rule-diff"));
    // Looking wrote nothing
    expect(add.mock.calls.every((c: any[]) => c[0].dryRun)).toBe(true);
    expect(add.mock.calls.at(-1)![0]).toMatchObject({
      decision: "allow",
      rule: "runTerminalCommand(git status*)",
    });
  });
});
