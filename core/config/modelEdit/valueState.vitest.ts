import { describe, expect, it } from "vitest";
import {
  fieldFor,
  MODEL_EDIT_FIELDS,
  notSetSentence,
  notSetText,
  pathKey,
  type ModelFacts,
  type NotSetContext,
} from "./modelEditFields";
import {
  pickLayers,
  priceSummary,
  resolvedCapability,
  resolvedValue,
  resolveModelEntry,
  type ModelLayers,
} from "./valueState";

const f = (key: string) => fieldFor(key.split("."))!;

const account = {
  name: "work",
  provider: "anthropic",
  apiKey: "${{ secrets.WORK_KEY }}",
  requestOptions: { timeout: 300, headers: { "x-team": "tools" } },
};

const catalogModel = {
  name: "Claude Sonnet",
  connection: "work",
  model: "claude-sonnet-4-6",
  contextLength: 200_000,
  defaultCompletionOptions: { temperature: 0.6, maxTokens: 32_000 },
  variants: {
    plan: {
      defaultCompletionOptions: {
        reasoning: true,
        reasoningBudgetTokens: 8000,
      },
    },
  },
};

/** All four layers: account, catalog model, variant, config entry. */
const fourLayers: ModelLayers = {
  entry: { from: "Claude Sonnet#plan", roles: ["chat", "edit"] },
  entryFile: "C:\\Users\\me\\.continuous\\config.yaml",
  catalogModel,
  account,
  accountFile: "file:///c%3A/Users/me/.continuous/providers.yaml",
};

const cloud: NotSetContext = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  local: false,
};

const plain = (entry: Record<string, unknown>): ModelLayers => ({
  entry: { name: "m", provider: "openai", model: "some-model", ...entry },
  entryFile: "config.yaml",
});

const withFacts = (facts: ModelFacts, local = false): NotSetContext => ({
  provider: "openai",
  model: "some-model",
  local,
  facts,
});

describe("resolveModelEntry", () => {
  it("builds the model the way the loader does, layer over layer", () => {
    expect(resolveModelEntry(fourLayers)).toMatchObject({
      name: "Claude Sonnet#plan",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: "${{ secrets.WORK_KEY }}",
      contextLength: 200_000,
      roles: ["chat", "edit"],
      defaultCompletionOptions: {
        temperature: 0.6,
        maxTokens: 32_000,
        reasoning: true,
        reasoningBudgetTokens: 8000,
      },
      requestOptions: { timeout: 300 },
    });
  });
});

