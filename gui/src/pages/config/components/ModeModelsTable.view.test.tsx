import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { setupStore } from "../../../redux/store";
import { MockIdeMessenger } from "../../../context/MockIdeMessenger";
import { renderWithProviders } from "../../../util/test/render";
import { ModeModelsTable } from "./ModeModelsTable";
import {
  box,
  promptBlock,
  promptSelect,
  saveButton,
  setupTable,
  star,
  tailSelect,
  tailText,
} from "./modeModelsTableTestUtils";

describe("ModeModelsTable: what a choice that is not set does", () => {
  const options = (select: HTMLSelectElement) =>
    Array.from(select.options).map((o) => o.textContent);

  it("has no option that says only Default", async () => {
    await setupTable({ agent: { title: "Alpha" } });
    const selects = screen
      .getByTestId("mode-models-table")
      .querySelectorAll("select");
    expect(selects.length).toBeGreaterThan(10);
    for (const select of selects) {
      for (const text of options(select)) {
        expect(text).not.toMatch(/^default$/i);
      }
      expect(options(select)[0]).toMatch(/^Not set(: .+)?$/);
    }
  });

  it("says the model's setting for an effort, and the rule where no model is starred", async () => {
    await setupTable();
    // The text above the table says once what "Not set" means
    expect(
      options(
        screen.getByLabelText("Reasoning effort for Plan") as HTMLSelectElement,
      )[0],
    ).toBe("Not set");
    expect(screen.getByTestId("mode-not-set")).toHaveTextContent(
      "What Not set does. Reasoning effort: the model's setting.",
    );
    expect(screen.getByTestId("mode-not-set")).toHaveTextContent(
      "the short text for a Qwen model, the full one for every other",
    );
    expect(options(promptSelect("Chat"))[0]).toBe("Not set");
    expect(options(tailSelect("Chat"))[0]).toBe("Not set");
    // Loop items always get the reminder
    expect(options(tailSelect("Loop"))[0]).toBe("Not set: on");
  });

  it("names the text the starred model gets, and the reminder that goes with it", async () => {
    await setupTable(
      { agent: { title: "Qwen" }, plan: { title: "Alpha" } },
      { saved: true },
      {
        modelsByRole: {
          chat: [
            {
              title: "Alpha",
              model: "claude-sonnet-4-6",
              provider: "anthropic",
            },
            { title: "Qwen", model: "qwen3-32b", provider: "openai" },
            { title: "Coder", model: "qwen3-coder-30b", provider: "openai" },
          ],
        },
      },
    );
    expect(options(promptSelect("Plan"))[0]).toBe("Not set: Full");
    expect(options(tailSelect("Plan"))[0]).toBe("Not set: off");
    expect(options(promptSelect("Agent"))[0]).toBe("Not set: Short");
    expect(options(tailSelect("Agent"))[0]).toBe("Not set: on");
    // Loop and Re-plan take the Agent and Plan models when none is starred
    expect(options(promptSelect("Loop"))[0]).toBe("Not set: Short");
    expect(options(promptSelect("Re-plan"))[0]).toBe("Not set: Full");
    expect(options(tailSelect("Re-plan"))[0]).toBe("Not set: off");
  });

  it("follows the fallback mode's own choice", async () => {
    await setupTable({
      agent: { title: "Alpha", prompt: "short", tail: "off" },
    });
    expect(options(promptSelect("Loop"))[0]).toBe("Not set: Short");
    expect(options(tailSelect("Loop"))[0]).toBe("Not set: off");
    // The empty choice of Agent itself says what removing its own does
    expect(options(promptSelect("Agent"))[0]).toBe("Not set: Full");
  });
});

describe("ModeModelsTable: what it shows", () => {
  it("renders nothing when there are no chat models", async () => {
    const ideMessenger = new MockIdeMessenger();
    const store = setupStore({ ideMessenger });
    await renderWithProviders(<ModeModelsTable />, {
      store,
      mockIdeMessenger: ideMessenger,
    });
    expect(screen.queryByTestId("mode-models-table")).toBeNull();
  });

  it("shows the current config: ticks, default star and effort", async () => {
    await setupTable({
      plan: {
        title: "Bravo",
        titles: ["Bravo", "Alpha"],
        reasoningEffort: "high",
      },
    });
    expect(box("Plan", "Bravo").checked).toBe(true);
    expect(box("Plan", "Alpha").checked).toBe(true);
    expect(box("Plan", "Charlie").checked).toBe(false);
    expect(star("Plan", "Bravo").getAttribute("aria-pressed")).toBe("true");
    expect(star("Plan", "Alpha").getAttribute("aria-pressed")).toBe("false");
    expect(
      (screen.getByLabelText("Reasoning effort for Plan") as HTMLSelectElement)
        .value,
    ).toBe("high");
    expect(box("Agent", "Alpha").checked).toBe(false);
  });

  it("shows the prompt and reminder of each turn use, with prompt blocks as options", async () => {
    await setupTable(
      {
        loop: { title: "Alpha", prompt: "terse", tail: "on" },
        plan: { prompt: "short", tail: "Ask first." },
        agent: { title: "Bravo", prompt: "missing-block" },
      },
      { saved: true },
      { slashCommands: [promptBlock("terse"), promptBlock("careful")] },
    );
    expect(promptSelect("Loop").value).toBe("terse");
    expect(
      Array.from(promptSelect("Loop").options).map((o) => o.textContent),
    ).toEqual(["Not set: Full", "Full", "Short", "terse", "careful"]);
    expect(tailSelect("Loop").value).toBe("on");
    expect(screen.queryByLabelText("Reminder text for Loop")).toBeNull();

    // A prompt or a reminder with no model is shown too
    expect(promptSelect("Plan").value).toBe("short");
    expect(tailSelect("Plan").value).toBe("text");
    expect(tailText("Plan").value).toBe("Ask first.");

    // A hand-written name that matches no loaded block is kept visible
    expect(promptSelect("Agent").value).toBe("missing-block");
    expect(promptSelect("Chat").value).toBe("");
    expect(tailSelect("Chat").value).toBe("");

    // Subagents take the prompt of their definition: nothing to pick
    expect(screen.queryByLabelText("Prompt for Subagent")).toBeNull();
    expect(screen.queryByLabelText("Reminder for Subagent")).toBeNull();
    expect(saveButton().disabled).toBe(true);
  });

  it("Save is disabled until something changes", async () => {
    await setupTable({ plan: { title: "Alpha", titles: ["Alpha", "Bravo"] } });
    expect(saveButton().disabled).toBe(true);
  });

  it("Reset throws away unsaved edits without saving", async () => {
    const { user, calls } = await setupTable({
      plan: { title: "Alpha", titles: ["Alpha"] },
    });
    await user.click(box("Plan", "Bravo"));
    expect(box("Plan", "Bravo").checked).toBe(true);
    await user.click(screen.getByText("Reset"));
    expect(box("Plan", "Bravo").checked).toBe(false);
    expect(saveButton().disabled).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("a model picked in a mode can be un-defaulted only by picking another", async () => {
    const { user } = await setupTable({
      plan: { title: "Alpha", titles: ["Alpha", "Bravo"] },
    });
    await user.click(star("Plan", "Bravo"));
    await waitFor(() =>
      expect(star("Plan", "Bravo").getAttribute("aria-pressed")).toBe("true"),
    );
    expect(star("Plan", "Alpha").getAttribute("aria-pressed")).toBe("false");
  });
});
