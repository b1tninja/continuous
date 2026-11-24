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

describe("typing a context length", () => {
  it("keeps what is typed for a model with a published window", async () => {
    const { user } = await open(CLOUD, CLOUD_MODEL, "context");
    const input = screen.getByTestId("context-length-number");
    await user.clear(input);
    await user.type(input, "65536");
    expect(input).toHaveValue("65536");
  });

  it("keeps what is typed for a local server with no known window", async () => {
    const { user } = await open(LOCAL, LOCAL_MODEL, "context");
    const input = screen.getByTestId("context-length-number");
    await user.clear(input);
    await user.type(input, "65536");
    expect(input).toHaveValue("65536");
  });

  it("keeps a value that is a separate step: clear, then a number", async () => {
    const { user } = await open(CLOUD, CLOUD_MODEL, "context");
    const input = screen.getByTestId("context-length-number");
    await user.type(input, "1");
    expect(input).toHaveValue("1");
    await user.type(input, "0");
    expect(input).toHaveValue("10");
  });

  it("a catalog entry (from:) lets the window be typed and reviewed", async () => {
    const CATALOG: ModelBlockInfo = {
      ...CLOUD,
      entry: { from: "Sonnet" },
      catalog: true,
    } as ModelBlockInfo;
    const { user, preview } = await open(CATALOG, CLOUD_MODEL);
    const input = screen.getByTestId("context-length-number");
    await user.clear(input);
    await user.type(input, "65536");
    expect(input).toHaveValue("65536");
    const review = screen.getByTestId("model-config-review");
    expect(review).toBeEnabled();
    await user.click(review);
    await waitFor(() => expect(preview).toHaveBeenCalled());
    expect(await screen.findByTestId("model-config-save")).toBeEnabled();
  });

  it("a normal entry can be reviewed and saved after typing a window", async () => {
    const { user, preview } = await open(CLOUD, CLOUD_MODEL, "context");
    const input = screen.getByTestId("context-length-number");
    await user.clear(input);
    await user.type(input, "65536");
    const review = screen.getByTestId("model-config-review");
    expect(review).toBeEnabled();
    await user.click(review);
    await waitFor(() => expect(preview).toHaveBeenCalled());
    expect(await screen.findByTestId("model-config-save")).toBeEnabled();
  });
});
