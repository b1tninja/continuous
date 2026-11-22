import { act, screen, waitFor, within } from "@testing-library/react";
import type { ModelDescription } from "core";
import type { ModelBlockInfo } from "core/config/modelEdit/modelBlockEdit";
import { describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { EMPTY_CONFIG, updateConfig } from "../../redux/slices/configSlice";
import { setupStore } from "../../redux/store";
import { renderWithProviders } from "../../util/test/render";
import { ModelConfigDialog, type ModelConfigTab } from "./ModelConfigDialog";
import { formFromBlock, formToOps } from "./modelConfigForm";

const ACCOUNT = {
  name: "work",
  provider: "anthropic",
  apiKey: "${{ secrets.WORK_KEY }}",
  requestOptions: { timeout: 300 },
};

/** A cloud model through an account, with a role the person set. */
const CLOUD: ModelBlockInfo = {
  editable: true,
  file: "/home/u/.continuous/config.yaml",
  scope: "user",
  entry: {
    name: "Sonnet",
    connection: "work",
    model: "claude-sonnet-4-6",
    roles: ["chat", "edit"],
  },
  entryYaml: "",
  credentials: { apiKey: { state: "none" }, headers: {}, env: {} },
  layers: {
    account: ACCOUNT,
    accountFile: "file:///home/u/.continuous/providers.yaml",
  },
};

const CLOUD_MODEL = {
  title: "Sonnet",
  provider: "anthropic",
  underlyingProviderName: "anthropic",
  model: "claude-sonnet-4-6",
  contextLength: 200_000,
  contextLengthSource: "published",
  completionOptions: { model: "claude-sonnet-4-6", maxTokens: 8192 },
  maxTokensSource: "config",
} as ModelDescription;

/** A local server that reports nothing: the window is assumed, no cap is sent. */
const LOCAL: ModelBlockInfo = {
  editable: true,
  file: "/home/u/.continuous/config.yaml",
  scope: "user",
  entry: {
    name: "Sonnet",
    provider: "openai",
    model: "my-finetune",
    apiBase: "http://127.0.0.1:8080/v1",
  },
  entryYaml: "",
  credentials: { apiKey: { state: "none" }, headers: {}, env: {} },
};

const LOCAL_MODEL = {
  title: "Sonnet",
  provider: "openai",
  underlyingProviderName: "openai",
  model: "my-finetune",
  apiBase: "http://127.0.0.1:8080/v1/",
  contextLength: 32_768,
  contextLengthSource: "unknown",
  completionOptions: { model: "my-finetune" },
  maxTokensSource: "none",
} as ModelDescription;

async function open(
  block: ModelBlockInfo = CLOUD,
  model: ModelDescription = CLOUD_MODEL,
  initialTab?: ModelConfigTab,
) {
  const m = new MockIdeMessenger();
  // The startup config load would replace the model set below
  m.responseHandlers["config/getSerializedProfileInfo"] = () =>
    new Promise(() => {});
  const preview = vi.fn(async (_req: any) => ({
    errors: [],
    changed: true,
    diff: [],
    baseHash: "h1",
  }));
  const listed = vi.fn(async (_req: any) => ({ ok: true as const }) as any);
  const posted: [string, unknown][] = [];
  const post = m.post.bind(m);
  m.post = ((type: string, data: unknown) => {
    posted.push([type, data]);
    return post(type as never, data as never);
  }) as typeof m.post;
  m.responseHandlers["config/getModelBlock"] = async () => block;
  m.responseHandlers["config/previewModelEdit"] = preview;
  m.responseHandlers["models/listedLimits"] = listed;
  const store = setupStore({ ideMessenger: m });
  const view = await renderWithProviders(
    <ModelConfigDialog
      title="Sonnet"
      onDone={vi.fn()}
      onCancel={vi.fn()}
      onOpenFile={vi.fn()}
      {...(initialTab ? { initialTab } : {})}
    />,
    { store, mockIdeMessenger: m },
  );
  await act(async () => {
    store.dispatch(
      updateConfig({
        ...EMPTY_CONFIG,
        modelsByRole: { ...EMPTY_CONFIG.modelsByRole, chat: [model] },
      } as never),
    );
  });
  await screen.findByTestId("model-overview").catch(() => undefined);
  return { ...view, preview, listed, posted };
}

const row = (key: string) => screen.getByTestId(`overview-row-${key}`);

describe("the Overview tab", () => {
  it("is the first tab, shown and focused when the dialog opens", async () => {
    await open();
    const tabs = screen.getAllByRole("tab");
    expect(tabs[0]).toHaveTextContent("Overview");
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(tabs[0]).toHaveFocus());
    expect(
      screen.getByRole("table", { name: "What this model will do" }),
    ).toBeTruthy();
  });

  it("has a row for each thing that costs money, limits a reply or says what the model can do", async () => {
    await open();
    expect(screen.getAllByRole("rowheader").map((h) => h.textContent)).toEqual([
      "Context length",
      "Max output",
      "Reasoning effort",
      "Reasoning budget",
      "Temperature",
      "Prompt caching",
      "Price in / out per million",
      "Tools",
      "Images",
      "Used for",
      "Request timeout",
    ]);
  });

  it("gives each row its value in use and where it comes from", async () => {
    await open();
    const cells = (key: string) =>
      within(row(key))
        .getAllByRole("cell")
        .map((c) => c.textContent);
    expect(cells("contextLength").slice(0, 2)).toEqual([
      "200,000 tokens",
      "published",
    ]);
    expect(cells("defaultCompletionOptions.maxTokens").slice(0, 2)).toEqual([
      "8,192, the built-in limit for anthropic",
      "not set",
    ]);
    expect(cells("defaultCompletionOptions.reasoning").slice(0, 2)).toEqual([
      "on, medium effort",
      "detected",
    ]);
    expect(
      cells("defaultCompletionOptions.reasoningBudgetTokens").slice(0, 2),
    ).toEqual(["2,048 tokens when reasoning is on", "not set"]);
    expect(cells("defaultCompletionOptions.temperature").slice(0, 2)).toEqual([
      "not sent, the provider decides",
      "not set",
    ]);
    expect(cells("defaultCompletionOptions.promptCaching")[0]).toContain(
      "5 minutes, then 1 hour",
    );
    expect(cells("pricing.input")[1]).toBe("price table");
    expect(cells("pricing.input")[0]).toMatch(/^\$\d+\.\d\d \/ \$\d+\.\d\d$/);
    expect(cells("capabilities.tools").slice(0, 2)).toEqual([
      "yes",
      "detected",
    ]);
    expect(cells("roles").slice(0, 2)).toEqual([
      "chat, edit",
      "set by you, config.yaml",
    ]);
    expect(cells("requestOptions.timeout").slice(0, 2)).toEqual([
      "300 s",
      "account work",
    ]);
    expect(row("roles")).toHaveAttribute("data-source", "user");
    expect(row("requestOptions.timeout")).toHaveAttribute(
      "data-source",
      "account",
    );
  });

  it("offers one action per row: Reset for the person's value, Go for an inherited one, else Set", async () => {
    await open();
    const actions = (key: string) =>
      within(row(key))
        .getAllByRole("button")
        .map((b) => b.textContent);
    expect(actions("roles")).toEqual(["Reset"]);
    expect(actions("requestOptions.timeout")).toEqual(["Go to account"]);
    expect(actions("defaultCompletionOptions.temperature")).toEqual(["Set"]);
    expect(actions("contextLength")).toEqual(["Set"]);
  });

  it("Set jumps to the field on its panel", async () => {
    const { user } = await open();
    await user.click(screen.getByRole("button", { name: "Set Temperature" }));
    expect(screen.getByRole("tab", { name: "Generation" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Temperature")).toHaveFocus(),
    );
  });

  it("Set on the window goes to the context length field", async () => {
    const { user } = await open();
    await user.click(
      screen.getByRole("button", { name: "Set Context length" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("context-length-number")).toHaveFocus(),
    );
  });

  it("Reset removes the key from the file the person set it in", async () => {
    const { user, preview } = await open();
    await user.click(screen.getByRole("button", { name: "Reset Used for" }));
    // The row now says what not set does
    expect(row("roles")).toHaveTextContent("chat, edit, apply, summarize");
    expect(row("roles")).toHaveAttribute("data-source", "notSet");
    await user.click(screen.getByTestId("model-config-review"));
    await waitFor(() => expect(preview).toHaveBeenCalled());
    expect(preview.mock.calls[0][0].ops).toEqual([{ path: ["roles"] }]);
  });

  it("Go opens the account's file", async () => {
    const { user, posted } = await open();
    await user.click(
      screen.getByRole("button", { name: "Go to account for Request timeout" }),
    );
    expect(posted).toContainEqual([
      "openFile",
      { path: "file:///home/u/.continuous/providers.yaml" },
    ]);
  });

  it("names an inherited value's source without a button when there is no file to open", async () => {
    await open({ ...CLOUD, layers: { account: ACCOUNT } });
    expect(row("requestOptions.timeout")).toHaveTextContent("account work");
    // Nothing to go to, so the row offers to set the value here
    expect(
      within(row("requestOptions.timeout"))
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Set"]);
  });

  it("folds everything else, with how many settings and how many the person set", async () => {
    const { user } = await open({
      ...CLOUD,
      entry: {
        ...CLOUD.entry,
        defaultCompletionOptions: { topP: 0.9 },
        requestOptions: { connectTimeout: 5 },
      },
    });
    const toggle = screen.getByTestId("overview-rest-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle.textContent).toMatch(
      /^Show everything else \(\d+ settings, 2 set by you\)$/,
    );
    expect(screen.queryByTestId("overview-rest")).toBeNull();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const rest = screen.getByTestId("overview-rest");
    const count = Number(/\((\d+) settings/.exec(toggle.textContent!)![1]);
    expect(within(rest).getAllByRole("listitem")).toHaveLength(count);
    expect(
      screen.getByTestId("overview-rest-defaultCompletionOptions.topP"),
    ).toHaveTextContent(/^Top P\s*0.9\s*set by you\s*Reset$/);
    expect(
      screen.getByTestId("overview-rest-defaultCompletionOptions.topK"),
    ).toHaveTextContent(
      /^Top K\s*not sent, the provider decides\s*not set\s*Set$/,
    );

    // Set under the fold jumps too
    await user.click(screen.getByRole("button", { name: "Set Top K" }));
    await waitFor(() => expect(screen.getByLabelText("Top K")).toHaveFocus());
  });

  it("says none when the person set nothing under the fold", async () => {
    await open();
    expect(screen.getByTestId("overview-rest-toggle").textContent).toMatch(
      /settings, none set by you\)$/,
    );
  });

  it("has the connection test", async () => {
    await open();
    expect(
      within(screen.getByTestId("model-overview")).getByRole("button", {
        name: "Test connection",
      }),
    ).toBeTruthy();
  });

  it("never shows $0 for a model with no known price", async () => {
    await open(LOCAL, LOCAL_MODEL);
    expect(row("pricing.input")).toHaveTextContent(
      "no price known: cost is not estimated",
    );
    expect(row("pricing.input").textContent).not.toMatch(/\$0/);
  });
});

describe("the Overview for a local server that reports nothing", () => {
  it("says the window is assumed and that the server decides the output limit", async () => {
    await open(LOCAL, LOCAL_MODEL);
    expect(row("contextLength")).toHaveTextContent("32,768 tokens");
    expect(row("contextLength")).toHaveAttribute("data-source", "assumed");
    expect(screen.getByTestId("assumed-window")).toHaveTextContent(
      "Set the real size, or ask the server.",
    );
    expect(row("defaultCompletionOptions.maxTokens")).toHaveTextContent(
      "the server decides",
    );
  });

  it("asks the server with the dialog's own check, and says when it does not answer", async () => {
    const { user, listed } = await open(LOCAL, LOCAL_MODEL);
    const before = listed.mock.calls.length;
    await user.click(screen.getByTestId("ask-server-window"));
    await waitFor(() => expect(listed.mock.calls.length).toBe(before + 1));
    expect(
      await screen.findByText(
        "The server did not say how large its window is.",
      ),
    ).toBeTruthy();
  });

  it("offers the size the server reports", async () => {
    const { user, listed, preview } = await open(LOCAL, LOCAL_MODEL);
    listed.mockResolvedValue({
      ok: true,
      limits: {
        contextLength: 65_536,
        note: "The server lists 65,536 tokens.",
      },
    });
    await user.click(screen.getByTestId("ask-server-window"));
    await user.click(await screen.findByTestId("use-reported-window"));
    expect(row("contextLength")).toHaveTextContent("65,536 tokens");
    expect(row("contextLength")).toHaveAttribute("data-source", "user");
    await user.click(screen.getByTestId("model-config-review"));
    await waitFor(() => expect(preview).toHaveBeenCalled());
    expect(preview.mock.calls[0][0].ops).toEqual([
      { path: ["contextLength"], value: 65_536 },
    ]);
  });
});

describe("the Overview for a catalog model", () => {
  const CATALOG: ModelBlockInfo = {
    ...CLOUD,
    catalog: true,
    entry: { from: "Claude Sonnet#plan", roles: ["chat"] },
    layers: {
      ...CLOUD.layers,
      catalogModel: {
        name: "Claude Sonnet",
        connection: "work",
        model: "claude-sonnet-4-6",
        contextLength: 200_000,
        defaultCompletionOptions: { temperature: 0.6, maxTokens: 32_000 },
        variants: {
          plan: { defaultCompletionOptions: { reasoningBudgetTokens: 8000 } },
        },
      },
      catalogFile: "file:///home/u/.continuous/models.yaml",
    },
  };

  it("names the right layer for each set key", async () => {
    await open(CATALOG);
    const source = (key: string) => row(key).getAttribute("data-source");
    expect(source("contextLength")).toBe("catalog");
    expect(source("defaultCompletionOptions.maxTokens")).toBe("catalog");
    expect(source("defaultCompletionOptions.temperature")).toBe("catalog");
    expect(source("defaultCompletionOptions.reasoningBudgetTokens")).toBe(
      "variant",
    );
    expect(source("requestOptions.timeout")).toBe("account");
    expect(source("roles")).toBe("user");
    expect(row("defaultCompletionOptions.temperature")).toHaveTextContent(
      "0.6",
    );
    expect(
      row("defaultCompletionOptions.reasoningBudgetTokens"),
    ).toHaveTextContent("variant plan");
  });

  it("offers to change only what a catalog entry can hold", async () => {
    const { posted, user } = await open(CATALOG);
    // The roles are the person's, but this dialog does not write them here
    expect(within(row("roles")).queryByRole("button")).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Go to catalog for Temperature" }),
    );
    expect(posted).toContainEqual([
      "openFile",
      { path: "file:///home/u/.continuous/models.yaml" },
    ]);
    expect(screen.getByTestId("context-length-state")).toHaveTextContent(
      "Not set: 200,000 from the catalog model",
    );
  });
});

describe("no panel leaves a value unexplained", () => {
  const TABS = [
    "Connection",
    "Capabilities",
    "Generation",
    "Templates & system message",
    "Context & cost",
  ];

  it("has no option, placeholder or label that says only Default", async () => {
    const { user } = await open();
    for (const name of TABS) {
      await user.click(screen.getByRole("tab", { name }));
      const panel = screen.getByRole("tabpanel");
      for (const option of panel.querySelectorAll("option")) {
        expect(option.textContent, name).not.toMatch(/^default\b/i);
      }
      for (const input of panel.querySelectorAll("input, textarea")) {
        const placeholder = input.getAttribute("placeholder") ?? "";
        expect(placeholder, name).not.toMatch(/^default\b/i);
      }
      for (const label of panel.querySelectorAll("label")) {
        expect(label.textContent, name).not.toMatch(/^\s*default\b/i);
      }
    }
  });

  it("says Set by you or Not set under every field of every panel", async () => {
    const { user } = await open();
    for (const name of TABS) {
      await user.click(screen.getByRole("tab", { name }));
      const panel = screen.getByRole("tabpanel");
      const controls = panel.querySelectorAll<HTMLElement>(
        "input[id^='mc-']:not([type='radio']):not([type='checkbox']), textarea[id^='mc-'], select[id^='mc-']",
      );
      for (const control of controls) {
        const described = (control.getAttribute("aria-describedby") ?? "")
          .split(" ")
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ");
        expect(described, `${name}: ${control.id}`).toMatch(
          /(Set by you|Not set): \S/,
        );
      }
    }
  });

  it("the five that said Default now say what happens", async () => {
    const { user } = await open();
    await user.click(screen.getByRole("tab", { name: "Generation" }));
    expect(screen.getByLabelText("Reasoning")).toHaveAccessibleDescription(
      /^Not set: on in chat, this model is detected as a reasoning model/,
    );
    await user.click(screen.getByRole("tab", { name: "Context & cost" }));
    expect(screen.getByLabelText("Prompt caching")).toHaveAccessibleDescription(
      /^Not set: in the IDE, on in Agent, Plan and Background/,
    );
    expect(
      screen.getByLabelText("Cache the system prompt"),
    ).toHaveAccessibleDescription("Not set: follows Prompt caching");
    expect(
      screen.getByLabelText("Cache the conversation"),
    ).toHaveAccessibleDescription("Not set: follows Prompt caching");
    expect(screen.getByLabelText("Cache lifetime")).toHaveAccessibleDescription(
      /^Not set: 5 minutes/,
    );
  });

  it("Reset under a field empties it, and the save removes the key", async () => {
    const { user, preview } = await open(
      {
        ...CLOUD,
        entry: {
          ...CLOUD.entry,
          defaultCompletionOptions: { temperature: 0.2 },
        },
      },
      CLOUD_MODEL,
      "generation",
    );
    const temperature = await screen.findByLabelText("Temperature");
    expect(temperature).toHaveAccessibleDescription("Set by you: 0.2");
    await user.click(screen.getByRole("button", { name: "Reset Temperature" }));
    expect(temperature).toHaveValue("");
    expect(temperature).toHaveAccessibleDescription(
      "Not set: not sent, the provider decides",
    );
    await user.click(screen.getByTestId("model-config-review"));
    await waitFor(() => expect(preview).toHaveBeenCalled());
    expect(preview.mock.calls[0][0].ops).toEqual([
      { path: ["defaultCompletionOptions", "temperature"] },
    ]);
  });

  it("writes nothing when the person touches nothing", async () => {
    const { user, preview } = await open();
    for (const name of [...TABS, "Overview"]) {
      await user.click(screen.getByRole("tab", { name }));
    }
    await user.click(screen.getByTestId("model-config-review"));
    expect(await screen.findByText("Nothing has changed.")).toBeTruthy();
    expect(preview).not.toHaveBeenCalled();
  });
});

describe("a form that is opened and saved untouched", () => {
  it("adds no key, for an entry that sets nothing and for one that sets some", () => {
    for (const block of [CLOUD, LOCAL]) {
      const form = formFromBlock(block);
      expect(formToOps(form, structuredClone(form))).toEqual({
        ops: [],
        errors: {},
      });
    }
  });
});
