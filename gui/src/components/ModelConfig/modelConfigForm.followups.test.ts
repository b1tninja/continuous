import type { ModelBlockInfo } from "core/config/modelEdit/modelBlockEdit";
import {
  MODEL_EDIT_FIELDS,
  pathKey,
} from "core/config/modelEdit/modelEditFields";
import { describe, expect, it } from "vitest";
import {
  formFromBlock,
  formToOps,
  fromInput,
  mergeOps,
  secretsToStore,
  visibleFields,
} from "./modelConfigForm";
import {
  chatTemplatePreview,
  renderTemplatePreview,
  templateVariables,
} from "./templatePreview";

const INFO: ModelBlockInfo = {
  editable: true,
  entry: {
    name: "Claude",
    provider: "bedrock",
    model: "anthropic.claude-sonnet-4-6",
    env: { region: "us-east-1", accessKeyId: "${{ secrets.AWS_ID }}" },
    chatOptions: {
      baseSystemMessage: "Be brief.",
      toolOverrides: {
        read_file: {
          description: "Read one file.",
          displayTitle: "Open",
        },
      },
    },
  },
  credentials: {
    apiKey: { state: "none" },
    headers: {},
    env: { accessKeyId: { state: "secret", secretName: "AWS_ID" } },
  },
};

const field = (key: string) =>
  MODEL_EDIT_FIELDS.find((f) => pathKey(f.path) === key)!;

describe("multiline fields", () => {
  it("keeps what was typed, inner lines and indentation included", () => {
    const f = field("chatOptions.baseSystemMessage");
    expect(fromInput(f, "  Line one.\n\n  - two\n")).toBe(
      "  Line one.\n\n  - two",
    );
    expect(fromInput(f, "  \n ")).toBeUndefined();
  });

  it("prefills from the entry and writes a change", () => {
    const initial = formFromBlock(INFO);
    expect(initial.fields["chatOptions.baseSystemMessage"]).toBe("Be brief.");
    const { ops } = formToOps(initial, {
      ...initial,
      fields: {
        ...initial.fields,
        "chatOptions.baseSystemMessage": "",
        "promptTemplates.chat": "chatml",
      },
    });
    expect(ops).toEqual([
      { path: ["chatOptions", "baseSystemMessage"] },
      { path: ["promptTemplates", "chat"], value: "chatml" },
    ]);
  });
});

describe("tool overrides", () => {
  it("reads the override and keeps the keys the editor does not show", () => {
    const initial = formFromBlock(INFO);
    expect(initial.toolOverrides).toEqual([
      {
        id: "t0",
        tool: "read_file",
        description: "Read one file.",
        disabled: false,
        raw: { description: "Read one file.", displayTitle: "Open" },
      },
    ]);
    expect(formToOps(initial, initial).ops).toEqual([]);
    const { ops } = formToOps(initial, {
      ...initial,
      toolOverrides: [{ ...initial.toolOverrides[0], disabled: true }],
    });
    expect(ops).toEqual([
      {
        path: ["chatOptions", "toolOverrides", "read_file"],
        value: {
          displayTitle: "Open",
          description: "Read one file.",
          disabled: true,
        },
      },
    ]);
  });

  it("removes a deleted override and refuses one listed twice", () => {
    const initial = formFromBlock(INFO);
    expect(formToOps(initial, { ...initial, toolOverrides: [] }).ops).toEqual([
      { path: ["chatOptions", "toolOverrides", "read_file"] },
    ]);
    const twice = formToOps(initial, {
      ...initial,
      toolOverrides: [
        initial.toolOverrides[0],
        { id: "n", tool: "read_file", description: "", disabled: true },
      ],
    });
    expect(twice.errors["chatOptions.toolOverrides.read_file"]).toBe(
      "This tool is listed twice.",
    );
  });

  it("asks for the tool of a row that overrides something", () => {
    const initial = formFromBlock(INFO);
    const { errors } = formToOps(initial, {
      ...initial,
      toolOverrides: [
        ...initial.toolOverrides,
        { id: "n1", tool: "", description: "", disabled: true },
      ],
    });
    expect(errors["chatOptions.toolOverrides.n1"]).toBe("Choose the tool.");
  });
});

