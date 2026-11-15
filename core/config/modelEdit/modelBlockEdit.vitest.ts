import { describe, expect, it } from "vitest";
import * as YAML from "yaml";
import {
  diffText,
  editModelBlockText,
  previewModelEditText,
  readModelBlock,
} from "./modelBlockEdit";
import {
  applyModelPatch,
  capabilitiesFor,
  capabilityState,
  maskYamlLine,
  MASK,
  MODEL_EDIT_FIELDS,
  validateFieldValue,
} from "./modelEditFields";

const SRC = `# my config
name: Local
version: 1.0.0
schema: v1
models:
  # the main one
  - name: Qwen # trailing
    provider: openai
    model: qwen3-coder
    apiBase: http://localhost:8000/v1
    apiKey: \${{ secrets.QWEN_KEY }}
    futureKey: keep me # unknown to the schema of today
    defaultCompletionOptions:
      temperature: 0.2 # tuned
    requestOptions:
      headers:
        Authorization: Bearer sk-plain-header
        X-Team: tools
  - name: Plain
    provider: anthropic
    model: claude-x
    apiKey: sk-ant-plaintext-value
  - name: Shared
    from: Catalog Model
`;

const parsed = (text: string) => YAML.parse(text);
const qwen = (text: string) => parsed(text).models[0];

describe("readModelBlock", () => {
  it("prefills from the entry and keeps unknown keys", () => {
    const info = readModelBlock(SRC, "Qwen");
    expect(info.editable).toBe(true);
    expect(info.entry).toMatchObject({
      provider: "openai",
      model: "qwen3-coder",
      apiBase: "http://localhost:8000/v1",
      futureKey: "keep me",
      defaultCompletionOptions: { temperature: 0.2 },
    });
  });

  it("returns secret names and never a plain credential", () => {
    const info = readModelBlock(SRC, "Qwen");
    expect(info.credentials?.apiKey).toEqual({
      state: "secret",
      secretName: "QWEN_KEY",
    });
    expect(info.credentials?.headers.Authorization).toEqual({
      state: "plaintext",
    });
    expect(JSON.stringify(info)).not.toContain("sk-plain-header");

    const plain = readModelBlock(SRC, "Plain");
    expect(plain.credentials?.apiKey).toEqual({ state: "plaintext" });
    expect(plain.entry?.apiKey).toBe(MASK);
    expect(JSON.stringify(plain)).not.toContain("sk-ant-plaintext-value");
  });

  it("says why a model cannot be edited here", () => {
    expect(readModelBlock(SRC, "Nope")).toMatchObject({
      editable: false,
      reason: expect.stringContaining("No model named"),
    });
    expect(readModelBlock(SRC, "Shared")).toMatchObject({
      editable: false,
      reason: expect.stringContaining("Catalog Model"),
    });
    const twice = SRC.replace("name: Plain", "name: Qwen");
    expect(readModelBlock(twice, "Qwen").reason).toMatch(/2 models/);
  });
});

