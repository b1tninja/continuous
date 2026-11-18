import { act, fireEvent, screen, within } from "@testing-library/react";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listEffectiveRules } from "core/tools/permissions/effectiveRules";
import {
  DEFAULT_POLICY_LEVELS,
  POLICY_AREAS,
  POLICY_PRESETS,
} from "core/tools/permissions/policy";
import {
  POLICY_SAVE_NOT_CONFIRMED,
  previewPolicySave,
  savePolicyWithConfirmation,
} from "core/tools/permissions/policySave";
import { readPolicyFile } from "core/tools/permissions/settingsFile";
import { useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PolicyCard,
  PolicyControls,
} from "../../../../../components/PolicyControls";
import { MockIdeMessenger } from "../../../../../context/MockIdeMessenger";
import { setupStore } from "../../../../../redux/store";
import { renderWithProviders } from "../../../../../util/test/render";
import { PermissionsSection } from "../PermissionsSection";
import { policyChipLabel } from "../../../../../components/PolicyControls/PresetSelect";
import { customSetToStore } from "./customPolicyState";

const report = listEffectiveRules({
  levels: DEFAULT_POLICY_LEVELS,
  user: {
    deny: ["runTerminalCommand(terraform apply*)"],
    ask: ["runTerminalCommand(git push*)"],
    allow: ["runTerminalCommand(npm test*)"],
  },
  folder: [
    {
      file: "/repo/.continue/rules.yaml",
      permissions: { allow: ["runTerminalCommand(curl*)"] },
    },
  ],
  userFile: {
    path: "/home/me/.continuous/config.yaml",
    state: "ok",
    hash: "h1",
  },
});

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{`${loc.pathname}${loc.search}`}</div>;
}

describe("Custom… on every policy control", () => {
  it("is an option of the preset and of each area, reached by keyboard, and opens the editor", async () => {
    const { user } = await renderWithProviders(
      <>
        <PolicyControls />
        <Where />
      </>,
    );
    const tick = () =>
      act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
    // Open from the keyboard, go to the last option, choose it with Enter
    const choose = async (button: HTMLElement, testId: string) => {
      await act(async () => button.focus());
      await user.keyboard("{ArrowDown}");
      await tick();
      expect(button.getAttribute("aria-expanded")).toBe("true");
      await user.keyboard("{End}");
      await tick();
      const option = screen.getByTestId(testId);
      expect(option.getAttribute("role")).toBe("option");
      expect(option.textContent).toContain("Custom…");
      await user.keyboard("{Enter}");
      await tick();
    };
    await choose(
      screen.getAllByTestId("policy-preset")[0],
      "policy-preset-custom",
    );
    expect(screen.getByTestId("where").textContent).toBe(
      "/config?tab=permissions&custom=careful",
    );
    for (const area of POLICY_AREAS) {
      await choose(
        screen.getAllByTestId(`policy-select-${area}`)[0],
        `policy-option-${area}-custom`,
      );
      expect(screen.getByTestId("where").textContent).toBe(
        `/config?tab=permissions&custom=careful&area=${area}`,
      );
    }
  });
});

interface Calls {
  save: ReturnType<typeof vi.fn>;
  edits: { type: string; data: any }[];
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The host's side of policy/save and policy/preview, for real: core's
 * confirmation and writer on a permissions.yaml in a temp directory. The
 * native dialog is `confirm`; the page has no way to answer it.
 */
function policyHost(
  ideMessenger: MockIdeMessenger,
  over: { saveFails?: string; confirm?: boolean; fileText?: string } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "custom-policy-gui-"));
  dirs.push(dir);
  const file = path.join(dir, "permissions.yaml");
  if (over.fileText !== undefined) fs.writeFileSync(file, over.fileText);
  const confirm = vi.fn(async (_text: string) => over.confirm ?? true);
  const save = vi.fn(async (update: any) => {
    if (over.saveFails) throw new Error(over.saveFails);
    await savePolicyWithConfirmation(file, update, { confirm });
    return undefined;
  });
  ideMessenger.responseHandlers["policy/save"] = save as any;
  ideMessenger.responseHandlers["policy/preview"] = (async (update: any) =>
    previewPolicySave(file, update)) as any;
  ideMessenger.responseHandlers["policy/load"] = (async () =>
    readPolicyFile(file)) as any;
  return { file, confirm, save };
}

