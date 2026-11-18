import { describe, expect, it } from "vitest";
import { CacheMissNotice } from "./CacheMissNotice";
import { EMPTY_CONFIG, updateConfig } from "../../redux/slices/configSlice";
import { setActive } from "../../redux/slices/sessionSlice";
import {
  act,
  screen,
  setPromptCacheState,
  setupNotice,
} from "./noticeTestUtils";

const miss = { readTokens: 0, expectedTokens: 112_000, causes: [] as string[] };
const setup = () => setupNotice(<CacheMissNotice />);

describe("CacheMissNotice", () => {
  it("waits for repeated misses", async () => {
    const { store } = await setup();
    await act(async () => {
      store.dispatch(
        setPromptCacheState({ escalated: false, misses: 2, lastMiss: miss }),
      );
    });
    expect(screen.queryByTestId("cache-miss-notice")).toBeNull();
  });

  it("appears after three and names the sizes", async () => {
    const { store } = await setup();
    await act(async () => {
      store.dispatch(
        setPromptCacheState({ escalated: false, misses: 3, lastMiss: miss }),
      );
    });
    const text = screen.getByTestId("cache-miss-notice").textContent!;
    expect(text).toContain("missed 3 times");
    expect(text).toContain("0 of 112k");
    expect(text).toContain("Nothing the app controls changed");
  });

  it("names what changed when it knows", async () => {
    const { store } = await setup();
    await act(async () => {
      store.dispatch(
        setPromptCacheState({
          escalated: false,
          misses: 3,
          lastMiss: { ...miss, causes: ["the tools changed"] },
        }),
      );
    });
    const text = screen.getByTestId("cache-miss-notice").textContent!;
    expect(text).toContain("Likely cause: the tools changed.");
    expect(text).not.toContain("Nothing the app controls changed");
    // Not a drop: nothing to compact for
    expect(text).not.toContain("no longer fits");
    expect(screen.queryByTestId("cache-miss-compact-now")).toBeNull();
  });

  it("names request settings instead of blaming the provider", async () => {
    const { store } = await setup();
    await act(async () => {
      store.dispatch(
        setPromptCacheState({
          escalated: false,
          misses: 3,
          lastMiss: {
            ...miss,
            causes: [
              "the reasoning effort or thinking settings changed",
              "the tool choice changed",
              "an image was added",
            ],
          },
        }),
      );
    });
    const text = screen.getByTestId("cache-miss-notice").textContent!;
    expect(text).toContain(
      "Likely cause: the reasoning effort or thinking settings changed; the tool choice changed; an image was added.",
    );
    expect(text).not.toContain("may not be caching");
  });

  it("lists several causes", async () => {
    const { store } = await setup();
    await act(async () => {
      store.dispatch(
        setPromptCacheState({
          escalated: false,
          misses: 3,
          lastMiss: {
            ...miss,
            causes: [
              "the tools changed",
              "the oldest messages were dropped to fit",
            ],
          },
        }),
      );
    });
    expect(screen.getByTestId("cache-miss-notice").textContent).toContain(
      "the tools changed; the oldest messages were dropped to fit.",
    );
  });

  it("goes away when dismissed and returns only after three more", async () => {
    const { store, user } = await setup();
    await act(async () => {
      store.dispatch(
        setPromptCacheState({ escalated: false, misses: 3, lastMiss: miss }),
      );
    });
    await user.click(screen.getByTestId("cache-miss-notice-dismiss"));
    expect(screen.queryByTestId("cache-miss-notice")).toBeNull();

    const withMisses = (misses: number) =>
      setPromptCacheState({
        ...store.getState().session.promptCache!,
        misses,
      });
    await act(async () => {
      store.dispatch(withMisses(5));
    });
    expect(screen.queryByTestId("cache-miss-notice")).toBeNull();
    await act(async () => {
      store.dispatch(withMisses(6));
    });
    expect(screen.getByTestId("cache-miss-notice")).toBeInTheDocument();
  });
});

