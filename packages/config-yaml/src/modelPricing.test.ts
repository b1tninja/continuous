import {
  catalogModelSchema,
  CHAT_TEMPLATE_VALUES,
  configYamlSchema,
  connectedModelSchema,
  modelPricingSchema,
  modelSchema,
} from "./browser.js";

const base = { name: "m", model: "qwen3-coder", provider: "vllm" };

describe("model pricing schema", () => {
  it("accepts input and output, with optional cache rates and currency", () => {
    const parsed = modelSchema.parse({
      ...base,
      pricing: {
        input: 0.5,
        output: 2,
        cacheRead: 0.05,
        cacheWrite: 0.625,
        currency: "USD",
      },
    });
    expect(parsed.pricing).toEqual({
      input: 0.5,
      output: 2,
      cacheRead: 0.05,
      cacheWrite: 0.625,
      currency: "USD",
    });
  });

  it("takes zero as a real price (a local model)", () => {
    expect(
      modelSchema.parse({ ...base, pricing: { input: 0, output: 0 } }).pricing,
    ).toEqual({ input: 0, output: 0 });
  });

  it("requires both input and output", () => {
    const r = modelSchema.safeParse({ ...base, pricing: { input: 1 } });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path.join("."))).toEqual([
      "pricing.output",
    ]);
  });

  it.each([
    [{ input: -1, output: 1 }, "pricing.input", "A price cannot be negative."],
    [
      { input: "1", output: 1 },
      "pricing.input",
      "A price is a number of US dollars per million tokens.",
    ],
    [
      { input: 1, output: 1, cacheRead: -0.1 },
      "pricing.cacheRead",
      "A price cannot be negative.",
    ],
    [
      { input: 1, output: 1, currency: "EUR" },
      "pricing.currency",
      "Prices are in USD.",
    ],
  ])("refuses %j with a message", (pricing, path, message) => {
    const r = modelPricingSchema.safeParse(pricing);
    expect(r.success).toBe(false);
    const issue = r.error!.issues[0];
    expect(["pricing", ...issue.path].join(".")).toBe(path);
    expect(issue.message).toBe(message);
  });

  it("is allowed on a connected model, a catalog model and in a config", () => {
    const pricing = { input: 1, output: 3 };
    expect(
      connectedModelSchema.parse({
        name: "m",
        model: "x",
        connection: "acct",
        pricing,
      }).pricing,
    ).toEqual(pricing);
    expect(
      catalogModelSchema.parse({ name: "m", model: "x", pricing }).pricing,
    ).toEqual(pricing);
    const config = configYamlSchema.parse({
      name: "c",
      version: "1",
      models: [{ ...base, pricing }],
    });
    expect((config.models?.[0] as { pricing?: unknown }).pricing).toEqual(
      pricing,
    );
  });
});

describe("chat template names", () => {
  it("lists the values the promptTemplates.chat schema accepts", () => {
    for (const chat of CHAT_TEMPLATE_VALUES) {
      expect(
        modelSchema.safeParse({ ...base, promptTemplates: { chat } }).success,
      ).toBe(true);
    }
    expect(
      modelSchema.safeParse({ ...base, promptTemplates: { chat: "nope" } })
        .success,
    ).toBe(false);
  });
});
