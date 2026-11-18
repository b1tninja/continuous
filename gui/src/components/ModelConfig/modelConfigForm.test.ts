import type { ModelBlockInfo } from "core/config/modelEdit/modelBlockEdit";
import {
  MODEL_EDIT_FIELDS,
  pathKey,
} from "core/config/modelEdit/modelEditFields";
import { describe, expect, it } from "vitest";
import {
  fieldError,
  formFromBlock,
  formToOps,
  fromInput,
  visibleFields,
  type ModelForm,
} from "./modelConfigForm";

const INFO: ModelBlockInfo = {
  editable: true,
  file: "/home/u/.continuous/config.yaml",
  scope: "user",
  entry: {
    name: "Qwen",
    provider: "openai",
    model: "qwen3-coder",
    apiBase: "http://localhost:8000/v1",
    apiKey: "${{ secrets.QWEN_KEY }}",
    capabilities: ["tool_use", "next_edit"],
    defaultCompletionOptions: { temperature: 0.2, stop: ["</s>"] },
    requestOptions: {
      headers: { Authorization: "••••••", "X-Team": "tools" },
      verifySsl: false,
    },
  },
  credentials: {
    apiKey: { state: "secret", secretName: "QWEN_KEY" },
    headers: { Authorization: { state: "plaintext" } },
    env: {},
  },
};

const edit = (f: ModelForm, key: string, value: string | string[] | null) => ({
  ...f,
  fields: { ...f.fields, [key]: value },
});

describe("formFromBlock", () => {
  it("prefills each input from the entry", () => {
    const f = formFromBlock(INFO);
    expect(f.fields.provider).toBe("openai");
    expect(f.fields["defaultCompletionOptions.temperature"]).toBe("0.2");
    expect(f.fields["defaultCompletionOptions.stop"]).toBe("</s>");
    expect(f.fields["requestOptions.verifySsl"]).toBe("off");
    expect(f.fields["requestOptions.useSystemCa"]).toBe("default");
    expect(f.fields["defaultCompletionOptions.maxTokens"]).toBe("");
    expect(f.fields.roles).toBeNull();
    expect(f.tools).toBe("on");
    expect(f.images).toBe("off");
  });

  it("withholds credential headers and keeps the others", () => {
    const f = formFromBlock(INFO);
    expect(f.headers).toEqual([
      expect.objectContaining({
        name: "Authorization",
        value: "",
        withheld: { state: "plaintext" },
      }),
      expect.objectContaining({ name: "X-Team", value: "tools" }),
    ]);
  });
});

