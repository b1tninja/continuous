import { setOpenRouterCatalog } from "core/llm/utils/catalogPricing";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTEXT_UNKNOWN,
  modelFacts,
  PRICE_OWN_SERVER,
  PRICE_UNKNOWN,
  toolsSummary,
} from "./modelFacts";
import {
  defaultUseFor,
  MORE_NOT_SET,
  notSetApiBase,
  plainConnectionFailure,
  requestOptionsFromForm,
  rolesToWrite,
  EMPTY_MORE_OPTIONS,
  useForLine,
} from "./providerSetupUtils";
import { looksLikeAddress, looksLikeCompleteKey } from "./useAutoTest";

const pkg = (model: string, params: Record<string, unknown> = {}) =>
  ({
    title: model,
    description: model,
    params: { model, ...params },
    isOpenSource: false,
  }) as any;

describe("modelFacts", () => {
  afterEach(() => setOpenRouterCatalog(undefined));

  it("gives the window, the list price and tools for a model the tables know", () => {
    const id = "claude-sonnet-4-5";
    const facts = modelFacts(
      { provider: "anthropic" },
      pkg(id, { contextLength: 200000 }),
      id,
    );
    expect(facts.context).toBe("200,000 tokens");
    expect(facts.contextCell).toBe("200,000");
    expect(facts.price).toMatch(/^\$[\d.]+ in \/ \$[\d.]+ out per 1M tokens$/);
    expect(facts.priceCell).toMatch(/^\$[\d.]+ \/ \$[\d.]+$/);
    expect(facts.tools).toBe("yes");
  });

  it("says in words what is not known, never a blank and never $0", () => {
    const facts = modelFacts(
      { provider: "anthropic" },
      undefined,
      "some-model-nobody-lists",
    );
    expect(facts).toMatchObject({
      context: CONTEXT_UNKNOWN,
      contextCell: "not published",
      price: PRICE_UNKNOWN,
      priceCell: "no price known",
      // The name table says no for any name it does not know
      tools: "not reported",
    });
  });

  it("does not put a price on a server the person runs, or OpenAI's on its models", () => {
    const own = modelFacts(
      { provider: "openai", localServer: true, apiBase: "http://10.0.0.5/v1" },
      pkg("gpt-4o"),
      "gpt-4o",
    );
    expect(own.price).toBe(PRICE_OWN_SERVER);
    expect(own.tools).toBe("not reported");
    // The same entry pointed at a public address: unknown, not "not billed"
    expect(
      modelFacts(
        {
          provider: "openai",
          localServer: true,
          apiBase: "https://llm.example.com/v1",
        },
        pkg("x"),
        "x",
      ).price,
    ).toBe(PRICE_UNKNOWN);
  });

  it("takes tools from the server's own listing when it says", () => {
    const target = { provider: "openai", localServer: true };
    expect(
      modelFacts(target, pkg("a", { capabilities: { tools: true } }), "a")
        .tools,
    ).toBe("yes");
    expect(
      modelFacts(target, pkg("a", { capabilities: { tools: false } }), "a")
        .tools,
    ).toBe("no");
  });

  it("dates an OpenRouter price, and reads a listed zero as free", () => {
    setOpenRouterCatalog({
      fetchedAt: "2026-11-01T00:00:00.000Z",
      models: [
        {
          id: "a/priced",
          name: "A",
          pricing: { prompt: 3e-6, completion: 15e-6 },
        },
        { id: "a/free", name: "F", pricing: { prompt: 0, completion: 0 } },
      ],
    } as any);
    const target = { provider: "openrouter" };
    expect(modelFacts(target, pkg("a/priced"), "a/priced").price).toBe(
      "$3 in / $15 out per 1M tokens, prices as of 2026-11-01",
    );
    expect(modelFacts(target, pkg("a/free"), "a/free").price).toBe(
      "free, prices as of 2026-11-01",
    );
    expect(modelFacts(target, pkg("a/none"), "a/none").price).toBe(
      PRICE_UNKNOWN,
    );
  });

  it("sums tools up for the test line", () => {
    expect(toolsSummary(["yes", "yes"])).toBe("yes");
    expect(toolsSummary(["no", "no"])).toBe("no");
    expect(toolsSummary(["yes", "no", "not reported"])).toBe("1 of 3");
    expect(toolsSummary(["not reported"])).toBe("not reported");
    expect(toolsSummary([])).toBe("not reported");
  });
});

