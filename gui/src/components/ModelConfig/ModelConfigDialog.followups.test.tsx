import type { ModelBlockInfo } from "core/config/modelEdit/modelBlockEdit";
import { DEFAULT_CHAT_SYSTEM_MESSAGE } from "core/llm/defaultSystemMessages";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { updateConfig } from "../../redux/slices/configSlice";
import { renderWithProviders } from "../../util/test/render";
import { ModelConfigDialog } from "./ModelConfigDialog";

/**
 * The tabs and behaviour added after the first slice: Advanced (YAML),
 * Templates & system message, the price field, Bedrock settings with
 * credentials as secrets, and the focus trap.
 */

const ENTRY_YAML = `name: Qwen
provider: vllm
model: qwen3-coder
apiKey: \${{ secrets.QWEN_KEY }}
defaultCompletionOptions:
  temperature: 0.2 # tuned
`;

const BLOCK: ModelBlockInfo = {
  editable: true,
  file: "/home/u/.continuous/config.yaml",
  scope: "user",
  entry: {
    name: "Qwen",
    provider: "vllm",
    model: "qwen3-coder",
    apiKey: "${{ secrets.QWEN_KEY }}",
    defaultCompletionOptions: { temperature: 0.2 },
  },
  entryYaml: ENTRY_YAML,
  credentials: {
    apiKey: { state: "secret", secretName: "QWEN_KEY" },
    headers: {},
    env: {},
  },
};

const BEDROCK: ModelBlockInfo = {
  editable: true,
  file: "/home/u/.continuous/config.yaml",
  scope: "user",
  entry: {
    name: "Qwen",
    provider: "bedrock",
    model: "anthropic.claude-sonnet-4-6",
    env: { region: "us-east-1", secretAccessKey: "••••••" },
  },
  entryYaml:
    "name: Qwen\nprovider: bedrock\nmodel: anthropic.claude-sonnet-4-6\nenv:\n  region: us-east-1\n  secretAccessKey: ••••••\n",
  credentials: {
    apiKey: { state: "none" },
    headers: {},
    env: { secretAccessKey: { state: "plaintext" } },
  },
};

async function open(block: ModelBlockInfo = BLOCK) {
  const m = new MockIdeMessenger();
  const preview = vi.fn(async (_req: any) => ({
    errors: [] as { path: string[]; message: string }[],
    changed: true,
    diff: [{ kind: "add" as const, text: "    x: 1" }],
    baseHash: "h1",
  }));
  const save = vi.fn(async (_req: any) => ({ saved: true, errors: [] }));
  const setSecret = vi.fn(async (_req: any) => ({ stored: true }));
  m.responseHandlers["config/getModelBlock"] = async () => block;
  m.responseHandlers["config/previewModelEdit"] = preview as any;
  m.responseHandlers["config/saveModelEdit"] = save;
  m.responseHandlers["config/setSecret"] = setSecret;
  const onDone = vi.fn();
  const r = await renderWithProviders(
    <ModelConfigDialog
      title="Qwen"
      onDone={onDone}
      onCancel={vi.fn()}
      onOpenFile={vi.fn()}
    />,
    { mockIdeMessenger: m },
  );
  await screen.findByRole("tab", { name: "Connection" });
  return { ...r, preview, save, setSecret, onDone };
}

const yamlBox = () => screen.getByTestId("model-config-yaml");
const setYaml = (text: string) =>
  fireEvent.change(yamlBox(), { target: { value: text } });

