import { TOOL_DIALECT_VALUES } from "@continuedev/config-yaml";
import type { ModelBlockInfo } from "core/config/modelEdit/modelBlockEdit";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { renderWithProviders } from "../../util/test/render";
import { ModelConfigDialog } from "./ModelConfigDialog";
import { DIALECT_INFO, SAMPLE_TOOL_NAME } from "./toolPreview";

const BLOCK: ModelBlockInfo = {
  editable: true,
  file: "/home/u/.continuous/config.yaml",
  scope: "user",
  entry: {
    name: "Qwen",
    provider: "vllm",
    model: "qwen3-coder",
    apiBase: "http://localhost:8000/v1",
    apiKey: "${{ secrets.QWEN_KEY }}",
    defaultCompletionOptions: { temperature: 0.2 },
  },
  credentials: {
    apiKey: { state: "secret", secretName: "QWEN_KEY" },
    headers: {},
    env: {},
  },
};

function setup(block: ModelBlockInfo = BLOCK) {
  const m = new MockIdeMessenger();
  const preview = vi.fn(async (_req: any) => ({
    errors: [],
    changed: true,
    diff: [
      { kind: "del" as const, text: "      temperature: 0.2" },
      { kind: "add" as const, text: "      temperature: 0.7" },
    ],
    baseHash: "h1",
  }));
  const save = vi.fn(async (_req: any) => ({ saved: true, errors: [] }));
  const setSecret = vi.fn(async (_req: any) => ({ stored: true }));
  m.responseHandlers["config/getModelBlock"] = async () => block;
  m.responseHandlers["config/previewModelEdit"] = preview;
  m.responseHandlers["config/saveModelEdit"] = save;
  m.responseHandlers["config/setSecret"] = setSecret;
  return { m, preview, save, setSecret };
}

async function open(block?: ModelBlockInfo) {
  const mocks = setup(block);
  const onDone = vi.fn();
  const onCancel = vi.fn();
  const onOpenFile = vi.fn();
  const r = await renderWithProviders(
    <ModelConfigDialog
      title="Qwen"
      onDone={onDone}
      onCancel={onCancel}
      onOpenFile={onOpenFile}
    />,
    { mockIdeMessenger: mocks.m },
  );
  return { ...r, ...mocks, onDone, onCancel, onOpenFile };
}