describe("Use for", () => {
  it("ticks Autocomplete only when the catalogue recommends every model for it", () => {
    expect([...defaultUseFor("anthropic", ["claude-sonnet-4-5"])]).toEqual([
      "chat",
      "edit",
      "apply",
    ]);
    expect(
      defaultUseFor("mistral", ["codestral-latest"]).has("autocomplete"),
    ).toBe(true);
    expect(
      defaultUseFor("mistral", [
        "codestral-latest",
        "mistral-large-latest",
      ]).has("autocomplete"),
    ).toBe(false);
  });

  it("writes no roles for Chat, Edit and Apply, and the ticks otherwise", () => {
    expect(rolesToWrite(new Set(["chat", "edit", "apply"]))).toBeUndefined();
    expect(
      rolesToWrite(new Set(["chat", "edit", "apply", "autocomplete"])),
    ).toEqual(["chat", "edit", "apply", "autocomplete", "summarize"]);
    expect(rolesToWrite(new Set(["autocomplete"]))).toEqual(["autocomplete"]);
    expect(rolesToWrite(new Set())).toEqual([]);
  });

  it("says what a role uses now and what it will use", () => {
    expect(useForLine(true, "Claude Sonnet", "Qwen 3")).toBe(
      "currently Claude Sonnet → will be Qwen 3",
    );
    expect(useForLine(true, undefined, "Qwen 3")).toBe(
      "nothing chosen yet → will be Qwen 3",
    );
    expect(useForLine(false, "Claude Sonnet", "Qwen 3")).toBe(
      "stays Claude Sonnet",
    );
    expect(useForLine(true, "Qwen 3", "Qwen 3")).toBe("stays Qwen 3");
  });
});

describe("More", () => {
  it("has the values the code uses when a field is not set", () => {
    expect(MORE_NOT_SET).toEqual({
      timeout: "7,200 s",
      connectTimeout: "10 s",
      proxy: "HTTPS_PROXY / HTTP_PROXY from the environment",
      verifySsl: "on",
      useSystemCa: "on for Windows and macOS, off for Linux",
      caBundlePath: "none",
    });
    expect(notSetApiBase("openrouter")).toBe("https://openrouter.ai/api/v1");
    expect(notSetApiBase("anthropic")).toBe("https://api.anthropic.com/v1");
    expect(notSetApiBase("cohere")).toBe(
      "the provider's own address, built into Continuous",
    );
  });

  it("sends only what was set", () => {
    expect(requestOptionsFromForm(EMPTY_MORE_OPTIONS)).toEqual({});
    expect(
      requestOptionsFromForm({
        ...EMPTY_MORE_OPTIONS,
        timeout: "600",
        connectTimeout: "nope",
        verifySsl: "off",
        caBundlePath: " /etc/a.pem \n\n/etc/b.pem",
      }),
    ).toEqual({
      timeout: 600,
      verifySsl: false,
      caBundlePath: ["/etc/a.pem", "/etc/b.pem"],
    });
  });
});

describe("the automatic test's inputs", () => {
  it("takes a key of 20 characters or more with no space as complete", () => {
    expect(looksLikeCompleteKey("sk-ant-api03-abcdefg")).toBe(true);
    expect(looksLikeCompleteKey("sk-ant-api03-abcdef")).toBe(false);
    expect(looksLikeCompleteKey("sk-ant api03-abcdefghijkl")).toBe(false);
    expect(looksLikeCompleteKey(undefined)).toBe(false);
  });

  it("takes an http or https address with a host as complete", () => {
    expect(looksLikeAddress("http://192.168.1.50:8080/v1")).toBe(true);
    expect(looksLikeAddress("https://box.local/v1/")).toBe(true);
    expect(looksLikeAddress("192.168.1.50:8080")).toBe(false);
    expect(looksLikeAddress("http://")).toBe(false);
    expect(looksLikeAddress("")).toBe(false);
  });

  it("words a connection that got no answer as the local-server helper does", () => {
    const local = {
      provider: "openai",
      apiBase: "http://192.168.1.50:8080/v1",
    };
    expect(
      plainConnectionFailure(
        local,
        "Could not reach http://192.168.1.50:8080/v1/models: timed out.",
      ),
    ).toBe(
      "Could not reach the model server at 192.168.1.50:8080. The connection timed out. Check that the server is running, that the port is right, and that it listens on this address. A server that listens only on 127.0.0.1 does not accept connections from other machines. A firewall on that machine can also block the port.",
    );
    // A cloud address and an answer with a status keep the tester's words
    const cloud =
      "Could not reach https://api.openai.com/v1/models: fetch failed.";
    expect(plainConnectionFailure({ provider: "openai" }, cloud)).toBe(cloud);
    const rejected = "The server rejected the API key (HTTP 401).";
    expect(plainConnectionFailure(local, rejected)).toBe(rejected);
  });
});
