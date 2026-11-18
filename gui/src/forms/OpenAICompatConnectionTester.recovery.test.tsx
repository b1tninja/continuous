import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { IdeMessengerContext } from "../context/IdeMessenger";
import { MockIdeMessenger } from "../context/MockIdeMessenger";
import { OpenAICompatConnectionTester } from "./OpenAICompatConnectionTester";

const textProbe = {
  ok: true,
  models: ["qwen3-coder"],
  probe: {
    ok: true,
    kind: "text",
    label: "Tool calls: written as text (qwen-xml)",
    recoveryDialect: "qwen-xml",
    recorded: { n: 1 },
  },
};

function setup(
  props: Partial<Parameters<typeof OpenAICompatConnectionTester>[0]>,
  setDialect: (data: any) => any = async () => ({ saved: true }),
  probe: any = textProbe,
) {
  const messenger = new MockIdeMessenger();
  const test = vi.fn(async (data: any) =>
    data.model ? probe : { ok: true, models: ["qwen3-coder"] },
  );
  const set = vi.fn(setDialect);
  messenger.responseHandlers["openaiCompat/testConnection"] = test;
  messenger.responseHandlers["config/setToolDialect"] = set;
  const user = userEvent.setup();
  render(
    <IdeMessengerContext.Provider value={messenger}>
      <OpenAICompatConnectionTester
        provider="lmstudio"
        apiBase="http://127.0.0.1:1234/v1"
        model="qwen3-coder"
        modelTitle="Qwen3 Coder"
        canTest
        {...props}
      />
    </IdeMessengerContext.Provider>,
  );
  return { user, set };
}

async function runTest(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Test connection" }));
  await screen.findByTestId("tool-calls-result");
}

describe("Turn on recovery", () => {
  it("asks the IDE to confirm, then sets the dialect on the saved model", async () => {
    const { user, set } = setup({});
    await runTest(user);
    expect(screen.getByTestId("tool-calls-recorded")).toBeTruthy();
    await user.click(screen.getByTestId("turn-on-recovery"));
    await screen.findByTestId("recovery-on");
    const sent = set.mock.calls[0][0];
    expect(sent).toMatchObject({
      title: "Qwen3 Coder",
      toolDialect: "qwen-xml",
    });
    expect(sent.confirm).toContain("toolDialect: qwen-xml");
    expect(screen.queryByTestId("turn-on-recovery")).toBeNull();
  });

  it("changes nothing when the confirmation is declined", async () => {
    const { user } = setup({}, async () => ({ saved: false, declined: true }));
    await runTest(user);
    await user.click(screen.getByTestId("turn-on-recovery"));
    await screen.findByText("Not changed.");
    expect(screen.queryByTestId("recovery-on")).toBeNull();
  });

  it("falls back to a copyable snippet when the model is not in config.yaml", async () => {
    const { user } = setup({}, async () => ({ saved: false }));
    await runTest(user);
    await user.click(screen.getByTestId("turn-on-recovery"));
    const snippet = await screen.findByTestId("recovery-snippet");
    expect(snippet).toHaveTextContent("toolDialect: qwen-xml");
  });

  it("is not offered for a native result, a server that parses, or a path that cannot recover text", async () => {
    const native = {
      ok: true,
      models: ["m"],
      probe: { ok: true, kind: "native", label: "Tool calls: native" },
    };
    const first = setup({}, undefined, native);
    await runTest(first.user);
    expect(screen.queryByTestId("turn-on-recovery")).toBeNull();
  });

  it("is not offered for Ollama in the IDE", async () => {
    const { user } = setup({
      provider: "ollama",
      apiBase: "http://127.0.0.1:11434/v1",
    });
    await runTest(user);
    expect(screen.queryByTestId("turn-on-recovery")).toBeNull();
  });
});

describe("API base before the button", () => {
  it("disables the button and says why for a provider with no default", async () => {
    setup({ provider: "custom-provider", apiBase: "" });
    expect(
      screen.getByRole("button", { name: "Test connection" }),
    ).toBeDisabled();
    expect(screen.getByTestId("test-connection-base-help")).toHaveTextContent(
      "no default address",
    );
  });

  it("enables it once a base is entered", async () => {
    setup({ provider: "custom-provider", apiBase: "http://h:1/v1" });
    expect(
      screen.getByRole("button", { name: "Test connection" }),
    ).toBeEnabled();
    expect(screen.queryByTestId("test-connection-base-help")).toBeNull();
  });

  it("names the default for a known provider with no base", async () => {
    setup({ provider: "openai", apiBase: "" });
    expect(
      screen.getByRole("button", { name: "Test connection" }),
    ).toBeEnabled();
    await waitFor(() =>
      expect(screen.getByTestId("test-connection-base-help")).toHaveTextContent(
        "https://api.openai.com/v1",
      ),
    );
  });
});