async function openEditor(
  entry: string,
  over: { saveFails?: string; confirm?: boolean } = {},
) {
  const ideMessenger = new MockIdeMessenger();
  const edits: Calls["edits"] = [];
  const { save, confirm, file } = policyHost(ideMessenger, over);
  ideMessenger.responseHandlers["policy/rules"] = (async () => report) as any;
  ideMessenger.responseHandlers["audit/overview"] = (async () => ({
    state: "ready",
    coverageDays: 30,
    partial: false,
    rules: {},
    mostAsked: [
      {
        rule: "runTerminalCommand(ls*)",
        answer: "allow",
        asks: 5,
        answered: 5,
        last: "2026-11-12",
      },
    ],
  })) as any;
  ideMessenger.responseHandlers["audit/list"] = (async () => ({
    rows: [
      {
        session: "s",
        callId: "1",
        tool: "run_terminal_command",
        ts: "2026-11-13T00:00:00Z",
        policy: "ask",
        by: "person",
        asked: true,
        summary: "git push origin main",
      },
      {
        session: "s",
        callId: "2",
        tool: "run_terminal_command",
        ts: "2026-11-13T00:00:01Z",
        policy: "allow",
        by: "rules",
        asked: false,
        summary: "git status",
      },
    ],
    facets: { tools: [], agents: [] },
  })) as any;
  for (const type of [
    "config/addToolRule",
    "config/updateToolRule",
    "config/removeToolRule",
  ] as const) {
    ideMessenger.responseHandlers[type] = (async (data: any) => {
      edits.push({ type, data });
      const done = {
        "config/addToolRule": "added",
        "config/updateToolRule": "updated",
        "config/removeToolRule": "removed",
      }[type];
      return {
        result: data.dryRun ? "preview" : done,
        analysis: {
          valid: true,
          rule: data.rule,
          broad: false,
          friction:
            data.decision === "deny" && type === "config/removeToolRule"
              ? "confirm"
              : "none",
          loosens: false,
          warnings: [],
        },
        afterHash: `after-${edits.length}`,
      };
    }) as any;
  }
  const store = setupStore({ ideMessenger });
  const view = await renderWithProviders(<PermissionsSection />, {
    store,
    mockIdeMessenger: ideMessenger,
    routerProps: { initialEntries: [entry] } as any,
  });
  await act(async () => {});
  return { ...view, store, save, edits, confirm, file };
}

const step = async (n: number) => {
  await act(async () => {
    fireEvent.click(screen.getByTestId(`custom-step-${n}`));
  });
};