describe("editModelBlockText", () => {
  it("writes nothing when nothing changed", () => {
    expect(editModelBlockText(SRC, "Qwen", []).text).toBeUndefined();
    const same = editModelBlockText(SRC, "Qwen", [
      { path: ["defaultCompletionOptions", "temperature"], value: 0.2 },
    ]);
    expect(same.text).toBeUndefined();
  });

  it("keeps comments, key order and unknown keys", () => {
    const { text } = editModelBlockText(SRC, "Qwen", [
      { path: ["defaultCompletionOptions", "temperature"], value: 0.7 },
      { path: ["contextLength"], value: 32768 },
    ]);
    expect(text).toContain("# my config");
    expect(text).toContain("# the main one");
    expect(text).toContain("# trailing");
    expect(text).toContain("temperature: 0.7 # tuned");
    expect(text).toContain("futureKey: keep me # unknown to the schema");
    // the plaintext header nobody touched stays as it was
    expect(text).toContain("Authorization: Bearer sk-plain-header");
    expect(qwen(text!).contextLength).toBe(32768);
    const keys = Object.keys(qwen(text!));
    expect(keys.indexOf("futureKey")).toBeLessThan(
      keys.indexOf("contextLength"),
    );
    // the other entries are untouched
    expect(parsed(text!).models.slice(1)).toEqual(parsed(SRC).models.slice(1));
  });

  it("round-trips every covered field", () => {
    const samples: Record<string, unknown> = {
      provider: "vllm",
      model: "other",
      apiBase: "https://example.test/v1",
      apiKey: "${{ secrets.OTHER_KEY }}",
      "env.region": "us-west-2",
      "env.profile": "work",
      "env.projectId": "p1",
      "env.deployment": "dep",
      "env.apiVersion": "2024-10-21",
      "env.apiType": "azure-openai",
      "requestOptions.timeout": 30,
      "requestOptions.connectTimeout": 5,
      "requestOptions.proxy": "http://proxy.test:8080",
      "requestOptions.noProxy": ["localhost", "10.0.0.1"],
      "requestOptions.verifySsl": false,
      "requestOptions.useSystemCa": true,
      "requestOptions.caBundlePath": ["/a.pem", "/b.pem"],
      roles: ["chat", "edit"],
      toolDialect: "hermes-json",
      "defaultCompletionOptions.temperature": 1.1,
      "defaultCompletionOptions.topP": 0.9,
      "defaultCompletionOptions.topK": 40,
      "defaultCompletionOptions.presencePenalty": 0.5,
      "defaultCompletionOptions.frequencyPenalty": -0.5,
      "defaultCompletionOptions.maxTokens": 4096,
      "defaultCompletionOptions.stop": ["</s>", "END"],
      "defaultCompletionOptions.reasoning": true,
      "defaultCompletionOptions.reasoningBudgetTokens": 2048,
      contextLength: 128000,
      "defaultCompletionOptions.promptCaching": false,
      "cacheBehavior.cacheSystemMessage": true,
      "cacheBehavior.cacheConversation": false,
      "cacheBehavior.ttl": "1h",
      "env.accessKeyId": "${{ secrets.AWS_ID }}",
      "env.secretAccessKey": "${{ secrets.AWS_SECRET }}",
      "env.sessionToken": "${{ secrets.AWS_TOKEN }}",
      "env.crossRegionInference": "global",
      "env.serviceTier": "flex",
      "env.latency": "optimized",
      "env.guardrailIdentifier": "gr-abc123",
      "env.guardrailVersion": "1",
      "env.deploymentId": "dep-1",
      "chatOptions.baseSystemMessage": "Be brief.\nUse lists.",
      "chatOptions.baseAgentSystemMessage": "Act.",
      "chatOptions.basePlanSystemMessage": "Plan first.",
      "promptTemplates.chat": "llama3",
      "promptTemplates.edit": "Edit {{{codeToEdit}}}\nas {{{userInput}}}",
      "promptTemplates.apply": "{{{original_code}}}\n{{{new_code}}}",
      "promptTemplates.autocomplete": "<PRE>{{{prefix}}}<SUF>{{{suffix}}}",
      "pricing.input": 0.5,
      "pricing.output": 2,
      "pricing.cacheRead": 0.05,
      "pricing.cacheWrite": 0,
    };
    // A price needs both input and output, so each rate is written with them
    const companions = (key: string) =>
      key.startsWith("pricing.")
        ? [
            { path: ["pricing", "input"], value: 1 },
            { path: ["pricing", "output"], value: 1 },
          ].filter((op) => op.path.join(".") !== key)
        : [];
    for (const field of MODEL_EDIT_FIELDS) {
      const key = field.path.join(".");
      expect(samples, `a sample for ${key}`).toHaveProperty([key]);
      const value = samples[key];
      const { text, errors, error } = editModelBlockText(SRC, "Qwen", [
        ...companions(key),
        { path: field.path, value },
      ]);
      expect(error, key).toBeUndefined();
      expect(errors, key).toEqual([]);
      let got: unknown = qwen(text!);
      for (const p of field.path) got = (got as any)[p];
      expect(got, key).toEqual(value);
      expect(text, key).toContain("# trailing");
    }
  });

  it("removes a key set back to its default, and a map left empty", () => {
    const { text } = editModelBlockText(SRC, "Qwen", [
      { path: ["defaultCompletionOptions", "temperature"] },
    ]);
    expect(qwen(text!)).not.toHaveProperty("defaultCompletionOptions");
    expect(qwen(text!).futureKey).toBe("keep me");
  });

  it("never writes a plain key, and accepts a secret reference", () => {
    const bad = editModelBlockText(SRC, "Qwen", [
      { path: ["apiKey"], value: "sk-typed-in" },
    ]);
    expect(bad.text).toBeUndefined();
    expect(bad.errors[0]).toMatchObject({ path: ["apiKey"] });
    const header = editModelBlockText(SRC, "Qwen", [
      {
        path: ["requestOptions", "headers", "X-Api-Key"],
        value: "abc123",
      },
    ]);
    expect(header.text).toBeUndefined();
    expect(header.errors[0].message).toMatch(/secret/);

    const ok = editModelBlockText(SRC, "Qwen", [
      { path: ["apiKey"], value: "${{ secrets.NEW_KEY }}" },
      {
        path: ["requestOptions", "headers", "X-Api-Key"],
        value: "${{ secrets.HEADER_KEY }}",
      },
    ]);
    expect(qwen(ok.text!).apiKey).toBe("${{ secrets.NEW_KEY }}");
    expect(qwen(ok.text!).requestOptions.headers["X-Api-Key"]).toBe(
      "${{ secrets.HEADER_KEY }}",
    );
    expect(qwen(ok.text!).requestOptions.headers["X-Team"]).toBe("tools");
  });

  it("refuses paths the dialog does not manage", () => {
    const r = editModelBlockText(SRC, "Qwen", [
      { path: ["name"], value: "Renamed" },
      { path: ["futureKey"], value: "x" },
      { path: ["autocompleteOptions", "disable"], value: true },
    ]);
    expect(r.text).toBeUndefined();
    expect(r.errors.map((e) => e.path.join("."))).toEqual([
      "name",
      "futureKey",
      "autocompleteOptions.disable",
    ]);
  });

  it("rejects invalid values with a message per field", () => {
    const r = editModelBlockText(SRC, "Qwen", [
      { path: ["defaultCompletionOptions", "temperature"], value: 3 },
      { path: ["defaultCompletionOptions", "maxTokens"], value: 10.5 },
      { path: ["apiBase"], value: "localhost:8000" },
      { path: ["toolDialect"], value: "made-up" },
      { path: ["roles"], value: ["chat", "nope"] },
      { path: ["model"] },
    ]);
    expect(r.text).toBeUndefined();
    const byPath = Object.fromEntries(
      r.errors.map((e) => [e.path.join("."), e.message]),
    );
    expect(byPath["defaultCompletionOptions.temperature"]).toMatch(/2 or less/);
    expect(byPath["defaultCompletionOptions.maxTokens"]).toMatch(/whole/);
    expect(byPath.apiBase).toMatch(/full URL/);
    expect(byPath.toolDialect).toMatch(/one of/);
    expect(byPath.roles).toMatch(/nope/);
    expect(byPath.model).toMatch(/required/);
  });

  it("requires a provider unless the model names a connection", () => {
    const r = editModelBlockText(SRC, "Qwen", [{ path: ["provider"] }]);
    expect(r.errors).toEqual([
      { path: ["provider"], message: "Provider is required." },
    ]);
    const connected = SRC.replace(
      "    provider: openai\n",
      "    connection: work\n    provider: openai\n",
    );
    const ok = editModelBlockText(connected, "Qwen", [{ path: ["provider"] }]);
    expect(ok.errors).toEqual([]);
    expect(qwen(ok.text!).connection).toBe("work");
  });

  it("keeps CRLF line endings", () => {
    const crlf = SRC.replace(/\n/g, "\r\n");
    const { text } = editModelBlockText(crlf, "Qwen", [
      { path: ["contextLength"], value: 1000 },
    ]);
    expect(text).toContain("\r\n");
    expect(text!.replace(/\r\n/g, "")).not.toContain("\n");
  });
});

