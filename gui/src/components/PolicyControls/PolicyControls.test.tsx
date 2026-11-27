import { act, screen } from "@testing-library/react";
import type { PolicyLevel } from "core/tools/permissions/policy";
import { POLICY_PRESETS } from "core/tools/permissions/policy";
import { builtinForPreset } from "core/tools/permissions/safetyDegrees";
import { describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { ProtectionsView } from "../../pages/config/sections/permissions/ProtectionsView";
import { answerProtectionsReads } from "../../pages/config/sections/permissions/protectionsTestHost";
import { EMPTY_CONFIG, updateConfig } from "../../redux/slices/configSlice";
import {
  setPolicyExtras,
  setPolicyLevel,
  setPolicyLevels,
} from "../../redux/slices/uiSlice";
import { migrations, setupStore } from "../../redux/store";
import { loadPolicySettings } from "../../redux/thunks/policySettings";
import { renderWithProviders } from "../../util/test/render";
import { BuiltinRulesCard } from "./BuiltinRulesCard";
import { PolicyCard } from "./PolicyCard";
import { IdgafChip, PolicyControls } from "./PolicyControls";
import { glyphOf, LEVEL_GLYPHS, LEVEL_TONES, toneOf } from "./levelStyle";

async function setup(experimental = false) {
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  const view = await renderWithProviders(
    <>
      <PolicyControls />
      <IdgafChip />
      <PolicyCard />
    </>,
    { store, mockIdeMessenger: ideMessenger },
  );
  await act(async () => {
    store.dispatch(
      updateConfig({
        ...EMPTY_CONFIG,
        experimental: { enableAutoApproval: experimental },
      } as any),
    );
  });
  return { ...view, store };
}

describe("PolicyControls", () => {
  it("shows one dropdown per area, each at its default, and no warning", async () => {
    const { store } = await setup();
    expect(store.getState().ui.policyLevels).toEqual({
      context: "permissive",
      tools: "cautious",
      edits: "manual",
      plan: "cautious",
      questions: "cautious",
    });
    for (const area of ["context", "tools", "edits", "plan", "questions"]) {
      expect(screen.getAllByTestId(`policy-select-${area}`)).toHaveLength(1);
      expect(screen.getAllByTestId(`policy-select-${area}-row`)).toHaveLength(
        1,
      );
    }
    expect(screen.getAllByTestId("policy-preset")[0].textContent).toContain(
      "Careful",
    );
    expect(screen.queryByTestId("idgaf-chip")).toBeNull();
  });

  it("the toolbar chip is an icon whose colour and name follow the level", async () => {
    const { store } = await setup();
    // Defaults: context permissive (amber), tools cautious (green), edits manual (green)
    const chip = (area: string) =>
      screen.getAllByTestId(`policy-select-${area}`)[0];
    // The tint carries the level; the label colour is the foreground (contrast)
    expect(chip("context").className).toContain("bg-warning/20");
    expect(chip("tools").className).toContain("bg-success/20");
    expect(chip("edits").className).toContain("bg-success/20");
    for (const area of ["context", "tools", "edits"]) {
      expect(chip(area).className).toContain("text-foreground");
      expect(chip(area).className).toContain("min-h-6");
    }
    // The level's name is there for screen readers and the tooltip, not as text
    expect(chip("context").getAttribute("aria-label")).toBe(
      "Context use: Permissive",
    );
    expect(screen.getAllByTestId("policy-level-edits")[0].className).toContain(
      "sr-only",
    );
    await act(async () => {
      store.dispatch(setPolicyLevel({ area: "tools", level: "permissive" }));
    });
    expect(chip("tools").className).toContain("bg-warning/20");
    expect(chip("tools").getAttribute("aria-label")).toBe(
      "Tool use: Permissive",
    );
  });

  it("each area offers its own levels, and choosing one changes only that area", async () => {
    const { user, store } = await setup();
    await user.click(screen.getAllByTestId("policy-select-tools")[0]);
    for (const level of ["manual", "cautious", "permissive", "automatic"]) {
      expect(screen.getByTestId(`policy-option-tools-${level}`)).toBeDefined();
    }
    // Delegate is a Questions level only, and IDGAF is a preset, not a level
    expect(screen.queryByTestId("policy-option-tools-delegate")).toBeNull();
    expect(screen.queryByTestId("policy-option-tools-idgaf")).toBeNull();
    await user.click(screen.getByTestId("policy-option-tools-permissive"));
    expect(store.getState().ui.policyLevels).toMatchObject({
      tools: "permissive",
      context: "permissive",
      edits: "manual",
    });
    expect(screen.getAllByTestId("policy-preset")[0].textContent).toContain(
      "Custom",
    );
  });

  it("Automatic is listed but disabled until a reviewer model is chosen", async () => {
    const { user } = await setup(true);
    await user.click(screen.getAllByTestId("policy-select-tools")[0]);
    const auto = screen.getByTestId("policy-option-tools-automatic");
    expect(auto.textContent).toContain("Not available");
    expect(auto.getAttribute("data-disabled")).not.toBeNull();
  });

  it("only Questions offers Delegate, and no area lists IDGAF as a level", async () => {
    const { user } = await setup();
    await user.click(screen.getAllByTestId("policy-select-questions")[0]);
    const delegate = screen.getByTestId("policy-option-questions-delegate");
    expect(delegate.textContent).toContain("Delegate");
    expect(delegate.textContent).toContain("decides every question");
    expect(screen.queryByTestId("policy-option-questions-idgaf")).toBeNull();
  });

  const SENTENCE =
    "No safety check is on, so rules, protected files and locks stop nothing.";

  it("while no check is on a one-line chip says so; the sentence is its tooltip and description", async () => {
    const { store } = await setup();
    await act(async () => {
      store.dispatch(setPolicyExtras({ builtin: builtinForPreset("idgaf") }));
    });
    const chip = screen.getByTestId("idgaf-chip");
    // One line: the word, not the sentence
    expect(chip.textContent).not.toContain("No safety check");
    expect(chip.textContent).toContain("IDGAF");
    // The sentence is the tooltip and the described-by text
    expect(chip.getAttribute("title")).toBe(
      `${SENTENCE} Select to go back to Careful.`,
    );
    const description = document.getElementById(
      chip.getAttribute("aria-describedby")!,
    )!;
    expect(description.textContent).toBe(SENTENCE);
    // It is not an alert: a standing state is not announced as an interruption
    expect(chip.getAttribute("role")).toBeNull();
    // Unrelated state changes do not remove it.
    await act(async () => {
      store.dispatch(setPolicyLevel({ area: "context", level: "manual" }));
    });
    expect(screen.getByTestId("idgaf-chip")).toBeDefined();
  });

  it("the levels alone do not show the chip: the switches say whether a check is on", async () => {
    const { store } = await setup();
    await act(async () => {
      store.dispatch(setPolicyLevel({ area: "tools", level: "permissive" }));
    });
    expect(screen.queryByTestId("idgaf-chip")).toBeNull();
  });

  it("turning one check back on removes the chip", async () => {
    const { store } = await setup();
    await act(async () => {
      store.dispatch(setPolicyExtras({ builtin: builtinForPreset("idgaf") }));
    });
    expect(screen.getByTestId("idgaf-chip")).toBeDefined();
    await act(async () => {
      store.dispatch(
        setPolicyExtras({
          builtin: { ...builtinForPreset("idgaf"), "protect-secrets": true },
        }),
      );
    });
    expect(screen.queryByTestId("idgaf-chip")).toBeNull();
  });

  it("choosing the chip goes back to Careful", async () => {
    const { user, store } = await setup();
    await act(async () => {
      store.dispatch(setPolicyExtras({ builtin: builtinForPreset("idgaf") }));
    });
    await user.click(screen.getByTestId("idgaf-chip"));
    expect(store.getState().ui.policyLevels.tools).toBe("cautious");
    expect(store.getState().ui.policyExtras.builtin).toEqual({});
    expect(screen.queryByTestId("idgaf-chip")).toBeNull();
  });

  it("a preset sets every area at once", async () => {
    const { user, store } = await setup();
    await user.click(screen.getAllByTestId("policy-preset")[0]);
    await user.click(screen.getByTestId("policy-preset-idgaf"));
    expect(store.getState().ui.policyLevels).toEqual(
      POLICY_PRESETS.idgaf.levels,
    );
    expect(store.getState().ui.policyExtras.builtin).toEqual(
      builtinForPreset("idgaf"),
    );
    // At the preset the preset chip is the warning: one chip, not two
    expect(screen.queryByTestId("idgaf-chip")).toBeNull();
    const chip = screen.getAllByTestId("policy-preset")[0];
    // Only the name is drawn; what it means is the accessible name and description
    expect(chip.textContent).not.toContain("nothing asks");
    expect(chip.getAttribute("aria-label")).toContain("nothing asks");
    const description = document.getElementById(
      chip.getAttribute("aria-describedby")!,
    )!;
    expect(description.textContent).toBe(SENTENCE);
    expect(chip.parentElement!.getAttribute("title")).toContain(
      "No safety check is on",
    );
  });

  it("the preset chip has a glyph, a tone from its levels and a name for screen readers", async () => {
    const { user, store } = await setup();
    const chip = () => screen.getAllByTestId("policy-preset")[0];
    // Careful: the loosest level outside Context use is Cautious, so green
    expect(chip().className).toContain("bg-success/20");
    expect(chip().className).toContain("text-foreground");
    expect(chip().className).toContain("min-h-6");
    expect(chip().querySelector("svg")).not.toBeNull();
    expect(chip().getAttribute("aria-label")).toContain("Preset: Careful.");
    expect(chip().getAttribute("aria-label")).toContain("Manual: File edits.");
    expect(screen.getAllByTestId("policy-preset-tone")[0].className).toContain(
      "sr-only",
    );
    await user.click(chip());
    await user.click(screen.getByTestId("policy-preset-acceptEdits"));
    expect(chip().className).toContain("bg-warning/20");
    await user.click(chip());
    await user.click(screen.getByTestId("policy-preset-reviewer"));
    expect(chip().className).toContain("bg-link/20");
    await user.click(chip());
    await user.click(screen.getByTestId("policy-preset-idgaf"));
    expect(chip().className).toContain("bg-error/20");
    expect(store.getState().ui.policyLevels.tools).toBe("permissive");
    expect(store.getState().ui.policyExtras.builtin).toEqual(
      builtinForPreset("idgaf"),
    );
  });

  it("a set of levels that matches no preset reads as Custom, and is neutral", async () => {
    const { user, store } = await setup();
    await act(async () => {
      store.dispatch(setPolicyLevel({ area: "tools", level: "permissive" }));
    });
    const chip = screen.getAllByTestId("policy-preset")[0];
    expect(chip.textContent).toContain("Custom");
    expect(chip.className).toContain("bg-lightgray/20");
    expect(chip.getAttribute("aria-label")).toContain("Preset: Custom.");
    expect(
      screen.getAllByTestId("policy-preset-tone")[0].textContent,
    ).toContain("matches no preset");
    await act(async () => {
      store.dispatch(setPolicyLevel({ area: "edits", level: "permissive" }));
    });
    // Looser, but still no preset: it stays neutral, and never red
    expect(chip.className).toContain("bg-lightgray/20");
    expect(chip.className).not.toContain("bg-error/20");
    expect(chip.textContent).toContain("Custom");
    await user.click(chip);
    expect(screen.getByTestId("policy-preset-custom").textContent).toContain(
      "your current set",
    );
  });

  it("each preset row has a glyph, what it sets and a check on the current one", async () => {
    const { user } = await setup();
    await user.click(screen.getAllByTestId("policy-preset")[0]);
    for (const name of [
      "careful",
      "acceptEdits",
      "handsOff",
      "reviewer",
      "idgaf",
    ]) {
      const row = screen.getByTestId(`policy-preset-${name}`);
      expect(row.querySelector("svg[aria-hidden=true]")).not.toBeNull();
    }
    expect(screen.getByTestId("policy-preset-careful").textContent).toContain(
      "Cautious: Tool use, Plan edits, Questions.",
    );
    // The IDGAF preset is Permissive on four areas and leaves Questions alone
    expect(screen.getByTestId("policy-preset-idgaf").textContent).toContain(
      "Permissive: Context use, Tool use, File edits, Plan edits.",
    );
    const checks = (name: string) =>
      screen
        .getByTestId(`policy-preset-${name}`)
        .querySelector("svg:last-of-type")!.classList;
    expect(checks("careful").contains("opacity-0")).toBe(false);
    expect(checks("idgaf").contains("opacity-0")).toBe(true);
  });

  it("Settings shows the same five rows", async () => {
    await setup();
    for (const area of ["context", "tools", "edits", "plan", "questions"]) {
      expect(screen.getByTestId(`policy-row-${area}`)).toBeDefined();
    }
  });
});

describe("the settings beside the levels", () => {
  it("a built-in rule is on until it is switched off, and the change is saved", async () => {
    const ideMessenger = new MockIdeMessenger();
    const saved: any[] = [];
    ideMessenger.responseHandlers["policy/save"] = (async (data: any) => {
      saved.push(data);
    }) as any;
    const store = setupStore({ ideMessenger });
    const { user } = await renderWithProviders(<BuiltinRulesCard />, {
      store,
      mockIdeMessenger: ideMessenger,
    });
    expect(store.getState().ui.policyExtras.builtin?.["protect-secrets"]).toBe(
      undefined,
    );
    await user.click(
      screen
        .getByTestId("builtin-protect-secrets")
        .querySelector(".rounded-full")!,
    );
    expect(store.getState().ui.policyExtras.builtin).toEqual({
      "protect-secrets": false,
    });
    expect(saved.at(-1).builtin).toEqual({ "protect-secrets": false });
  });

  it("the confirmation skip is off until it is switched on, and the change is saved", async () => {
    const ideMessenger = new MockIdeMessenger();
    const saved: any[] = [];
    ideMessenger.responseHandlers["policy/save"] = (async (data: any) => {
      saved.push(data);
    }) as any;
    const store = setupStore({ ideMessenger });
    const { user } = await renderWithProviders(<PolicyCard />, {
      store,
      mockIdeMessenger: ideMessenger,
    });
    expect(store.getState().ui.policyExtras.skipPermissionConfirm).toBe(
      undefined,
    );
    await user.click(
      screen
        .getByTestId("skip-permission-confirm")
        .querySelector(".rounded-full")!,
    );
    expect(store.getState().ui.policyExtras.skipPermissionConfirm).toBe(true);
    expect(saved.at(-1).skipPermissionConfirm).toBe(true);
  });

  it("who decides a question type moves it between the two lists", async () => {
    const ideMessenger = new MockIdeMessenger();
    const store = setupStore({ ideMessenger });
    const { user } = await renderWithProviders(<PolicyCard />, {
      store,
      mockIdeMessenger: ideMessenger,
    });
    const row = screen.getByTestId("question-type-design");
    await user.selectOptions(row.querySelector("select")!, "agent");
    expect(store.getState().ui.policyExtras.questions?.agentDecides).toContain(
      "design",
    );
    expect(store.getState().ui.policyExtras.questions?.youDecide).not.toContain(
      "design",
    );
  });

  it("loads the shared file at startup: levels, switches and the floor", async () => {
    const ideMessenger = new MockIdeMessenger();
    answerProtectionsReads(ideMessenger);
    ideMessenger.responseHandlers["policy/load"] = (async () => ({
      settings: {
        levels: {
          context: "permissive",
          tools: "permissive",
          edits: "manual",
          plan: "cautious",
          questions: "cautious",
        },
        builtin: { "protect-network-paths": false },
        floor: ["runTerminalCommand(terraform destroy*)"],
      },
      notices: [],
    })) as any;
    const store = setupStore({ ideMessenger });
    await renderWithProviders(
      <>
        <PolicyCard />
        <ProtectionsView />
      </>,
      { store, mockIdeMessenger: ideMessenger },
    );
    await act(async () => {
      await store.dispatch(loadPolicySettings());
    });
    expect(store.getState().ui.policyLevels.tools).toBe("permissive");
    expect(store.getState().ui.policyExtras.floor).toHaveLength(1);
    expect(screen.getByTestId("policy-floor").textContent).toContain(
      "1 locked rule",
    );
  });

  it("a webview reload keeps the IDGAF preset: its levels and its switches are what was saved", async () => {
    const ideMessenger = new MockIdeMessenger();
    (ideMessenger.responseHandlers as any)["policy/load"] = async () => ({
      settings: {
        levels: POLICY_PRESETS.idgaf.levels,
        builtin: builtinForPreset("idgaf"),
      },
      notices: [],
    });
    const store = setupStore({ ideMessenger });
    await act(async () => {
      await store.dispatch(loadPolicySettings());
    });
    expect(store.getState().ui.policyLevels).toEqual(
      POLICY_PRESETS.idgaf.levels,
    );
    expect(store.getState().ui.policyExtras.builtin).toEqual(
      builtinForPreset("idgaf"),
    );
  });
});

// 2.38.11 crashed ("Cannot read properties of undefined (reading 'chip')") for
// anyone whose webview had saved the old IDGAF level: it was persisted as a
// level, rehydrated unchanged, and the level chips had no entry for it.
describe("a level saved by an older build", () => {
  const saved = (levels: Record<string, unknown>) => ({
    ui: { policyLevels: levels, toolSettings: {} },
    _persist: { version: 2, rehydrated: true },
  });

  it("the migration reads a saved idgaf as Permissive, and Delegate on Questions", () => {
    const state = migrations["3"](
      saved({
        context: "idgaf",
        tools: "idgaf",
        edits: "idgaf",
        plan: "idgaf",
        questions: "idgaf",
      }) as never,
    ) as any;
    expect(state.ui.policyLevels).toEqual({
      context: "permissive",
      tools: "permissive",
      edits: "permissive",
      plan: "permissive",
      questions: "delegate",
    });
    expect(state.ui.toolSettings).toEqual({});
  });

  it("the migration reads yolo the same way, in any case, and keeps the levels it knows", () => {
    const state = migrations["3"](
      saved({
        context: "YOLO",
        tools: "manual",
        edits: "automatic",
        plan: "cautious",
        questions: "permissive",
      }) as never,
    ) as any;
    expect(state.ui.policyLevels).toEqual({
      context: "permissive",
      tools: "manual",
      edits: "automatic",
      plan: "cautious",
      questions: "permissive",
    });
  });

  it("the migration replaces a value it cannot read with the area's default, and Delegate on a tool area too", () => {
    const state = migrations["3"](
      saved({
        context: "sometimes",
        tools: "delegate",
        edits: 5,
        plan: "cautious",
        questions: "delegate",
      }) as never,
    ) as any;
    expect(state.ui.policyLevels).toMatchObject({
      context: "permissive",
      tools: "cautious",
      edits: "manual",
      plan: "cautious",
      questions: "delegate",
    });
  });

  it("the migration leaves a state with no saved levels alone", () => {
    const empty = { ui: {}, _persist: { version: 2, rehydrated: true } };
    expect(migrations["3"](empty as never)).toEqual(empty);
    const none = { _persist: { version: 2, rehydrated: true } };
    expect(migrations["3"](none as never)).toEqual(none);
  });

  it("the reducers read a message from an older host the same way", async () => {
    const { store } = await setup();
    await act(async () => {
      store.dispatch(
        setPolicyLevel({ area: "tools", level: "idgaf" as never }),
      );
      store.dispatch(
        setPolicyLevel({ area: "questions", level: "idgaf" as never }),
      );
    });
    expect(store.getState().ui.policyLevels.tools).toBe("permissive");
    expect(store.getState().ui.policyLevels.questions).toBe("delegate");
    await act(async () => {
      store.dispatch(
        setPolicyLevels({
          context: "yolo",
          tools: "nonsense",
          edits: "manual",
          plan: "manual",
          questions: "manual",
        } as never),
      );
    });
    expect(store.getState().ui.policyLevels).toMatchObject({
      context: "permissive",
      tools: "cautious",
      edits: "manual",
    });
  });

  it("a level this build does not know gets the Cautious glyph and tint, not a crash", () => {
    // The chips look a level up by name; a value from saved state or another
    // host that is not one of the five used to be undefined, and .chip threw
    for (const level of ["idgaf", "yolo", "somethingnew", "", "constructor"]) {
      expect(toneOf(level)).toBe(LEVEL_TONES.cautious);
      expect(glyphOf(level)).toBe(LEVEL_GLYPHS.cautious);
    }
  });

  it("every real level keeps its own glyph and tint", () => {
    for (const level of Object.keys(LEVEL_TONES) as PolicyLevel[]) {
      expect(toneOf(level)).toBe(LEVEL_TONES[level]);
      expect(glyphOf(level)).toBe(LEVEL_GLYPHS[level]);
    }
    expect(toneOf("permissive")).not.toBe(toneOf("manual"));
  });
});