describe("Advanced (YAML) tab", () => {
  it("shows the entry as written and reviews an edit through the same preview and save", async () => {
    const { user, preview, save, onDone } = await open();
    await user.click(screen.getByRole("tab", { name: "Advanced (YAML)" }));
    expect(screen.getByLabelText("This model's entry as YAML")).toHaveValue(
      ENTRY_YAML,
    );
    setYaml(
      ENTRY_YAML.replace("0.2", "0.9") +
        "pricing:\n  input: 0.5\n  output: 2\n",
    );
    expect(screen.getByText("3 settings changed here.")).toBeTruthy();
    await user.click(screen.getByTestId("model-config-review"));
    await waitFor(() => expect(preview).toHaveBeenCalled());
    expect(preview.mock.calls[0][0].ops).toEqual([
      { path: ["defaultCompletionOptions", "temperature"], value: 0.9 },
      { path: ["pricing", "input"], value: 0.5 },
      { path: ["pricing", "output"], value: 2 },
    ]);
    await user.click(await screen.findByTestId("model-config-save"));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0].ops).toEqual(preview.mock.calls[0][0].ops);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("refuses settings the dialog does not manage, before any preview", async () => {
    const { user, preview } = await open();
    await user.click(screen.getByRole("tab", { name: "Advanced (YAML)" }));
    setYaml(ENTRY_YAML.replace("name: Qwen", "name: Renamed") + "routes: []\n");
    expect(yamlBox()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getAllByText(/Not changed here: name, routes/)).toBeTruthy();
    await user.click(screen.getByTestId("model-config-review"));
    expect(preview).not.toHaveBeenCalled();
    expect(
      screen.getByRole("tab", { name: "Advanced (YAML) (has errors)" }),
    ).toHaveAttribute("aria-selected", "true");
  });

  it("says where the YAML does not parse", async () => {
    const { user, preview } = await open();
    await user.click(screen.getByRole("tab", { name: "Advanced (YAML)" }));
    setYaml("name: Qwen\nmodel: [open\n");
    expect(screen.getByText(/Cannot read this YAML\. Line \d+:/)).toBeTruthy();
    await user.click(screen.getByTestId("model-config-review"));
    expect(preview).not.toHaveBeenCalled();
  });

  it("shows a schema error core reports for a YAML change on the YAML tab", async () => {
    const { user, preview } = await open();
    preview.mockResolvedValueOnce({
      errors: [{ path: ["pricing", "output"], message: "Required" }],
      changed: false,
      diff: [],
      baseHash: "",
    });
    await user.click(screen.getByRole("tab", { name: "Advanced (YAML)" }));
    setYaml(ENTRY_YAML + "pricing:\n  input: 1\n");
    await user.click(screen.getByTestId("model-config-review"));
    expect(await screen.findByText("pricing.output: Required")).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: "Advanced (YAML) (has errors)" }),
    ).toHaveAttribute("aria-selected", "true");
  });

  it("will not let the form and the YAML change one setting two ways", async () => {
    const { user, preview } = await open();
    await user.click(screen.getByRole("tab", { name: "Generation" }));
    const temp = screen.getByLabelText("Temperature");
    await user.clear(temp);
    await user.type(temp, "0.5");
    await user.click(screen.getByRole("tab", { name: "Advanced (YAML)" }));
    setYaml(ENTRY_YAML.replace("0.2", "0.9"));
    await user.click(screen.getByTestId("model-config-review"));
    expect(
      await screen.findByText(
        /Changed both on another tab and in the YAML: defaultCompletionOptions.temperature/,
      ),
    ).toBeTruthy();
    expect(preview).not.toHaveBeenCalled();
  });
});