describe("capabilities", () => {
  it("removes the list when both are auto and nothing else is listed", () => {
    expect(capabilitiesFor(undefined, "auto", "auto")).toEqual({
      value: undefined,
    });
    expect(capabilitiesFor(["tool_use"], "auto", "auto").value).toBeUndefined();
  });

  it("writes both choices and keeps names it does not manage", () => {
    expect(capabilitiesFor(["next_edit"], "on", "off")).toEqual({
      value: ["tool_use", "next_edit"],
    });
    expect(capabilitiesFor(undefined, "off", "on").value).toEqual([
      "image_input",
    ]);
  });

  it("explains why auto cannot be mixed with a set value", () => {
    expect(capabilitiesFor(undefined, "on", "auto").error).toMatch(/one list/);
    expect(capabilitiesFor(["next_edit"], "auto", "auto").error).toMatch(
      /next_edit/,
    );
  });

  it("reads the tri-state back", () => {
    expect(capabilityState(undefined, "tool_use")).toBe("auto");
    expect(capabilityState(["tool_use"], "tool_use")).toBe("on");
    expect(capabilityState(["tool_use"], "image_input")).toBe("off");
  });
});

describe("preview and diff", () => {
  it("shows only the changed lines with context, credentials masked", () => {
    const preview = previewModelEditText(SRC, "Qwen", [
      { path: ["defaultCompletionOptions", "temperature"], value: 0.5 },
      {
        path: ["requestOptions", "headers", "X-Team"],
        value: "infra",
      },
    ]);
    expect(preview.changed).toBe(true);
    expect(preview.baseHash).toMatch(/^[0-9a-f]{64}$/);
    const text = preview.diff.map((l) => `${l.kind}:${l.text}`).join("\n");
    expect(text).toContain("del:      temperature: 0.2 # tuned");
    expect(text).toContain("add:      temperature: 0.5 # tuned");
    expect(text).toContain("add:        X-Team: infra");
    expect(text).not.toContain("sk-plain-header");
    expect(text).toContain(`Authorization: ${MASK}`);
    expect(text).not.toContain("# my config");
  });

  it("reports field errors instead of a diff", () => {
    const preview = previewModelEditText(SRC, "Qwen", [
      { path: ["defaultCompletionOptions", "topP"], value: 0 },
    ]);
    expect(preview.changed).toBe(false);
    expect(preview.diff).toEqual([]);
    expect(preview.errors[0].message).toMatch(/more than 0/);
  });

  it("marks the gaps between distant changes", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].join("\n");
    const after = ["A", "b", "c", "d", "e", "f", "g", "h", "I"].join("\n");
    const kinds = diffText(before, after).map((l) => l.kind);
    expect(kinds).toContain("gap");
    expect(kinds.filter((k) => k === "same")).toHaveLength(4);
  });
});