describe("ModelConfigDialog", () => {
  it("is a labelled dialog prefilled from the config entry", async () => {
    await open();
    const dialog = await screen.findByRole("dialog", {
      name: "Configure Qwen",
    });
    await screen.findByRole("tab", { name: "Connection" });
    expect(within(dialog).getByLabelText("Model id")).toHaveValue(
      "qwen3-coder",
    );
    expect(within(dialog).getByLabelText("API base")).toHaveValue(
      "http://localhost:8000/v1",
    );
    expect(screen.getByText("Stored as the secret QWEN_KEY.")).toBeTruthy();
    expect(screen.getByText("/home/u/.continuous/config.yaml")).toBeTruthy();
  });

  it("shows defaults as placeholders, not values", async () => {
    await open();
    const timeout = await screen.findByLabelText("Request timeout (seconds)");
    expect(timeout).toHaveValue("");
    expect(timeout).toHaveAttribute("placeholder", "Default: 7200");
  });

  it("moves between tabs with the arrow keys, Home and End", async () => {
    const { user } = await open();
    const first = await screen.findByRole("tab", { name: "Connection" });
    await waitFor(() => expect(first).toHaveFocus());
    expect(first).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{ArrowRight}");
    const caps = screen.getByRole("tab", { name: "Capabilities" });
    expect(caps).toHaveFocus();
    expect(caps).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute(
      "aria-labelledby",
      caps.id,
    );

    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Advanced (YAML)" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(first).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Advanced (YAML)" })).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Context & cost" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(first).toHaveFocus();
    expect(first).toHaveAttribute("tabindex", "0");
    expect(caps).toHaveAttribute("tabindex", "-1");
  });

  it("sends only the changed field, shows the diff, then saves with the preview's hash", async () => {
    const { user, preview, save, onDone } = await open();
    await user.click(await screen.findByRole("tab", { name: "Generation" }));
    const temp = screen.getByLabelText("Temperature");
    await user.clear(temp);
    await user.type(temp, "0.7");
    await user.click(screen.getByTestId("model-config-review"));

    await waitFor(() => expect(preview).toHaveBeenCalled());
    expect(preview.mock.calls[0][0]).toEqual({
      title: "Qwen",
      ops: [{ path: ["defaultCompletionOptions", "temperature"], value: 0.7 }],
    });
    const diff = await screen.findByTestId("model-config-diff");
    expect(diff.textContent).toContain("temperature: 0.7");

    await user.click(screen.getByTestId("model-config-save"));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0]).toEqual({
      title: "Qwen",
      ops: preview.mock.calls[0][0].ops,
      baseHash: "h1",
    });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("says nothing changed instead of writing", async () => {
    const { user, preview } = await open();
    await user.click(await screen.findByTestId("model-config-review"));
    expect(await screen.findByText("Nothing has changed.")).toBeTruthy();
    expect(preview).not.toHaveBeenCalled();
  });

  it("marks an invalid value on its field and does not preview", async () => {
    const { user, preview } = await open();
    await user.click(await screen.findByRole("tab", { name: "Generation" }));
    const topP = screen.getByLabelText("Top P");
    await user.type(topP, "1.5");
    expect(topP).toHaveAttribute("aria-invalid", "true");
    const describedBy = topP.getAttribute("aria-describedby")!;
    expect(document.getElementById(describedBy)?.textContent).toBe(
      "Must be 1 or less.",
    );
    await user.click(screen.getByTestId("model-config-review"));
    expect(preview).not.toHaveBeenCalled();
  });

  it("jumps to the tab of an error core reports", async () => {
    const { user, preview } = await open();
    preview.mockResolvedValueOnce({
      errors: [{ path: ["model"], message: "Model id is required." }],
      changed: false,
      diff: [],
    } as any);
    await user.click(await screen.findByRole("tab", { name: "Generation" }));
    await user.type(screen.getByLabelText("Max output tokens"), "100");
    await user.click(screen.getByTestId("model-config-review"));
    expect(await screen.findByText("Model id is required.")).toBeTruthy();
    // the tab says it has errors, to a screen reader too
    expect(
      screen.getByRole("tab", { name: "Connection (has errors)" }),
    ).toHaveAttribute("aria-selected", "true");
  });

  it("stores a new key as a secret and writes only the reference", async () => {
    const { user, preview, save, setSecret } = await open();
    await user.click(
      await screen.findByRole("radio", { name: "Use a secret" }),
    );
    const name = screen.getByLabelText("Secret name");
    expect(name).toHaveValue("QWEN_KEY");
    await user.clear(name);
    await user.type(name, "QWEN_NEW");
    await user.type(
      screen.getByLabelText(/New key value/),
      "sk-very-secret-value",
    );
    await user.click(screen.getByTestId("model-config-review"));
    await waitFor(() => expect(preview).toHaveBeenCalled());
    expect(preview.mock.calls[0][0].ops).toEqual([
      { path: ["apiKey"], value: "${{ secrets.QWEN_NEW }}" },
    ]);
    expect(JSON.stringify(preview.mock.calls)).not.toContain(
      "sk-very-secret-value",
    );
    expect(await screen.findByText(/not in config\.yaml/)).toBeTruthy();

    await user.click(screen.getByTestId("model-config-save"));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(setSecret).toHaveBeenCalledWith({
      secretName: "QWEN_NEW",
      value: "sk-very-secret-value",
      storage: "secure",
    });
    expect(JSON.stringify(save.mock.calls)).not.toContain(
      "sk-very-secret-value",
    );
  });

  it("does not save the config when the key cannot be stored", async () => {
    const { user, save, setSecret } = await open();
    setSecret.mockResolvedValueOnce({
      stored: false,
      error: "No secure storage",
    } as any);
    await user.click(
      await screen.findByRole("radio", { name: "Use a secret" }),
    );
    await user.type(screen.getByLabelText(/New key value/), "sk-x");
    await user.click(screen.getByTestId("model-config-review"));
    await user.click(await screen.findByTestId("model-config-save"));
    expect(await screen.findByText("No secure storage")).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it("asks to review again when the file changed after the preview", async () => {
    const { user, save, onDone } = await open();
    save.mockResolvedValueOnce({
      saved: false,
      errors: [],
      stale: true,
      error: "config.yaml changed since the preview. Review the changes again.",
    } as any);
    await user.click(await screen.findByRole("tab", { name: "Generation" }));
    await user.type(screen.getByLabelText("Max output tokens"), "100");
    await user.click(screen.getByTestId("model-config-review"));
    await user.click(await screen.findByTestId("model-config-save"));
    expect(await screen.findByText(/changed since the preview/)).toBeTruthy();
    expect(screen.queryByTestId("model-config-diff")).toBeNull();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("previews the tool prompt style and each supported dialect", async () => {
    const { user } = await open();
    await user.click(await screen.findByRole("tab", { name: "Capabilities" }));

    await user.click(
      screen.getByRole("radio", { name: "Described in the system message" }),
    );
    expect(screen.getByTestId("tool-prompt-preview").textContent).toContain(
      `TOOL_NAME: ${SAMPLE_TOOL_NAME}`,
    );
    await user.click(screen.getByRole("radio", { name: "Native tool calls" }));
    expect(screen.getByTestId("tool-prompt-preview").textContent).toContain(
      `"name": "${SAMPLE_TOOL_NAME}"`,
    );

    const select = screen.getByLabelText(/Tool calls written as text/);
    for (const v of TOOL_DIALECT_VALUES) {
      await user.selectOptions(select, v === "auto" ? "" : v);
      const preview = screen.queryByTestId("tool-dialect-preview");
      if (DIALECT_INFO[v].sample) {
        expect(preview?.textContent, v).toBe(DIALECT_INFO[v].sample);
      } else {
        expect(preview, v).toBeNull();
      }
      expect(
        screen.getByText(DIALECT_INFO[v].summary, { exact: false }),
      ).toBeTruthy();
    }
  });

  it("writes the capabilities list when tool use is set by hand", async () => {
    const { user, preview } = await open();
    await user.click(await screen.findByRole("tab", { name: "Capabilities" }));
    await user.click(screen.getByRole("radio", { name: "Native tool calls" }));
    await user.click(screen.getByTestId("model-config-review"));
    expect(await screen.findByText(/Capabilities is one list/)).toBeTruthy();
    expect(preview).not.toHaveBeenCalled();

    const image = within(
      screen.getByRole("radiogroup", { name: "Image input" }),
    );
    await user.click(image.getByRole("radio", { name: "No" }));
    await user.click(screen.getByTestId("model-config-review"));
    await waitFor(() => expect(preview).toHaveBeenCalled());
    expect(preview.mock.calls[0][0].ops).toEqual([
      { path: ["capabilities"], value: ["tool_use"] },
    ]);
  });

  it("explains a model it cannot edit and offers its file", async () => {
    const { user, onOpenFile } = await open({
      editable: false,
      reason:
        '"Qwen" is used from Catalog Model; its settings are written there.',
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(/Catalog Model/);
    await user.click(screen.getByRole("button", { name: "Open file" }));
    expect(onOpenFile).toHaveBeenCalled();
  });

  it("shows when no price is known, as budgets see it", async () => {
    const { user } = await open();
    await user.click(
      await screen.findByRole("tab", { name: "Context & cost" }),
    );
    expect(screen.getByTestId("price-note").textContent).toMatch(
      /No price is known for vllm\/qwen3-coder/,
    );
  });

  it("names where a known price comes from, as the cost displays do", async () => {
    const { user } = await open({
      ...BLOCK,
      entry: {
        name: "Qwen",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
      },
    });
    await user.click(
      await screen.findByRole("tab", { name: "Context & cost" }),
    );
    expect(screen.getByTestId("price-note").textContent).toMatch(
      /per million tokens\. Prices: Anthropic list prices/,
    );
  });
});