describe("Templates & system message tab", () => {
  it("shows the built-in system message until one is typed, and previews it", async () => {
    const { user, preview } = await open();
    await user.click(
      screen.getByRole("tab", { name: "Templates & system message" }),
    );
    const chat = screen.getByLabelText("Chat system message");
    expect(chat).toHaveValue("");
    expect(chat).toHaveAttribute("placeholder", DEFAULT_CHAT_SYSTEM_MESSAGE);
    expect(screen.getByTestId("system-message-preview").textContent).toBe(
      DEFAULT_CHAT_SYSTEM_MESSAGE,
    );
    await user.type(chat, "Answer in one line.");
    expect(screen.getByTestId("system-message-preview").textContent).toBe(
      "Answer in one line.",
    );
    await user.click(screen.getByTestId("model-config-review"));
    await waitFor(() => expect(preview).toHaveBeenCalled());
    expect(preview.mock.calls[0][0].ops).toEqual([
      {
        path: ["chatOptions", "baseSystemMessage"],
        value: "Answer in one line.",
      },
    ]);
  });

  it("previews the chat template a raw-prompt provider uses", async () => {
    const { user } = await open();
    await user.click(
      screen.getByRole("tab", { name: "Templates & system message" }),
    );
    // vllm is not in the list of providers that template for themselves
    expect(screen.getByTestId("chat-template-preview").textContent).toContain(
      "<|im_start|>user",
    );
    await user.selectOptions(screen.getByLabelText("Chat template"), "llama2");
    expect(screen.getByTestId("chat-template-preview").textContent).toContain(
      "[INST]",
    );
  });

  it("renders an edit template with sample values and names unknown variables", async () => {
    const { user } = await open();
    await user.click(
      screen.getByRole("tab", { name: "Templates & system message" }),
    );
    fireEvent.change(screen.getByLabelText("Edit prompt template"), {
      target: {
        value: "Rewrite {{{codeToEdit}}} to {{{userInput}}} {{{nope}}}",
      },
    });
    expect(screen.getByTestId("edit-template-preview").textContent).toBe(
      "Rewrite   x = x + 1; to rename x to count ",
    );
    expect(screen.getByText("Never filled in, so empty: nope.")).toBeTruthy();
  });

  it("turns a tool off for this model and previews what the model gets", async () => {
    const { user, store, preview } = await open();
    store.dispatch(
      updateConfig({
        ...store.getState().config.config,
        tools: [
          {
            type: "function",
            displayTitle: "Read file",
            readonly: true,
            group: "Built-In",
            function: {
              name: "read_file",
              description: "Read the contents of a file.",
            },
          } as any,
        ],
      }),
    );
    await user.click(
      screen.getByRole("tab", { name: "Templates & system message" }),
    );
    await user.click(screen.getByRole("button", { name: "Add tool override" }));
    await user.selectOptions(
      screen.getByLabelText("Tool (override 1)"),
      "read_file",
    );
    const description = screen.getByLabelText("Description sent to the model");
    expect(description).toHaveAttribute(
      "placeholder",
      "Read the contents of a file.",
    );
    await user.type(description, "Read one file.");
    expect(screen.getByTestId("tool-override-preview").textContent).toBe(
      "read_file: Read one file.",
    );
    await user.click(
      screen.getByRole("checkbox", {
        name: "Turn this tool off for this model",
      }),
    );
    expect(screen.getByTestId("tool-override-preview").textContent).toBe(
      "read_file is not offered to this model.",
    );
    await user.click(screen.getByTestId("model-config-review"));
    await waitFor(() => expect(preview).toHaveBeenCalled());
    expect(preview.mock.calls[0][0].ops).toEqual([
      {
        path: ["chatOptions", "toolOverrides", "read_file"],
        value: { description: "Read one file.", disabled: true },
      },
    ]);
  });
});

describe("price field", () => {
  it("prices an unlisted model from the entry, named 'your config'", async () => {
    const { user, preview } = await open();
    await user.click(screen.getByRole("tab", { name: "Context & cost" }));
    expect(screen.getByTestId("price-note").textContent).toMatch(
      /No price is known for vllm\/qwen3-coder/,
    );
    await user.type(
      screen.getByLabelText("Input price (USD per million tokens)"),
      "0.5",
    );
    await user.type(
      screen.getByLabelText("Output price (USD per million tokens)"),
      "2",
    );
    const note = screen.getByTestId("price-note").textContent!;
    expect(note).toContain("$0.50 in / $2.00 out per million tokens");
    expect(note).toContain("from your config");
    expect(note).toContain("Cache reads $0.50, cache writes $0.50.");
    await user.click(screen.getByTestId("model-config-review"));
    await waitFor(() => expect(preview).toHaveBeenCalled());
    expect(preview.mock.calls[0][0].ops).toEqual([
      { path: ["pricing", "input"], value: 0.5 },
      { path: ["pricing", "output"], value: 2 },
    ]);
  });

  it("refuses a negative price on its field", async () => {
    const { user, preview } = await open();
    await user.click(screen.getByRole("tab", { name: "Context & cost" }));
    const input = screen.getByLabelText("Input price (USD per million tokens)");
    await user.type(input, "-1");
    expect(input).toHaveAttribute("aria-invalid", "true");
    await user.click(screen.getByTestId("model-config-review"));
    expect(preview).not.toHaveBeenCalled();
  });
});