describe("CacheMissNotice on a local server", () => {
  const strata = {
    title: "Strata",
    provider: "openai",
    model: "qwen3.8-flash-next-nvfp4-nvfp4",
    apiBase: "http://127.0.0.1:8083/v1/",
    underlyingProviderName: "openai",
  };

  async function setupLocal(misses: number, causes: string[] = []) {
    const { store } = await setup();
    await act(async () => {
      store.dispatch(
        updateConfig({
          ...EMPTY_CONFIG,
          selectedModelByRole: {
            ...EMPTY_CONFIG.selectedModelByRole,
            chat: strata,
          },
          modelsByRole: { ...EMPTY_CONFIG.modelsByRole, chat: [strata] },
        } as any),
      );
      store.dispatch(
        setPromptCacheState({
          escalated: false,
          misses,
          lastMiss: { ...miss, causes },
        }),
      );
    });
  }

  it("appears after one miss, since each one costs minutes", async () => {
    await setupLocal(1);
    const text = screen.getByTestId("cache-miss-notice").textContent!;
    expect(text).toContain("missed once");
    // Nothing changed on this side: the usual local reasons
    expect(text).toContain("unloaded the model");
    expect(text).toContain("another conversation");
  });

  it("still names what changed when it knows", async () => {
    await setupLocal(1, ["the system prompt changed"]);
    const text = screen.getByTestId("cache-miss-notice").textContent!;
    expect(text).toContain("Likely cause: the system prompt changed.");
  });

  it("names a drop between tool rounds and offers Compact now (C117)", async () => {
    await setupLocal(1, [
      "message 2 changed: an answer",
      "the oldest messages were dropped to fit",
    ]);
    const text = screen.getByTestId("cache-miss-notice").textContent!;
    expect(text).toContain(
      "Likely cause: message 2 changed: an answer; the oldest messages were dropped to fit.",
    );
    // Without the flag: the general wording, no mention of the agent
    expect(text).toContain("no longer fits the context window");
    expect(text).not.toContain("tool rounds");
    expect(screen.getByTestId("cache-miss-compact-now")).toBeInTheDocument();
    // Planned compaction is on by default for a local server: not suggested
    expect(text).not.toContain("contextManagement.plannedCompaction");
  });
});

describe("CacheMissNotice after a drop in an agent loop (C117)", () => {
  const strata = {
    title: "Strata",
    provider: "openai",
    model: "qwen3.8-flash-next-nvfp4-nvfp4",
    apiBase: "http://127.0.0.1:8083/v1/",
    underlyingProviderName: "openai",
  };
  const causes = [
    "message 2 changed: an answer",
    "the oldest messages were dropped to fit",
  ];

  async function setupLoop(model: Record<string, unknown>, streaming = false) {
    const { store } = await setup();
    await act(async () => {
      store.dispatch(
        updateConfig({
          ...EMPTY_CONFIG,
          selectedModelByRole: {
            ...EMPTY_CONFIG.selectedModelByRole,
            chat: model,
          },
          modelsByRole: { ...EMPTY_CONFIG.modelsByRole, chat: [model] },
        } as any),
      );
      store.dispatch(
        setPromptCacheState({
          escalated: false,
          misses: 8,
          lastMiss: {
            readTokens: 16_384,
            expectedTokens: 327_000,
            causes,
            inToolRound: true,
          },
        }),
      );
      if (streaming) store.dispatch(setActive());
    });
    return store;
  }

  it("says the drop came between tool rounds and points to Compact now", async () => {
    await setupLoop(strata);
    const text = screen.getByTestId("cache-miss-notice").textContent!;
    expect(text).toContain("missed 8 times");
    expect(text).toContain("16k of 327k");
    expect(text).toContain(
      "the oldest messages were dropped between two of the agent's tool rounds, where nobody is asked first",
    );
    expect(text).toContain("Compact now summarises the conversation once");
    expect(screen.getByTestId("cache-miss-compact-now")).toBeInTheDocument();
  });

  it("suggests planned compaction when it is off", async () => {
    await setupLoop({
      ...strata,
      contextManagement: { plannedCompaction: false },
    });
    expect(screen.getByTestId("cache-miss-notice").textContent).toContain(
      "With planned compaction on (contextManagement.plannedCompaction), the agent compacts at the limit by itself.",
    );
  });

  it("does not offer Compact now while the agent is still running", async () => {
    await setupLoop(strata, true);
    expect(screen.getByTestId("cache-miss-notice")).toBeInTheDocument();
    expect(screen.queryByTestId("cache-miss-compact-now")).toBeNull();
  });
});