describe("the Custom policy editor", () => {
  it("is prefilled from the chosen base: the preset's five levels", async () => {
    await openEditor("/config?tab=permissions&custom=handsOff");
    expect(screen.getByTestId("custom-policy-base").textContent).toContain(
      "Hands off",
    );
    expect(
      (screen.getByTestId("custom-base-handsOff") as HTMLInputElement).checked,
    ).toBe(true);
    await step(1);
    for (const area of POLICY_AREAS) {
      expect(
        (screen.getByTestId(`custom-level-${area}`) as HTMLSelectElement).value,
      ).toBe(POLICY_PRESETS.handsOff.levels[area]);
    }
    expect(screen.getByTestId("custom-matches").textContent).toContain(
      "Hands off",
    );
    // Choosing another base refills the levels
    await step(0);
    await act(async () => {
      fireEvent.click(screen.getByTestId("custom-base-idgaf"));
    });
    expect(screen.getByTestId("custom-idgaf-note")).toBeDefined();
    await step(1);
    expect(
      (screen.getByTestId("custom-level-edits") as HTMLSelectElement).value,
    ).toBe("idgaf");
  });

  it("opened from an area, it starts at the levels with that area focused", async () => {
    await openEditor("/config?tab=permissions&custom=careful&area=edits");
    expect(screen.getByTestId("custom-step-heading").textContent).toBe(
      "Levels and settings",
    );
    expect(document.activeElement).toBe(
      screen.getByTestId("custom-level-edits"),
    );
  });

  it("add, move and remove are saved as the rule editor's own checked edits, in order", async () => {
    const { save, edits } = await openEditor(
      "/config?tab=permissions&custom=current",
    );
    await step(2);
    const editor = screen.getByTestId("rule-lists-editor");
    // The lists are the person's own; the workspace's Always rule is not one of them
    expect(
      within(screen.getByTestId("list-allow")).queryByText(/curl/),
    ).toBeNull();
    // Add, with the live preview against recent calls
    fireEvent.change(screen.getByTestId("add-rule-input"), {
      target: { value: "runTerminalCommand(git push*)x" },
    });
    fireEvent.change(screen.getByTestId("add-rule-input"), {
      target: { value: "runTerminalCommand(rm -rf /*)" },
    });
    expect(screen.getByTestId("add-rule-preview").textContent).toContain(
      "Matches 0 of the last 2 calls.",
    );
    fireEvent.change(screen.getByTestId("add-rule-input"), {
      target: { value: "runTerminalCommand(git *)" },
    });
    expect(screen.getByTestId("add-rule-preview").textContent).toContain(
      "Matches 2 of the last 2 calls.",
    );
    fireEvent.change(screen.getByTestId("add-rule-input"), {
      target: { value: "runTerminalCommand(rm -rf /*)" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("add-rule-submit"));
    });
    expect(
      within(screen.getByTestId("list-deny")).getByText(
        "runTerminalCommand(rm -rf /*)",
      ),
    ).toBeDefined();
    // Move Ask -> Never, remove the Always
    await act(async () => {
      fireEvent.change(
        screen.getByTestId("move-ask-runTerminalCommand(git push*)"),
        { target: { value: "deny" } },
      );
    });
    await act(async () => {
      fireEvent.click(
        screen.getByTestId("remove-allow-runTerminalCommand(npm test*)"),
      );
    });
    expect(screen.getByTestId("list-allow").textContent).not.toContain(
      "npm test",
    );
    expect(editor).toBeDefined();

    await step(4);
    await act(async () => {});
    expect(screen.getByTestId("custom-rule-changes").textContent).toBe(
      [
        "Remove from Always: runTerminalCommand(npm test*)",
        "Move from Ask to Never: runTerminalCommand(git push*)",
        "Add to Never: runTerminalCommand(rm -rf /*)",
      ].join(""),
    );
    // Dry runs only so far
    expect(edits.every((e) => e.data.dryRun)).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByTestId("custom-save"));
    });
    expect(save).toHaveBeenCalledTimes(1);
    const written = edits.filter((e) => !e.data.dryRun);
    expect(written.map((e) => [e.type, e.data.rule, e.data.baseHash])).toEqual([
      ["config/removeToolRule", "runTerminalCommand(npm test*)", "h1"],
      ["config/updateToolRule", "runTerminalCommand(git push*)", "after-4"],
      ["config/addToolRule", "runTerminalCommand(rm -rf /*)", "after-5"],
    ]);
    expect(written[1].data.newDecision).toBe("deny");
    // Nothing a workspace wrote reached the writer
    expect(JSON.stringify(written)).not.toContain("curl");
    expect(JSON.stringify(save.mock.calls)).not.toContain("curl");
    // Closed, and the page says what was saved
    expect(screen.queryByTestId("custom-policy")).toBeNull();
    expect(screen.getByTestId("change-status").textContent).toContain(
      "3 rule changes",
    );
  });

  it("an invalid pattern is refused with a message and nothing is added", async () => {
    await openEditor("/config?tab=permissions&custom=current");
    await step(2);
    fireEvent.change(screen.getByTestId("add-rule-input"), {
      target: { value: "runTerminalCommand()" },
    });
    expect(screen.getByTestId("add-rule-preview").textContent).toContain(
      "cannot be read as a rule yet",
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("add-rule-submit"));
    });
    const error = screen.getByTestId("add-rule-error");
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toBe(
      "Write a rule as toolName(pattern), or just toolName. A pattern in brackets cannot be empty.",
    );
    expect(
      screen.getByTestId("add-rule-input").getAttribute("aria-invalid"),
    ).toBe("true");
    // A rule already in another list says where it is
    fireEvent.change(screen.getByTestId("add-rule-input"), {
      target: { value: "runTerminalCommand(git push*)" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("add-rule-submit"));
    });
    expect(screen.getByTestId("add-rule-error").textContent).toBe(
      "That rule is already in the Ask list. Move it instead.",
    );
    await step(4);
    expect(screen.getByTestId("custom-nothing")).toBeDefined();
    expect(
      (screen.getByTestId("custom-save") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("settings in permissions.yaml: the floor, trust and Plan's MCP tools are saved in one write", async () => {
    const { save, confirm, file } = await openEditor(
      "/config?tab=permissions&custom=current",
    );
    await step(2);
    await act(async () => {
      fireEvent.change(screen.getByTestId("add-rule-list"), {
        target: { value: "floor" },
      });
    });
    fireEvent.change(screen.getByTestId("add-rule-input"), {
      target: { value: "runTerminalCommand(git push --force*)" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("add-rule-submit"));
    });
    await step(3);
    fireEvent.change(screen.getByTestId("plan-mcp-tools-input"), {
      target: { value: "a/b/c" },
    });
    await act(async () => {
      fireEvent.submit(screen.getByTestId("plan-mcp-tools-input"));
    });
    expect(screen.getByTestId("plan-mcp-tools").textContent).toContain(
      "Write server/tool, server/* or server.",
    );
    fireEvent.change(screen.getByTestId("plan-mcp-tools-input"), {
      target: { value: "github/get_issue" },
    });
    await act(async () => {
      fireEvent.submit(screen.getByTestId("plan-mcp-tools-input"));
    });
    fireEvent.change(screen.getByTestId("trusted-servers-input"), {
      target: { value: "docs" },
    });
    await act(async () => {
      fireEvent.submit(screen.getByTestId("trusted-servers-input"));
    });
    await step(4);
    await act(async () => {});
    const changes = screen.getByTestId("custom-setting-changes").textContent;
    expect(changes).toContain("floor");
    expect(changes).toContain("plan.mcpTools");
    // Trusting a server and a Plan MCP tool loosen: no page checkbox; the
    // review says the editor's own dialog will ask, and Save is not held
    expect(screen.queryByTestId("custom-ack")).toBeNull();
    const asks = screen.getByTestId("custom-native-list").textContent;
    expect(asks).toContain("Trust the read-only hints of the MCP server docs");
    expect(asks).toContain("Let Plan mode use the MCP tool github/get_issue");
    const saveButton = screen.getByTestId("custom-save") as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(saveButton);
    });
    expect(save).toHaveBeenCalledTimes(1);
    // The host asked once, natively, naming both
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toContain("MCP server docs");
    expect(confirm.mock.calls[0][0]).toContain("github/get_issue");
    expect(fs.readFileSync(file, "utf-8")).toContain("docs: trusted");
    expect(save.mock.calls[0][0]).toMatchObject({
      floor: ["runTerminalCommand(git push --force*)"],
      planMcpTools: ["github/get_issue"],
      trustedMcpServers: ["docs"],
      planAllowTerminal: false,
      levels: DEFAULT_POLICY_LEVELS,
    });
  });

  it("a failed write says nothing was saved and leaves the editor open", async () => {
    const { edits } = await openEditor(
      "/config?tab=permissions&custom=current",
      {
        saveFails: "permissions.yaml is locked",
      },
    );
    await step(1);
    await act(async () => {
      // Tighter, so no acknowledgement is asked for
      fireEvent.change(screen.getByTestId("custom-level-tools"), {
        target: { value: "manual" },
      });
    });
    await step(4);
    await act(async () => {
      fireEvent.click(screen.getByTestId("custom-save"));
    });
    expect(screen.getByTestId("custom-save-error").textContent).toContain(
      "Nothing was saved",
    );
    expect(screen.getByTestId("custom-policy")).toBeDefined();
    expect(edits.filter((e) => !e.data.dryRun)).toEqual([]);
  });

  it("no in the editor's own dialog saves nothing: not permissions.yaml, not one rule", async () => {
    const { confirm, edits, file, store } = await openEditor(
      "/config?tab=permissions&custom=current",
      { confirm: false },
    );
    await step(1);
    await act(async () => {
      fireEvent.change(screen.getByTestId("custom-level-tools"), {
        target: { value: "permissive" },
      });
    });
    await step(2);
    // A rule change too: none of it may be written after a no
    await act(async () => {
      fireEvent.change(screen.getByTestId("add-rule-list"), {
        target: { value: "deny" },
      });
    });
    fireEvent.change(screen.getByTestId("add-rule-input"), {
      target: { value: "runTerminalCommand(rm -rf*)" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("add-rule-submit"));
    });
    await step(4);
    await act(async () => {});
    expect(screen.getByTestId("custom-native-list").textContent).toContain(
      "Tool use: Cautious → Permissive",
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("custom-save"));
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("custom-save-error").textContent).toContain(
      `Nothing was saved: ${POLICY_SAVE_NOT_CONFIRMED}`,
    );
    expect(fs.existsSync(file)).toBe(false);
    expect(edits.filter((e) => !e.data.dryRun)).toEqual([]);
    expect(store.getState().ui.policyLevels.tools).toBe("cautious");
    expect(screen.getByTestId("custom-policy")).toBeDefined();
  });

  it("the review shows the exact permissions.yaml diff from the host's dry run", async () => {
    const ideMessenger = new MockIdeMessenger();
    const { file } = policyHost(ideMessenger, {
      fileText: "# mine\nlevels:\n  tools: cautious # keep\nallow:\n  - Read\n",
    });
    ideMessenger.responseHandlers["policy/rules"] = (async () => report) as any;
    const store = setupStore({ ideMessenger });
    await renderWithProviders(<PermissionsSection />, {
      store,
      mockIdeMessenger: ideMessenger,
      routerProps: {
        initialEntries: ["/config?tab=permissions&custom=current"],
      } as any,
    });
    await act(async () => {});
    await step(1);
    await act(async () => {
      fireEvent.change(screen.getByTestId("custom-level-tools"), {
        target: { value: "permissive" },
      });
    });
    await step(4);
    await act(async () => {});
    const diff = screen.getByTestId("custom-yaml-diff");
    const lines = [...diff.querySelectorAll("[data-diff]")].map((el) => [
      el.getAttribute("data-diff"),
      el.textContent?.replace(/^(Removed|Added): /, ""),
    ]);
    // The writer's own output: the comment kept, every level written, the
    // custom set stored under levels (Careful with Tool use raised)
    expect(lines).toContainEqual(["same", "  # mine"]);
    expect(lines).toContainEqual(["old", "-   tools: cautious # keep"]);
    expect(lines).toContainEqual(["new", "+   tools: permissive # keep"]);
    expect(lines).toContainEqual(["new", "+   edits: manual"]);
    expect(lines).toContainEqual(["new", "+   custom:"]);
    expect(lines).toContainEqual(["new", "+     from: careful"]);
    expect(fs.readFileSync(file, "utf-8")).not.toContain("permissive");
  });
});