describe("Bedrock settings", () => {
  it("offers tier, latency, guardrails and cross-region inference", async () => {
    const { user, preview } = await open(BEDROCK);
    await user.selectOptions(screen.getByLabelText("Service tier"), "flex");
    await user.selectOptions(
      screen.getByLabelText("Latency mode"),
      "optimized",
    );
    await user.selectOptions(
      screen.getByLabelText("Cross-region inference"),
      "auto",
    );
    await user.type(screen.getByLabelText("Guardrail id or ARN"), "gr-1");
    expect(screen.getByLabelText("Guardrail version")).toHaveAttribute(
      "placeholder",
      "Default: DRAFT",
    );
    await user.click(screen.getByTestId("model-config-review"));
    await waitFor(() => expect(preview).toHaveBeenCalled());
    expect(preview.mock.calls[0][0].ops).toEqual([
      { path: ["env", "crossRegionInference"], value: "auto" },
      { path: ["env", "serviceTier"], value: "flex" },
      { path: ["env", "latency"], value: "optimized" },
      { path: ["env", "guardrailIdentifier"], value: "gr-1" },
    ]);
  });

  it("moves a plain AWS secret to secret storage and writes only the reference", async () => {
    const { user, preview, save, setSecret } = await open(BEDROCK);
    const group = within(
      screen.getByRole("radiogroup", { name: "AWS secret access key" }),
    );
    expect(
      screen.getAllByText(/Written in plain text in config.yaml/).length,
    ).toBe(1);
    await user.click(group.getByRole("radio", { name: "Use a secret" }));
    const fieldset = screen
      .getByRole("radiogroup", { name: "AWS secret access key" })
      .closest("fieldset")!;
    const inside = within(fieldset);
    expect(inside.getByLabelText("Secret name")).toHaveValue(
      "BEDROCK_SECRET_ACCESS_KEY",
    );
    await user.type(inside.getByLabelText(/New value/), "aws-secret-xyz");
    await user.click(screen.getByTestId("model-config-review"));
    await waitFor(() => expect(preview).toHaveBeenCalled());
    expect(preview.mock.calls[0][0].ops).toEqual([
      {
        path: ["env", "secretAccessKey"],
        value: "${{ secrets.BEDROCK_SECRET_ACCESS_KEY }}",
      },
    ]);
    expect(
      await screen.findByText(/The AWS secret access key is stored as/),
    ).toBeTruthy();
    await user.click(screen.getByTestId("model-config-save"));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(setSecret).toHaveBeenCalledWith({
      secretName: "BEDROCK_SECRET_ACCESS_KEY",
      value: "aws-secret-xyz",
      storage: "secure",
    });
    expect(JSON.stringify([preview.mock.calls, save.mock.calls])).not.toContain(
      "aws-secret-xyz",
    );
  });
});

describe("focus trap", () => {
  it("keeps Tab inside the dialog and wraps both ways", async () => {
    const { user } = await open();
    const dialog = screen.getByRole("dialog", { name: "Configure Qwen" });
    const first = screen.getByRole("tab", { name: "Connection" });
    await waitFor(() => expect(first).toHaveFocus());

    const review = screen.getByTestId("model-config-review");
    review.focus();
    await user.tab();
    // past the last control: back to the first one, not out of the dialog
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(
      within(dialog).getByRole("button", { name: "Open file" }),
    );
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(review);
  });

  it("brings focus back when something outside takes it", async () => {
    await open();
    const outside = document.createElement("button");
    outside.textContent = "outside";
    document.body.appendChild(outside);
    outside.focus();
    const dialog = screen.getByRole("dialog", { name: "Configure Qwen" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    outside.remove();
  });

  it("returns focus to the opener when it closes", async () => {
    const opener = document.createElement("button");
    opener.textContent = "gear";
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = await open();
    expect(document.activeElement).not.toBe(opener);
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
