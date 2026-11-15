import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { EMPTY_CONFIG, updateConfig } from "../../redux/slices/configSlice";
import { setPolicyLevel } from "../../redux/slices/uiSlice";
import { setupStore } from "../../redux/store";
import {
  applyPolicyPreset,
  changePolicyLevel,
  loadPolicySettings,
} from "../../redux/thunks/policySettings";
import { renderWithProviders } from "../../util/test/render";
import { PolicyCard } from "./PolicyCard";
import { PolicyControls, IdgafChip } from "./PolicyControls";

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
      store.dispatch(setPolicyLevel({ area: "tools", level: "idgaf" }));
    });
    expect(chip("tools").className).toContain("bg-error/20");
  });

  it("each area has its own five levels, and choosing one changes only that area", async () => {
    const { user, store } = await setup();
    await user.click(screen.getAllByTestId("policy-select-tools")[0]);
    for (const level of ["manual", "cautious", "permissive", "idgaf"]) {
      expect(screen.getByTestId(`policy-option-tools-${level}`)).toBeDefined();
    }
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

  it("every area calls its top level IDGAF", async () => {
    const { user } = await setup();
    await user.click(screen.getAllByTestId("policy-select-questions")[0]);
    expect(
      screen.getByTestId("policy-option-questions-idgaf").textContent,
    ).toContain("IDGAF");
  });

  it("an area at IDGAF shows a one-line chip; the sentence is its tooltip and description", async () => {
    const { store } = await setup();
    await act(async () => {
      store.dispatch(setPolicyLevel({ area: "questions", level: "idgaf" }));
    });
    const chip = screen.getByTestId("idgaf-chip");
    // One line: the word, not the sentence
    expect(chip.textContent).not.toContain("Every rule is ignored");
    expect(chip.textContent).toContain("IDGAF");
    // The sentence is the tooltip and the described-by text
    expect(chip.getAttribute("title")).toBe(
      "Every rule is ignored. Select to go back to Careful.",
    );
    expect(chip.getAttribute("title")).toContain("Every rule is ignored");
    const description = document.getElementById(
      chip.getAttribute("aria-describedby")!,
    )!;
    // It does not list the areas: the selectors already show them
    expect(description.textContent).toBe("Every rule is ignored.");
    // It is not an alert: a standing state is not announced as an interruption
    expect(chip.getAttribute("role")).toBeNull();
    // Unrelated state changes do not remove it.
    await act(async () => {
      store.dispatch(setPolicyLevel({ area: "context", level: "manual" }));
    });
    expect(screen.getByTestId("idgaf-chip")).toBeDefined();
  });

  it("choosing the chip goes back to Careful", async () => {
    const { user, store } = await setup();
    await act(async () => {
      store.dispatch(setPolicyLevel({ area: "tools", level: "idgaf" }));
    });
    await user.click(screen.getByTestId("idgaf-chip"));
    expect(store.getState().ui.policyLevels.tools).toBe("cautious");
    expect(screen.queryByTestId("idgaf-chip")).toBeNull();
  });

  it("a preset sets every area at once", async () => {
    const { user, store } = await setup();
    await user.click(screen.getAllByTestId("policy-preset")[0]);
    await user.click(screen.getByTestId("policy-preset-idgaf"));
    expect(Object.values(store.getState().ui.policyLevels)).toEqual(
      Array(5).fill("idgaf"),
    );
    // At the top-level preset the preset chip is the warning: one chip, not two
    expect(screen.queryByTestId("idgaf-chip")).toBeNull();
    const chip = screen.getAllByTestId("policy-preset")[0];
    expect(chip.textContent).toContain("nothing asks");
    const description = document.getElementById(
      chip.getAttribute("aria-describedby")!,
    )!;
    expect(description.textContent).toBe("Every rule is ignored.");
    expect(chip.parentElement!.getAttribute("title")).toContain(
      "Every rule is ignored",
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
    expect(store.getState().ui.policyLevels.tools).toBe("idgaf");
  });

  it("a set of levels that matches no preset reads as Custom, neutral unless one is IDGAF", async () => {
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
      store.dispatch(setPolicyLevel({ area: "edits", level: "idgaf" }));
    });
    expect(chip.className).toContain("bg-error/20");
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
    expect(screen.getByTestId("policy-preset-idgaf").textContent).toContain(
      "All five areas IDGAF.",
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
    const { user } = await renderWithProviders(<PolicyCard />, {
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
    await renderWithProviders(<PolicyCard />, {
      store,
      mockIdeMessenger: ideMessenger,
    });
    await act(async () => {
      await store.dispatch(loadPolicySettings());
    });
    expect(store.getState().ui.policyLevels.tools).toBe("permissive");
    expect(store.getState().ui.policyExtras.floor).toHaveLength(1);
    expect(screen.getByTestId("policy-floor").textContent).toContain(
      "1 floor rule",
    );
  });

  const fileLevels = {
    context: "permissive",
    tools: "cautious",
    edits: "manual",
    plan: "cautious",
    questions: "cautious",
  };
  const hostWith = (session: string[] | "unsupported") => {
    const ideMessenger = new MockIdeMessenger();
    const h = ideMessenger.responseHandlers as any;
    h["policy/load"] = async () => ({
      settings: { levels: fileLevels },
      notices: [],
    });
    const posted: unknown[] = [];
    h["policy/sessionIdgaf"] = async (data: { areas?: string[] }) => {
      if (session === "unsupported") throw new Error("not handled");
      if (data?.areas !== undefined) posted.push(data.areas);
      return { areas: session };
    };
    h["policy/save"] = async () => undefined;
    return { ideMessenger, posted };
  };

  it("a webview reload or extension host restart keeps the session's IDGAF", async () => {
    const { ideMessenger } = hostWith(["tools"]);
    const store = setupStore({ ideMessenger });
    await act(async () => {
      await store.dispatch(loadPolicySettings());
    });
    expect(store.getState().ui.policyLevels.tools).toBe("idgaf");
    // the other areas come from the file
    expect(store.getState().ui.policyLevels.context).toBe("permissive");
    expect(store.getState().ui.policyLevels.edits).toBe("manual");
  });

  it("a new editor session starts at the saved levels, whatever the webview remembered", async () => {
    const { ideMessenger } = hostWith([]);
    const store = setupStore({ ideMessenger });
    await act(async () => {
      store.dispatch(setPolicyLevel({ area: "tools", level: "idgaf" }));
      await store.dispatch(loadPolicySettings());
    });
    expect(store.getState().ui.policyLevels.tools).toBe("cautious");
  });

  it("a host that does not keep session state starts at the saved levels", async () => {
    const { ideMessenger } = hostWith("unsupported");
    const store = setupStore({ ideMessenger });
    await act(async () => {
      store.dispatch(setPolicyLevel({ area: "tools", level: "idgaf" }));
      await store.dispatch(loadPolicySettings());
    });
    expect(store.getState().ui.policyLevels.tools).toBe("cautious");
  });

  it("choosing IDGAF tells the host, for the rest of the editor session", async () => {
    const { ideMessenger, posted } = hostWith([]);
    const store = setupStore({ ideMessenger });
    await act(async () => {
      await store.dispatch(
        applyPolicyPreset({
          context: "idgaf",
          tools: "idgaf",
          edits: "idgaf",
          plan: "idgaf",
          questions: "idgaf",
        }),
      );
    });
    expect(posted.at(-1)).toEqual([
      "context",
      "tools",
      "edits",
      "plan",
      "questions",
    ]);
    await act(async () => {
      await store.dispatch(
        changePolicyLevel({ area: "tools", level: "cautious" }),
      );
    });
    expect(posted.at(-1)).not.toContain("tools");
  });
});