describe("resolvedValue names the layer a value comes from", () => {
  it("a role set by the person: set by you, in the config file", () => {
    const r = resolvedValue(f("roles"), fourLayers, cloud);
    expect(r).toMatchObject({
      value: ["chat", "edit"],
      sourceKind: "user",
      source: "set by you",
      sourceDetail: "config.yaml",
      setByUser: true,
      whereSet: { layer: "entry" },
      sentence: "Set by you: chat, edit",
    });
  });

  it("a temperature from the catalog model", () => {
    const r = resolvedValue(
      f("defaultCompletionOptions.temperature"),
      fourLayers,
      cloud,
    );
    expect(r).toMatchObject({
      value: 0.6,
      sourceKind: "catalog",
      source: "catalog model",
      sourceDetail: "Claude Sonnet",
      setByUser: false,
      sentence: "Not set: 0.6 from the catalog model",
    });
  });

  it("a reasoning budget from the variant", () => {
    const r = resolvedValue(
      f("defaultCompletionOptions.reasoningBudgetTokens"),
      fourLayers,
      cloud,
    );
    expect(r).toMatchObject({
      value: 8000,
      sourceKind: "variant",
      source: "variant plan",
      setByUser: false,
      whereSet: { layer: "variant", name: "plan" },
      sentence: "Not set: 8,000 from the variant plan",
    });
  });

  it("a request timeout inherited from the account, with the file to open", () => {
    const r = resolvedValue(f("requestOptions.timeout"), fourLayers, cloud);
    expect(r).toMatchObject({
      value: 300,
      sourceKind: "account",
      source: "account work",
      sourceDetail: "providers.yaml",
      setByUser: false,
      whereSet: {
        layer: "account",
        name: "work",
        file: "file:///c%3A/Users/me/.continuous/providers.yaml",
      },
      sentence: "Not set: 300 from the account work",
    });
  });

  it("a credential from the account is named and never shown", () => {
    const r = resolvedValue(f("apiKey"), fourLayers, cloud);
    expect(r.source).toBe("account work");
    expect(r.sentence).not.toContain("WORK_KEY");
  });

  it("a temperature written in an account is not inherited: an account carries connection settings only", () => {
    // connect() in packages/config-yaml/src/load/connections.ts takes the
    // provider, key, address, env and request options of an account
    const layers: ModelLayers = {
      entry: { name: "m", connection: "work", model: "claude-sonnet-4-6" },
      account: {
        ...account,
        defaultCompletionOptions: { temperature: 0.6 },
      },
    };
    const r = resolvedValue(
      f("defaultCompletionOptions.temperature"),
      layers,
      cloud,
    );
    expect(r).toMatchObject({
      sourceKind: "notSet",
      source: "not set",
      setByUser: false,
      sentence: "Not set: not sent, the provider decides",
    });
    expect(r.value).toBeUndefined();
  });

  it("a field with nothing set anywhere", () => {
    const r = resolvedValue(
      f("defaultCompletionOptions.topP"),
      fourLayers,
      cloud,
    );
    expect(r).toEqual({
      sourceKind: "notSet",
      source: "not set",
      setByUser: false,
      detail: "not sent, the provider decides",
      sentence: "Not set: not sent, the provider decides",
    });
  });

  it("the entry wins over the layers under it", () => {
    const layers: ModelLayers = {
      ...fourLayers,
      entry: {
        ...fourLayers.entry,
        defaultCompletionOptions: { temperature: 0.2 },
        requestOptions: { timeout: 60 },
      },
    };
    expect(
      resolvedValue(f("defaultCompletionOptions.temperature"), layers, cloud),
    ).toMatchObject({
      value: 0.2,
      setByUser: true,
      sentence: "Set by you: 0.2",
    });
    expect(
      resolvedValue(f("requestOptions.timeout"), layers, cloud),
    ).toMatchObject({ value: 60, setByUser: true });
    // A key next to it still comes from the catalog model
    expect(
      resolvedValue(f("defaultCompletionOptions.maxTokens"), layers, cloud),
    ).toMatchObject({ value: 32_000, sourceKind: "catalog" });
  });

  it("the same value in the entry and under it is the person's", () => {
    const layers: ModelLayers = {
      ...fourLayers,
      entry: { ...fourLayers.entry, contextLength: 200_000 },
    };
    expect(resolvedValue(f("contextLength"), layers, cloud)).toMatchObject({
      setByUser: true,
      sentence: "Set by you: 200,000",
    });
  });

  it("an entry the loader would skip still shows what it says", () => {
    const layers: ModelLayers = {
      entry: { name: "m", connection: "gone", model: "x", contextLength: 8192 },
    };
    expect(resolveModelEntry(layers)).toBeUndefined();
    expect(resolvedValue(f("contextLength"), layers, cloud)).toMatchObject({
      value: 8192,
      setByUser: true,
    });
  });
});

describe("context length in each of its sources", () => {
  const field = f("contextLength");

  it("set by the person", () => {
    expect(
      resolvedValue(field, plain({ contextLength: 65_536 }), withFacts({})),
    ).toMatchObject({
      sourceKind: "user",
      sentence: "Set by you: 65,536",
    });
  });

  it("set next to maxTokens, which the loader also reads", () => {
    expect(
      resolvedValue(
        field,
        plain({ defaultCompletionOptions: { contextLength: 16_384 } }),
        withFacts({}),
      ),
    ).toMatchObject({ value: 16_384, setByUser: true });
  });

  it("from the catalog model", () => {
    expect(resolvedValue(field, fourLayers, cloud)).toMatchObject({
      value: 200_000,
      source: "catalog model",
      sentence: "Not set: 200,000 from the catalog model",
    });
  });

  it("reported by a local server", () => {
    expect(
      resolvedValue(
        field,
        plain({}),
        withFacts(
          { contextLength: 8192, contextLengthSource: "provider" },
          true,
        ),
      ),
    ).toMatchObject({
      value: 8192,
      sourceKind: "server",
      source: "from the server",
      sentence: "Not set: 8,192 from the server",
    });
  });

  it("reported by a cloud provider", () => {
    expect(
      resolvedValue(
        field,
        plain({}),
        withFacts({
          contextLength: 1_000_000,
          contextLengthSource: "provider",
        }),
      ),
    ).toMatchObject({
      sourceKind: "provider",
      source: "from the provider",
      sentence: "Not set: 1,000,000 from the provider",
    });
  });

  it("published", () => {
    expect(
      resolvedValue(
        field,
        plain({}),
        withFacts({ contextLength: 200_000, contextLengthSource: "published" }),
      ),
    ).toMatchObject({
      value: 200_000,
      sourceKind: "published",
      source: "published",
      sentence: "Not set: 200,000 published",
    });
  });

  it("not known: 32,768 assumed", () => {
    expect(
      resolvedValue(
        field,
        plain({}),
        withFacts(
          { contextLength: 32_768, contextLengthSource: "unknown" },
          true,
        ),
      ),
    ).toMatchObject({
      value: 32_768,
      sourceKind: "assumed",
      source: "assumed",
      sentence: "Not set: 32,768 assumed. Set the real size, or ask the server",
    });
  });
});

