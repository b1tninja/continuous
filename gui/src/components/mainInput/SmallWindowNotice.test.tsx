import { act, fireEvent, screen } from "@testing-library/react";
import type { Tool } from "core";
import {
  getBaseToolDefinitions,
  getConfigDependentToolDefinitions,
} from "core/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { EMPTY_CONFIG, updateConfig } from "../../redux/slices/configSlice";
import {
  newSession,
  setMode,
  streamUpdate,
} from "../../redux/slices/sessionSlice";
import { setupStore } from "../../redux/store";
import * as chatRequest from "../../redux/util/buildChatRequest";
import { renderWithProviders } from "../../util/test/render";
import {
  resetSmallWindowNoticeForTests,
  SmallWindowNotice,
} from "./SmallWindowNotice";

const ide = { getIdeInfo: async () => ({ ideType: "vscode" }) } as any;

/** The built-in tool list, as the config loader builds it. */
async function builtInTools(): Promise<Tool[]> {
  return [
    ...getBaseToolDefinitions(),
    ...(await getConfigDependentToolDefinitions({
      rules: [],
      enableExperimentalTools: false,
      isRemote: false,
      modelName: "llama3.1:8b",
      ide,
    })),
  ];
}

const ollama = (contextLength: number, extra = {}) => ({
  title: "Llama 3.1 8B",
  provider: "ollama",
  underlyingProviderName: "ollama",
  model: "llama3.1:8b",
  contextLength,
  contextLengthSource: "config",
  completionOptions: { maxTokens: 2_048 },
  ...extra,
});

async function setup(
  model: ReturnType<typeof ollama>,
  mode: "chat" | "agent" | "plan" = "agent",
) {
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  const tools = await builtInTools();
  const config = (chat: ReturnType<typeof ollama>, extra = {}) =>
    ({
      ...EMPTY_CONFIG,
      tools,
      selectedModelByRole: { ...EMPTY_CONFIG.selectedModelByRole, chat },
      modelsByRole: { ...EMPTY_CONFIG.modelsByRole, chat: [chat] },
      ...extra,
    }) as any;
  await renderWithProviders(<SmallWindowNotice />, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  await act(async () => {
    store.dispatch(updateConfig(config(model)));
    store.dispatch(
      newSession({
        sessionId: "small-window",
        title: "Test",
        workspaceDirectory: "",
        history: [],
      } as any),
    );
    store.dispatch(setMode(mode));
  });
  return { store, ideMessenger, config };
}

const line = () => screen.queryByTestId("small-window-notice");
/** The numbers of the line, in order. */
const numbers = () =>
  [...line()!.textContent!.matchAll(/\d[\d,]*/g)].map((m) =>
    Number(m[0].replaceAll(",", "")),
  );

describe("SmallWindowNotice", () => {
  beforeEach(() => resetSmallWindowNoticeForTests());

  it("gives the numbers for an 8,192 window in Agent mode", async () => {
    const st = await setup(ollama(8_192));
    const text = line()!.textContent!;
    expect(text).toMatch(
      /^Tools and instructions take about [\d,]+ of this model's 8,192 tokens\. With 2,048 kept for the reply, (about [\d,]+ are|nothing is) left for the conversation\./,
    );
    const [setupTokens, window, reply] = numbers();
    expect(window).toBe(8_192);
    expect(reply).toBe(2_048);
    // More than half of 8,192 - 2,048; the built-in tools alone are about
    // 2,700 (plans/tool-overhead.md)
    expect(setupTokens).toBeGreaterThan(3_072);
    expect(setupTokens).toBeLessThan(8_192);
  });

  it("says nothing at 32,768 with the same tools", async () => {
    await setup(ollama(32_768));
    expect(line()).toBeNull();
  });

  it("says nothing while the window is not known", async () => {
    await setup(ollama(8_192, { contextLengthSource: "unknown" }));
    expect(line()).toBeNull();
  });

  it("shows once the window is known, as when the server reports it", async () => {
    const { store, config } = await setup(
      ollama(32_768, { contextLengthSource: "unknown" }),
    );
    expect(line()).toBeNull();
    await act(async () => {
      store.dispatch(
        updateConfig(
          config(ollama(4_096, { contextLengthSource: "provider" })),
        ),
      );
    });
    expect(line()!.textContent).toContain("of this model's 4,096 tokens");
  });

  it("switches to Chat mode, where no tools are sent", async () => {
    const { store } = await setup(ollama(8_192));
    await act(async () => {
      fireEvent.click(screen.getByTestId("small-window-chat-mode"));
    });
    expect(store.getState().session.mode).toBe("chat");
    // Chat's system message alone is well under half
    expect(line()).toBeNull();
  });

  it("writes the short prompt for the mode, and stops offering it once set", async () => {
    const { store, ideMessenger, config } = await setup(ollama(8_192));
    const request = vi.spyOn(ideMessenger, "request");
    ideMessenger.responses["config/setModeModels"] = { saved: true };
    await act(async () => {
      fireEvent.click(screen.getByTestId("small-window-short-prompt"));
    });
    expect(request).toHaveBeenCalledWith("config/setModeModels", {
      agent: { prompt: "short" },
    });

    const [before] = numbers();
    await act(async () => {
      store.dispatch(
        updateConfig(
          config(ollama(8_192), { modeModels: { agent: { prompt: "short" } } }),
        ),
      );
    });
    expect(screen.queryByTestId("small-window-short-prompt")).toBeNull();
    expect(numbers()[0]).toBeLessThan(before);
  });

  it("says how to set the short prompt by hand when the config cannot be edited", async () => {
    const { ideMessenger } = await setup(ollama(8_192));
    ideMessenger.responses["config/setModeModels"] = { saved: false };
    await act(async () => {
      fireEvent.click(screen.getByTestId("small-window-short-prompt"));
    });
    expect(line()!.textContent).toContain(
      "Add `prompt: short` under modeModels.agent in config.yaml.",
    );
    expect(screen.queryByTestId("small-window-short-prompt")).toBeNull();
  });

  it("does not offer the short prompt to a model that already gets it", async () => {
    await setup(ollama(8_192, { model: "qwen3:8b" }));
    expect(line()).not.toBeNull();
    expect(screen.queryByTestId("small-window-short-prompt")).toBeNull();
    expect(screen.getByTestId("small-window-chat-mode")).toBeTruthy();
  });

  it("stays dismissed for the session", async () => {
    const { store } = await setup(ollama(8_192));
    await act(async () => {
      fireEvent.click(screen.getByTestId("small-window-notice-dismiss"));
    });
    expect(line()).toBeNull();
    await act(async () => {
      store.dispatch(setMode("plan"));
    });
    expect(line()).toBeNull();
  });

  it("is not sized again while a reply streams", async () => {
    const { store } = await setup(ollama(8_192));
    const sized = vi.spyOn(chatRequest, "buildChatRequest");
    await act(async () => {
      store.dispatch(
        streamUpdate([{ role: "assistant", content: "A streamed batch" }]),
      );
    });
    await act(async () => {
      store.dispatch(streamUpdate([{ role: "assistant", content: " more" }]));
    });
    expect(sized).not.toHaveBeenCalled();
    expect(line()).not.toBeNull();
    // A mode switch changes the tools and the system message
    await act(async () => {
      store.dispatch(setMode("plan"));
    });
    expect(sized).toHaveBeenCalledTimes(1);
    sized.mockRestore();
  });
});