describe("credential fields other than the API key", () => {
  it("show for AWS providers only, unless already written", () => {
    const keys = visibleFields("connection", "bedrock", {}).map((f) =>
      pathKey(f.path),
    );
    // secret fields have their own editor, not a plain input
    expect(keys).not.toContain("env.secretAccessKey");
    expect(keys).toEqual(
      expect.arrayContaining([
        "env.serviceTier",
        "env.latency",
        "env.crossRegionInference",
        "env.guardrailIdentifier",
        "env.guardrailVersion",
      ]),
    );
    expect(
      visibleFields("connection", "openai", {}).map((f) => pathKey(f.path)),
    ).not.toContain("env.serviceTier");
    expect(
      visibleFields("connection", "watsonx", {}).map((f) => pathKey(f.path)),
    ).toEqual(expect.arrayContaining(["env.deploymentId", "env.apiVersion"]));
  });

  it("write a reference and list the value to store first", () => {
    const initial = formFromBlock(INFO);
    const current = {
      ...initial,
      key: {
        mode: "secret" as const,
        secretName: "BR_KEY",
        value: "k1",
        storage: "env" as const,
      },
      secrets: {
        ...initial.secrets,
        "env.accessKeyId": { mode: "remove" as const },
        "env.sessionToken": {
          mode: "secret" as const,
          secretName: "AWS_TOKEN",
          value: "tok",
          storage: "secure" as const,
        },
      },
    };
    const { ops, errors } = formToOps(initial, current);
    expect(errors).toEqual({});
    expect(ops).toEqual([
      { path: ["apiKey"], value: "${{ secrets.BR_KEY }}" },
      { path: ["env", "accessKeyId"] },
      { path: ["env", "sessionToken"], value: "${{ secrets.AWS_TOKEN }}" },
    ]);
    expect(JSON.stringify(ops)).not.toMatch(/k1|tok"/);
    expect(secretsToStore(current)).toEqual([
      { label: "API key", secretName: "BR_KEY", value: "k1", storage: "env" },
      {
        label: "AWS session token",
        secretName: "AWS_TOKEN",
        value: "tok",
        storage: "secure",
      },
    ]);
  });

  it("refuses a bad secret name on that field", () => {
    const initial = formFromBlock(INFO);
    const { errors } = formToOps(initial, {
      ...initial,
      secrets: {
        ...initial.secrets,
        "env.secretAccessKey": {
          mode: "secret",
          secretName: "9bad",
          value: "",
          storage: "secure",
        },
      },
    });
    expect(errors["env.secretAccessKey"]).toMatch(/letters, digits/);
  });
});

describe("mergeOps", () => {
  const t = (v: number) => ({
    path: ["defaultCompletionOptions", "temperature"],
    value: v,
  });

  it("joins changes to different settings", () => {
    expect(mergeOps([t(1)], [{ path: ["contextLength"], value: 8 }])).toEqual({
      ops: [t(1), { path: ["contextLength"], value: 8 }],
      conflicts: [],
    });
  });

  it("keeps the same change once", () => {
    expect(mergeOps([t(1)], [t(1)])).toEqual({ ops: [t(1)], conflicts: [] });
  });

  it("reports different changes to one setting, or to a map and its key", () => {
    expect(mergeOps([t(1)], [t(2)]).conflicts).toEqual([
      "defaultCompletionOptions.temperature",
    ]);
    const header = {
      path: ["chatOptions", "toolOverrides", "read_file"],
      value: { disabled: true },
    };
    expect(
      mergeOps(
        [header],
        [{ path: ["chatOptions", "toolOverrides", "read_file"] }],
      ).conflicts,
    ).toEqual(["chatOptions.toolOverrides.read_file"]);
  });
});

describe("template previews", () => {
  it("lists the variables a template reads, without helpers", () => {
    expect(
      templateVariables(
        "{{#if prefix}}{{{prefix}}}{{/if}}{{ suffix }}{{{prefix}}}{{else}}",
      ),
    ).toEqual(["prefix", "suffix"]);
  });

  it("renders with sample values and reports what core never fills in", () => {
    const r = renderTemplatePreview(
      "apply",
      "{{{original_code}}} -> {{{new_code}}} {{{codeToEdit}}}",
    );
    expect(r.text).toBe("let x = 1; -> let count = 1; ");
    expect(r.unknown).toEqual(["codeToEdit"]);
  });

  it("says when a template does not compile", () => {
    const r = renderTemplatePreview("autocomplete", "{{#if prefix}}open");
    expect(r.text).toBeUndefined();
    expect(r.error).toBeTruthy();
  });

  it("shows nothing for a provider that applies the model's own template", () => {
    expect(chatTemplatePreview("gpt-5", "openai", undefined)).toEqual({});
    expect(chatTemplatePreview("my-model", "vllm", "llama3").text).toContain(
      "<|start_header_id|>user<|end_header_id|>",
    );
  });
});
