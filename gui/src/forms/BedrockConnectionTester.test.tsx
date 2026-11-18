import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { IdeMessengerContext } from "../context/IdeMessenger";
import { MockIdeMessenger } from "../context/MockIdeMessenger";
import { BedrockConnectionTester } from "./BedrockConnectionTester";

const models = [
  {
    id: "us.anthropic.claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (us. cross-region)",
    provider: "Anthropic",
    kind: "inference-profile" as const,
  },
  {
    id: "amazon.nova-pro-v1:0",
    name: "Nova Pro",
    provider: "Amazon",
    kind: "on-demand" as const,
  },
];

function setup(handlers: Record<string, (data: any) => any>) {
  const messenger = new MockIdeMessenger();
  Object.assign(messenger.responseHandlers, handlers);
  const onModelsLoaded = vi.fn();
  const user = userEvent.setup();
  render(
    <IdeMessengerContext.Provider value={messenger}>
      <BedrockConnectionTester
        connection={{ region: "us-east-1", apiKey: "k" }}
        model="anthropic.claude-sonnet-4-6"
        canTest
        onModelsLoaded={onModelsLoaded}
      />
    </IdeMessengerContext.Provider>,
  );
  return { user, onModelsLoaded };
}

describe("BedrockConnectionTester", () => {
  it("lists models from both endpoints and hands them to the model picker", async () => {
    const list = vi.fn(async (data: any) =>
      data.endpoint === "mantle"
        ? {
            ok: true,
            models: [
              {
                id: "openai.gpt-daybreak-blue-5.6-sol",
                name: "GPT Daybreak Blue 5.6 Sol",
                provider: "OpenAI",
                kind: "on-demand" as const,
              },
            ],
          }
        : { ok: true, models },
    );
    const { user, onModelsLoaded } = setup({ "bedrock/listModels": list });

    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(
      await screen.findByText(
        /3 models available in us-east-1 \(1 only on Bedrock Mantle, AWS's newer endpoint\)/,
      ),
    ).toBeTruthy();
    expect(list).toHaveBeenCalledWith({ region: "us-east-1", apiKey: "k" });
    expect(list).toHaveBeenCalledWith({
      region: "us-east-1",
      apiKey: "k",
      endpoint: "mantle",
    });
    const [loaded] = onModelsLoaded.mock.calls.at(-1)!;
    expect(loaded.map((m: any) => `${m.endpoint}:${m.id}`).sort()).toEqual([
      "mantle:openai.gpt-daybreak-blue-5.6-sol",
      "runtime:amazon.nova-pro-v1:0",
      "runtime:us.anthropic.claude-sonnet-4-6",
    ]);
  });

  it("still lists standard models when the Mantle endpoint fails", async () => {
    const { user, onModelsLoaded } = setup({
      "bedrock/listModels": async (data: any) =>
        data.endpoint === "mantle"
          ? { ok: false, error: "403 Forbidden\n\nmore detail" }
          : { ok: true, models },
    });
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(
      await screen.findByText(/2 models available in us-east-1/),
    ).toBeTruthy();
    const [loaded, notes] = onModelsLoaded.mock.calls.at(-1)!;
    expect(loaded).toHaveLength(2);
    expect(notes.join(" ")).toContain(
      "Mantle models unavailable: 403 Forbidden",
    );
  });

  const useCaseNotice =
    "Anthropic models on this account need the Anthropic use-case form completed before they will work (Bedrock console, Model access).";

  it("shows one notice and passes the flag on when Anthropic models need the form", async () => {
    const flagged = models.map((m) =>
      m.provider === "Anthropic" ? { ...m, needsAnthropicUseCase: true } : m,
    );
    const { user, onModelsLoaded } = setup({
      "bedrock/listModels": async (data: any) =>
        data.endpoint === "mantle"
          ? { ok: true, models: [] }
          : { ok: true, models: flagged },
    });
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findAllByText(useCaseNotice)).toHaveLength(1);
    const [loaded] = onModelsLoaded.mock.calls.at(-1)!;
    expect(
      loaded.filter((m: any) => m.needsAnthropicUseCase).map((m: any) => m.id),
    ).toEqual(["us.anthropic.claude-sonnet-4-6"]);
  });

  it("shows no notice when nothing is flagged", async () => {
    const { user } = setup({
      "bedrock/listModels": async () => ({ ok: true, models }),
    });
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByText(/models available in us-east-1/);
    expect(screen.queryByText(useCaseNotice)).toBeNull();
  });

  it("counts the models that need access and passes the state on", async () => {
    const withAccess = [
      { ...models[0], access: "needs-access" as const, legacy: true },
      { ...models[1], access: "available" as const },
      {
        id: "us.anthropic.claude-opus-4-1",
        name: "Claude Opus 4.1 (us. cross-region)",
        provider: "Anthropic",
        kind: "inference-profile" as const,
        access: "pending" as const,
      },
    ];
    const { user, onModelsLoaded } = setup({
      "bedrock/listModels": async (data: any) =>
        data.endpoint === "mantle"
          ? { ok: true, models: [] }
          : { ok: true, models: withAccess },
    });
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(
      await screen.findByText(/need access \(Bedrock console, Model access\)/),
    ).toBeTruthy();
    expect(screen.getByText(/2 need access/)).toBeTruthy();
    const [loaded] = onModelsLoaded.mock.calls.at(-1)!;
    expect(loaded.map((m: any) => m.access)).toEqual([
      "needs-access",
      "available",
      "pending",
    ]);
  });

  it("clears the model list when the connection fails", async () => {
    const { user, onModelsLoaded } = setup({
      "bedrock/listModels": async () => ({ ok: false, error: "nope" }),
    });
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByText("nope");
    expect(onModelsLoaded).toHaveBeenLastCalledWith(undefined, []);
  });

  it("shows the error (with its hint) when the connection fails", async () => {
    setup({
      "bedrock/listModels": async () => ({
        ok: false,
        error: "Token expired\n\nRun `aws sso login`",
      }),
    });
    await act(async () => {
      screen.getByRole("button", { name: "Test connection" }).click();
    });
    expect(await screen.findByText(/aws sso login/)).toBeTruthy();
  });

  it("announces a failure as an alert with the error in a copyable code block", async () => {
    const arn =
      "AccessDenied: arn:aws:sts::123456789012:assumed-role/dev-role-with-a-long-name/session";
    const { user } = setup({
      "bedrock/listModels": async () => ({ ok: false, error: arn }),
    });
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not connect");
    const code = alert.querySelector("code")!;
    expect(code.textContent).toBe(arn);
    expect(code.className).toContain("break-all");
    expect(screen.queryByRole("status")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Copy error" }));
    expect(writeText).toHaveBeenCalledWith(arn);
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("announces success as a status: one headline and one detail line", async () => {
    const { user } = setup({
      "bedrock/listModels": async () => ({ ok: true, models }),
    });
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    const status = (await screen.findAllByRole("status"))[0]!;
    expect(status.textContent).toMatch(/^Connected\. 2 models available/);
    expect(status.querySelectorAll("span.block")).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("sends a test message to the current model", async () => {
    const test = vi.fn(async () => ({
      ok: true,
      modelId: "us.anthropic.claude-sonnet-4-6",
      latencyMs: 420,
      reply: "ok",
    }));
    const { user } = setup({ "bedrock/testModel": test });
    await user.click(screen.getByRole("button", { name: "Send test message" }));
    await waitFor(() => expect(screen.getByText(/in 420 ms/)).toBeTruthy());
    expect(test).toHaveBeenCalledWith({
      region: "us-east-1",
      apiKey: "k",
      model: "anthropic.claude-sonnet-4-6",
    });
  });
});

describe("BedrockConnectionTester tool-call line", () => {
  const list = async () => ({ ok: true, models });

  it("shows the probe label after Test connection", async () => {
    const probe = vi.fn(async () => ({
      ok: true,
      label: "Tool calls: written as text (qwen-xml)",
      kind: "text",
    }));
    const { user } = setup({
      "bedrock/listModels": list,
      "bedrock/probeToolCalls": probe,
    });
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() =>
      expect(screen.getByTestId("tool-calls-result").textContent).toBe(
        "Tool calls: written as text (qwen-xml)",
      ),
    );
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("shows the family preset line under the label when there is one", async () => {
    const { user } = setup({
      "bedrock/listModels": list,
      "bedrock/probeToolCalls": async () => ({
        ok: true,
        label: "Tool calls: native",
        kind: "native",
        preset:
          "Known format for this model family: glm-xml (tools written as text)",
        facts:
          "Provider facts: Bedrock Converse: tool_choice supported (declared, read 2026-11-10)",
      }),
    });
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() =>
      expect(screen.getByTestId("tool-calls-preset").textContent).toContain(
        "glm-xml",
      ),
    );
    expect(screen.getByTestId("tool-calls-facts").textContent).toContain(
      "Provider facts: Bedrock Converse",
    );
    expect(screen.getByTestId("tool-calls-result").textContent).toBe(
      "Tool calls: native",
    );
  });

  it("is not sent without a click on Test connection", async () => {
    const probe = vi.fn();
    setup({ "bedrock/listModels": list, "bedrock/probeToolCalls": probe });
    expect(probe).not.toHaveBeenCalled();
  });

  it("reports unknown when the probe fails", async () => {
    const { user } = setup({
      "bedrock/listModels": list,
      "bedrock/probeToolCalls": async () => ({ ok: false, error: "timeout" }),
    });
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() =>
      expect(screen.getByTestId("tool-calls-result").textContent).toBe(
        "Tool use: could not tell (timeout)",
      ),
    );
  });
  it("shows one quiet line when the quota check was skipped, and no error", async () => {
    const note =
      "Quota check skipped: this profile lacks servicequotas:ListServiceQuotas";
    const { user, onModelsLoaded } = setup({
      "bedrock/listModels": async (data: any) =>
        data.endpoint === "mantle"
          ? { ok: true, models: [] }
          : {
              ok: true,
              models,
              quota: {
                status: "skipped",
                note,
                docsUrl:
                  "https://b1tninja.github.io/continuous/customize/model-providers/top-level/bedrock#optional-quota-check",
              },
            },
    });
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText(/2 models available/)).toBeTruthy();
    expect(screen.getByTestId("quota-check-note").textContent).toContain(note);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onModelsLoaded.mock.calls.at(-1)![0]).toHaveLength(2);
  });

  it("warns about a 0 quota for the selected model, with the console link", async () => {
    const url =
      "https://console.aws.amazon.com/servicequotas/home/services/bedrock/quotas?region=us-east-1";
    const { user } = setup({
      "bedrock/listModels": async (data: any) =>
        data.endpoint === "mantle"
          ? { ok: true, models: [] }
          : {
              ok: true,
              models: [
                ...models,
                {
                  id: "anthropic.claude-sonnet-4-6",
                  name: "Claude Sonnet 4.6",
                  provider: "Anthropic",
                  kind: "on-demand" as const,
                  quotaWarning: `anthropic.claude-sonnet-4-6 has a 0 tokens-per-minute quota in us-east-1 for this account; request an increase in Service Quotas: ${url}`,
                },
              ],
              quota: { status: "ok", zeroQuotaModels: 1 },
            },
    });
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect((await screen.findByTestId("quota-warning")).textContent).toBe(
      "anthropic.claude-sonnet-4-6 has a 0 tokens-per-minute quota in us-east-1 for this account; request an increase in Service Quotas",
    );
    expect(
      screen.getByRole("button", { name: "Open Service Quotas" }),
    ).toBeTruthy();
    expect(screen.queryByTestId("quota-check-note")).toBeNull();
  });
});