describe("max output tokens", () => {
  const field = f("defaultCompletionOptions.maxTokens");
  const at = (facts: ModelFacts, local = false) =>
    resolvedValue(field, plain({}), withFacts(facts, local));

  it("a local server that decides for itself", () => {
    const r = at({ maxTokensSource: "none" }, true);
    expect(r.sentence).toBe("Not set: the server decides");
    expect(r.value).toBeUndefined();
  });

  it("the provider's cap, with the number", () => {
    expect(
      at({ maxTokens: 32_000, maxTokensSource: "provider" }),
    ).toMatchObject({
      value: 32_000,
      source: "from the provider",
      sentence: "Not set: 32,000 from the provider",
    });
  });

  it("the published cap", () => {
    expect(
      at({ maxTokens: 16_384, maxTokensSource: "published" }),
    ).toMatchObject({
      sourceKind: "published",
      sentence:
        "Not set: 16,384, the published limit, at most a quarter of the window",
    });
  });

  it("the 4,096 fallback", () => {
    expect(at({ maxTokens: 4096, maxTokensSource: "fallback" }).sentence).toBe(
      "Not set: 4,096, used when no limit is known for the model",
    );
  });

  it("a provider's built-in limit, which the loader fills in", () => {
    const r = resolvedValue(field, plain({ provider: "anthropic" }), {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      facts: { maxTokens: 8192, maxTokensSource: "config" },
    });
    expect(r).toMatchObject({
      value: 8192,
      sourceKind: "notSet",
      setByUser: false,
      sentence: "Not set: 8,192, the built-in limit for anthropic",
    });
  });

  it("the person's value", () => {
    expect(
      resolvedValue(
        field,
        plain({ defaultCompletionOptions: { maxTokens: 900 } }),
        withFacts({ maxTokens: 900, maxTokensSource: "config" }),
      ),
    ).toMatchObject({ setByUser: true, sentence: "Set by you: 900" });
  });
});

describe("capabilities and price", () => {
  it("tools detected for the model", () => {
    expect(
      resolvedCapability(
        "tool_use",
        plain({}),
        withFacts({ nativeTools: true }),
      ),
    ).toMatchObject({
      value: true,
      source: "detected",
      sentence: "Not set: yes, detected for the model",
    });
  });

  it("tools and images set by the person", () => {
    const layers = plain({ capabilities: ["tool_use"] });
    const c = withFacts({ nativeTools: false, images: true });
    expect(resolvedCapability("tool_use", layers, c)).toMatchObject({
      value: true,
      setByUser: true,
      sentence: "Set by you: yes",
    });
    expect(resolvedCapability("image_input", layers, c)).toMatchObject({
      value: false,
      setByUser: true,
      sentence: "Set by you: no",
    });
  });

  it("capabilities from the catalog model", () => {
    const layers: ModelLayers = {
      ...fourLayers,
      catalogModel: { ...catalogModel, capabilities: ["tool_use"] },
    };
    expect(resolvedCapability("tool_use", layers, cloud)).toMatchObject({
      source: "catalog model",
      setByUser: false,
    });
  });

  it("a price from the table, and no price at all", () => {
    const priced = withFacts({ tablePrice: { input: 3, output: 15 } });
    const input = resolvedValue(f("pricing.input"), plain({}), priced);
    const output = resolvedValue(f("pricing.output"), plain({}), priced);
    expect(input).toMatchObject({
      value: 3,
      source: "price table",
      sentence: "Not set: $3.00 from the price table",
    });
    expect(priceSummary(input, output)).toEqual({
      text: "$3.00 / $15.00",
      known: true,
    });

    const none = withFacts({ tablePrice: "unknown" });
    const a = resolvedValue(f("pricing.input"), plain({}), none);
    const b = resolvedValue(f("pricing.output"), plain({}), none);
    expect(a.sentence).toBe("Not set: no price known: cost is not estimated");
    expect(priceSummary(a, b)).toEqual({
      text: "no price known: cost is not estimated",
      known: false,
    });
    expect(priceSummary(a, b).text).not.toContain("$0");
  });
});