describe("maskYamlLine", () => {
  it("masks plain credential values and leaves references alone", () => {
    expect(maskYamlLine("    apiKey: sk-123 # note")).toBe(
      `    apiKey: ${MASK} # note`,
    );
    expect(maskYamlLine('  - apiKey: "sk-123"')).toBe(`  - apiKey: ${MASK}`);
    expect(maskYamlLine("    apiKey: ${{ secrets.K }}")).toBe(
      "    apiKey: ${{ secrets.K }}",
    );
    expect(maskYamlLine("    secretAccessKey: abc")).toBe(
      `    secretAccessKey: ${MASK}`,
    );
    expect(maskYamlLine("    model: gpt")).toBe("    model: gpt");
  });
});

describe("validateFieldValue", () => {
  it("names the bound that was crossed", () => {
    expect(validateFieldValue(["requestOptions", "timeout"], 0)).toMatch(
      /more than 0/,
    );
    expect(validateFieldValue(["requestOptions", "proxy"], "ftp://x")).toMatch(
      /http/,
    );
    expect(validateFieldValue(["apiBase"], "https://user:pw@host/v1")).toMatch(
      /password/,
    );
    expect(validateFieldValue(["apiKey"], "${{ secrets.9BAD }}")).toBeDefined();
  });

  it("applies a patch without touching the input", () => {
    const entry = { name: "x", provider: "openai", model: "m" };
    const { entry: next } = applyModelPatch(entry, [
      { path: ["contextLength"], value: 10 },
    ]);
    expect(entry).not.toHaveProperty("contextLength");
    expect(next.contextLength).toBe(10);
  });
});