describe("formToOps", () => {
  it("writes nothing when nothing changed: defaults stay unwritten", () => {
    const f = formFromBlock(INFO);
    expect(formToOps(f, f)).toEqual({ ops: [], errors: {} });
  });

  it("writes only the field that changed", () => {
    const f = formFromBlock(INFO);
    const next = edit(f, "defaultCompletionOptions.maxTokens", "2048");
    expect(formToOps(f, next).ops).toEqual([
      { path: ["defaultCompletionOptions", "maxTokens"], value: 2048 },
    ]);
  });

  it("removes a key cleared back to its default", () => {
    const f = formFromBlock(INFO);
    const next = edit(f, "defaultCompletionOptions.temperature", "");
    expect(formToOps(f, next).ops).toEqual([
      { path: ["defaultCompletionOptions", "temperature"] },
    ]);
  });

  it("turns every covered input back into the value it was read from", () => {
    const samples: Record<string, unknown> = {
      "requestOptions.noProxy": ["a", "b"],
      "requestOptions.caBundlePath": "/one.pem",
      roles: ["chat"],
      "defaultCompletionOptions.stop": ["x", "y"],
      "defaultCompletionOptions.reasoning": true,
      "requestOptions.verifySsl": false,
      "cacheBehavior.ttl": "5m",
      toolDialect: "qwen-xml",
    };
    for (const field of MODEL_EDIT_FIELDS) {
      if (field.kind === "secretRef") continue;
      const key = pathKey(field.path);
      const value =
        samples[key] ??
        (field.kind === "number"
          ? 7
          : field.kind === "boolean"
            ? true
            : field.kind === "url"
              ? "https://h.test/v1"
              : "text");
      const entry = structuredClone(INFO.entry!) as Record<string, any>;
      let at = entry;
      for (const p of field.path.slice(0, -1)) at = at[p] ??= {};
      at[field.path[field.path.length - 1]] = value;
      const f = formFromBlock({ ...INFO, entry });
      expect(fromInput(field, f.fields[key]), key).toEqual(value);
    }
  });

  it("keeps capability names the dialog does not manage", () => {
    const f = formFromBlock(INFO);
    const { ops } = formToOps(f, { ...f, images: "on" });
    expect(ops).toEqual([
      {
        path: ["capabilities"],
        value: ["tool_use", "image_input", "next_edit"],
      },
    ]);
  });

  it("explains why auto cannot be mixed with a listed capability", () => {
    const f = formFromBlock(INFO);
    const { ops, errors } = formToOps(f, { ...f, tools: "auto" });
    expect(ops).toEqual([]);
    expect(errors.capabilities).toMatch(/next_edit/);
  });

  it("writes a secret reference, never the key value", () => {
    const f = formFromBlock(INFO);
    const { ops } = formToOps(f, {
      ...f,
      key: {
        mode: "secret",
        secretName: "NEW_KEY",
        value: "sk-live-123",
        storage: "secure",
      },
    });
    expect(ops).toEqual([
      { path: ["apiKey"], value: "${{ secrets.NEW_KEY }}" },
    ]);
    expect(JSON.stringify(ops)).not.toContain("sk-live-123");
  });

  it("rejects a bad secret name", () => {
    const f = formFromBlock(INFO);
    const { errors } = formToOps(f, {
      ...f,
      key: { mode: "secret", secretName: "1-bad", value: "", storage: "env" },
    });
    expect(errors.apiKey).toMatch(/letters, digits/);
  });

  it("keeps a withheld header unless a reference is typed, and refuses plain text", () => {
    const f = formFromBlock(INFO);
    const typed = (value: string) => ({
      ...f,
      headers: f.headers.map((h) =>
        h.name === "Authorization" ? { ...h, value } : h,
      ),
    });
    expect(formToOps(f, typed("")).ops).toEqual([]);
    expect(formToOps(f, typed("Bearer sk-1")).errors).toHaveProperty([
      "requestOptions.headers.Authorization",
    ]);
    expect(formToOps(f, typed("${{ secrets.AUTH }}")).ops).toEqual([
      {
        path: ["requestOptions", "headers", "Authorization"],
        value: "${{ secrets.AUTH }}",
      },
    ]);
  });

  it("removes a deleted header and adds a new one", () => {
    const f = formFromBlock(INFO);
    const next = {
      ...f,
      headers: [f.headers[0], { id: "n1", name: "X-Org", value: "acme" }],
    };
    expect(formToOps(f, next).ops).toEqual([
      { path: ["requestOptions", "headers", "X-Org"], value: "acme" },
      { path: ["requestOptions", "headers", "X-Team"] },
    ]);
  });

  it("reports each invalid value against its field", () => {
    const f = formFromBlock(INFO);
    let next = edit(f, "defaultCompletionOptions.temperature", "hot");
    next = edit(next, "requestOptions.timeout", "-1");
    next = edit(next, "apiBase", "not a url");
    next = edit(next, "roles", []);
    const { ops, errors } = formToOps(f, next);
    expect(ops).toEqual([]);
    expect(errors).toEqual({
      "defaultCompletionOptions.temperature": "Enter a number.",
      "requestOptions.timeout": "Must be more than 0.",
      apiBase: "Enter a full URL, such as https://host:port/v1.",
      roles: "Pick at least one.",
    });
  });
});

describe("visibleFields and fieldError", () => {
  it("shows provider-specific settings only where they apply", () => {
    const keys = (p: string) =>
      visibleFields("connection", p, {}).map((f) => pathKey(f.path));
    expect(keys("bedrock")).toContain("env.region");
    expect(keys("openai")).not.toContain("env.region");
    expect(keys("azure")).toContain("env.deployment");
    // already written: shown whatever the provider
    expect(
      visibleFields("connection", "openai", { env: { region: "x" } }).map((f) =>
        pathKey(f.path),
      ),
    ).toContain("env.region");
  });

  it("gives a message while typing", () => {
    const topP = MODEL_EDIT_FIELDS.find(
      (f) => pathKey(f.path) === "defaultCompletionOptions.topP",
    )!;
    expect(fieldError(topP, "1.5")).toBe("Must be 1 or less.");
    expect(fieldError(topP, "")).toBeUndefined();
  });
});