describe("the stored custom set: Custom (from X) and recall", () => {
  it("is saved with its preset, named on the chip, and recalled after a preset", async () => {
    const { store, file } = await openEditor(
      "/config?tab=permissions&custom=careful",
    );
    await step(1);
    await act(async () => {
      fireEvent.change(screen.getByTestId("custom-level-edits"), {
        target: { value: "permissive" },
      });
      fireEvent.change(screen.getByTestId("custom-level-tools"), {
        target: { value: "manual" },
      });
    });
    await step(4);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByTestId("custom-save"));
    });
    const custom = {
      from: "careful",
      levels: {
        ...DEFAULT_POLICY_LEVELS,
        edits: "permissive",
        tools: "manual",
      },
    };
    expect(readPolicyFile(file).settings.custom).toEqual(custom);
    expect(store.getState().ui.policyExtras.customSet).toEqual(custom);

    // A fresh panel reads it back from the file: the chip names its base
    const ideMessenger = new MockIdeMessenger();
    ideMessenger.responseHandlers["policy/load"] = (async () =>
      readPolicyFile(file)) as any;
    const save = vi.fn(async (update: any) => {
      await savePolicyWithConfirmation(file, update, {
        confirm: async () => true,
      });
    });
    ideMessenger.responseHandlers["policy/save"] = save as any;
    const fresh = setupStore({ ideMessenger });
    const { loadPolicySettings } =
      await import("../../../../../redux/thunks/policySettings");
    await fresh.dispatch(loadPolicySettings());
    const { user } = await renderWithProviders(<PolicyControls />, {
      store: fresh,
      mockIdeMessenger: ideMessenger,
    });
    const chip = () => screen.getAllByTestId("policy-preset")[0];
    expect(chip().textContent).toContain("Custom (from Careful)");

    // Choose a preset: the set stays in the file and is offered back
    await user.click(chip());
    await user.click(await screen.findByTestId("policy-preset-handsOff"));
    await act(async () => {});
    expect(chip().textContent).toContain("Hands off");
    expect(readPolicyFile(file).settings.custom).toEqual(custom);
    await user.click(chip());
    const recall = await screen.findByTestId("policy-preset-recall");
    expect(recall.textContent).toContain("Custom (from Careful)");
    await user.click(recall);
    await act(async () => {});
    expect(save.mock.calls.at(-1)?.[0].levels).toEqual(custom.levels);
    expect(readPolicyFile(file).settings.levels).toEqual(custom.levels);
    expect(chip().textContent).toContain("Custom (from Careful)");
  });
});