describe("pickLayers", () => {
  it("finds the catalog model and the account the loader connects through", () => {
    const picked = pickLayers(
      { from: "Claude Sonnet#plan" },
      [{ name: "Other", provider: "openai", model: "x" }, catalogModel],
      [{ name: "home", provider: "ollama" }, account],
    );
    expect(picked.catalogModel?.name).toBe("Claude Sonnet");
    expect(picked.account?.name).toBe("work");
  });

  it("uses the first route of a model with no account of its own", () => {
    const routed = {
      name: "Routed",
      model: "claude-sonnet-4-6",
      routes: [{ connection: "work" }, { connection: "home" }],
    };
    expect(
      pickLayers({ from: "Routed" }, [routed], [account]).account?.name,
    ).toBe("work");
  });

  it("has nothing for a model written with its own provider", () => {
    expect(
      pickLayers({ name: "m", provider: "openai", model: "x" }, [], [account]),
    ).toEqual({});
  });
});

describe("the sentence for a key that is not set", () => {
  const caches: NonNullable<ModelFacts["cache"]>[] = [
    { control: false, defaultsOn: false, fixedLifetime: false },
    { control: true, defaultsOn: false, fixedLifetime: false },
    { control: true, defaultsOn: true, fixedLifetime: false },
    { control: true, defaultsOn: true, fixedLifetime: true },
  ];
  const contexts: NotSetContext[] = [
    { provider: "", model: "" },
    ...[
      "anthropic",
      "openai",
      "bedrock",
      "bedrock-mantle",
      "sagemaker",
      "vertexai",
      "azure",
      "watsonx",
      "ollama",
      "asksage",
      "lmstudio",
    ].flatMap((provider) => [
      { provider, model: "m" },
      { provider, model: "m", local: true, facts: {} },
      ...caches.map((cache) => ({
        provider,
        model: "m",
        local: false,
        facts: {
          cache,
          reasoningDetected: cache.control,
          maxTokens: 4096,
          maxTokensSource: "fallback" as const,
          contextLength: 32_768,
          contextLengthSource: "unknown" as const,
          tablePrice: "unknown" as const,
        },
      })),
    ]),
  ];

  it("exists for every model field, and is never empty or the bare word Default", () => {
    for (const field of MODEL_EDIT_FIELDS) {
      expect(["a", "b"], pathKey(field.path)).toContain(field.unset);
      for (const c of contexts) {
        const text = notSetText(field, c);
        const where = `${pathKey(field.path)} for ${c.provider || "no provider"}`;
        expect(text.trim().length, where).toBeGreaterThan(1);
        expect(text.trim(), where).not.toMatch(/^default\b/i);
        expect(notSetSentence(field, c), where).toBe(`Not set: ${text}`);
      }
    }
  });

  it("gives the values the code uses", () => {
    const of = (key: string, c: NotSetContext = cloud) =>
      notSetSentence(f(key), c);
    expect(of("requestOptions.timeout")).toBe("Not set: 7,200 s");
    expect(of("requestOptions.connectTimeout")).toBe("Not set: 10 s");
    expect(of("roles")).toBe("Not set: chat, edit, apply, summarize");
    expect(of("defaultCompletionOptions.reasoningBudgetTokens")).toBe(
      "Not set: 2,048 tokens when reasoning is on",
    );
    expect(of("env.region", { provider: "bedrock", model: "m" })).toBe(
      "Not set: us-east-1",
    );
    expect(of("env.region", { provider: "sagemaker", model: "m" })).toBe(
      "Not set: us-west-2",
    );
    expect(of("env.apiVersion", { provider: "azure", model: "m" })).toBe(
      "Not set: 2024-02-15-preview",
    );
    expect(of("cacheBehavior.subagentTtl")).toBe("Not set: 5m");
  });

  it("says what a local or a cloud model does for the same key", () => {
    const planned = f("contextManagement.plannedCompaction");
    expect(
      notSetText(planned, { provider: "ollama", model: "m", local: true }),
    ).toMatch(/^on,/);
    expect(notSetText(planned, cloud)).toMatch(/^off,/);
  });

  it("states the resolved cache behaviour for the provider", () => {
    const caching = f("defaultCompletionOptions.promptCaching");
    const at = (cache: NonNullable<ModelFacts["cache"]>) =>
      notSetText(caching, { ...cloud, facts: { cache } });
    expect(at(caches[0])).toMatch(/^no cache setting is sent/);
    expect(at(caches[1])).toMatch(/^off/);
    expect(at(caches[2])).toContain("5 minutes, then 1 hour");
    expect(at(caches[3])).toContain("5 minute lifetime");
  });
});