describe("the toolbar and Settings controls go through the same native confirmation", () => {
  it("no to switching a built-in rule off leaves it on, in the file and on the page", async () => {
    const ideMessenger = new MockIdeMessenger();
    const { confirm, file } = policyHost(ideMessenger, { confirm: false });
    const store = setupStore({ ideMessenger });
    const { user } = await renderWithProviders(<PolicyCard />, {
      store,
      mockIdeMessenger: ideMessenger,
    });
    await user.click(
      screen
        .getByTestId("builtin-protect-secrets")
        .querySelector(".rounded-full")!,
    );
    await act(async () => {});
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toContain(
      'Switch off the built-in rule "Ask before touching credentials"',
    );
    expect(fs.existsSync(file)).toBe(false);
    expect(store.getState().ui.policyExtras.builtin?.["protect-secrets"]).toBe(
      undefined,
    );
  });
});

describe("customSetToStore: which set is kept, and its preset", () => {
  const careful = { ...DEFAULT_POLICY_LEVELS };
  const mine = { ...careful, tools: "permissive" as const };
  it.each<[string, Parameters<typeof customSetToStore>, unknown]>([
    [
      "a set made from a preset keeps that preset",
      [{ base: "careful", levels: mine }, careful, undefined],
      { from: "careful", levels: mine },
    ],
    [
      "a preset's own levels are not a custom set (the stored one stays)",
      [
        { base: "careful", levels: POLICY_PRESETS.handsOff.levels },
        careful,
        undefined,
      ],
      undefined,
    ],
    [
      "IDGAF in the set: session only",
      [
        { base: "careful", levels: { ...mine, edits: "idgaf" } },
        careful,
        undefined,
      ],
      undefined,
    ],
    [
      "started from IDGAF: session only",
      [{ base: "idgaf", levels: mine }, careful, undefined],
      undefined,
    ],
    [
      "from what is set now, when that was a preset",
      [{ base: "current", levels: mine }, careful, undefined],
      { from: "careful", levels: mine },
    ],
    [
      "from what is set now, when that was the stored set, keeps its preset",
      [
        { base: "current", levels: { ...mine, plan: "manual" } },
        mine,
        { from: "acceptEdits", levels: mine },
      ],
      { from: "acceptEdits", levels: { ...mine, plan: "manual" } },
    ],
    [
      "from what is set now, matching nothing known: no preset named",
      [
        { base: "current", levels: { ...mine, plan: "manual" } },
        mine,
        undefined,
      ],
      { levels: { ...mine, plan: "manual" } },
    ],
  ])("%s", (_name, args, expected) => {
    expect(customSetToStore(...args)).toEqual(expected);
  });

  it("the chip names the stored set's preset only while it is in force", () => {
    const stored = { from: "careful" as const, levels: mine };
    expect(policyChipLabel(mine, stored)).toBe("Custom (from Careful)");
    expect(policyChipLabel({ ...mine, plan: "manual" }, stored)).toBe("Custom");
    expect(policyChipLabel(careful, stored)).toBe("Careful");
    expect(policyChipLabel(mine, { levels: mine })).toBe("Custom");
  });
});
