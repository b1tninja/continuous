import { describe, expect, it } from "vitest";
import * as YAML from "yaml";

import { INFERENCE_PROFILE_PREFIXES } from "../../llm/llms/bedrockHelpers";
import { entryYamlText, parseEntryYaml } from "./entryYaml";
import {
  editModelBlockText,
  previewModelEditText,
  readModelBlock,
} from "./modelBlockEdit";
import {
  CROSS_REGION_VALUES,
  fieldFor,
  MASK,
  opsFromEntryEdit,
  validateFieldValue,
} from "./modelEditFields";

/**
 * The second slice of the model dialog: the Advanced (YAML) tab, the
 * Templates & system message tab, the price field and the remaining
 * provider settings, all written through the same patch and writer.
 */

const SRC = `# my config
name: Local
version: 1.0.0
schema: v1
models:
  # the main one
  - name: Qwen # trailing
    provider: openai
    model: qwen3-coder
    apiKey: sk-plain-key
    futureKey: keep me # unknown to the schema of today
    defaultCompletionOptions:
      temperature: 0.2 # tuned
    requestOptions:
      headers:
        Authorization: Bearer sk-plain-header
        X-Team: tools
  - name: Claude
    provider: bedrock
    model: anthropic.claude-sonnet-4-6
    env:
      region: us-east-1 # home region
      secretAccessKey: plain-aws-secret
`;

const entryOf = (text: string, i = 0) => YAML.parse(text).models[i];

/** What the Advanced tab sends: the typed YAML compared with the entry shown. */
function yamlTabEdit(text: string, title: string, edit: (y: string) => string) {
  const info = readModelBlock(text, title);
  const typed = edit(info.entryYaml!);
  const parsed = parseEntryYaml(typed);
  if (!parsed.ok) throw new Error(parsed.error);
  return { info, ...opsFromEntryEdit(info.entry!, parsed.entry) };
}

describe("Advanced (YAML) tab: the text shown", () => {
  it("is the entry's own lines with comments, credentials masked", () => {
    const { entryYaml } = readModelBlock(SRC, "Qwen");
    expect(entryYaml).toContain("temperature: 0.2 # tuned");
    expect(entryYaml).toContain("futureKey: keep me # unknown");
    expect(entryYaml).toContain(`apiKey: ${MASK}`);
    expect(entryYaml).toContain(`Authorization: ${MASK}`);
    expect(entryYaml).not.toContain("sk-plain");
    expect(entryYaml).toMatch(/^name: Qwen/);
    expect(YAML.parse(entryYaml!)).toEqual(readModelBlock(SRC, "Qwen").entry);
  });

  it("masks a plain AWS secret and keeps the comment beside the region", () => {
    const { entryYaml } = readModelBlock(SRC, "Claude");
    expect(entryYaml).toContain("region: us-east-1 # home region");
    expect(entryYaml).toContain(`secretAccessKey: ${MASK}`);
    expect(entryYaml).not.toContain("plain-aws-secret");
  });

  it("reads a CRLF file the same way", () => {
    const crlf = SRC.replace(/\n/g, "\r\n");
    expect(readModelBlock(crlf, "Qwen").entryYaml).toBe(
      readModelBlock(SRC, "Qwen").entryYaml,
    );
  });

  it("falls back to plain YAML when the entry uses an alias from elsewhere", () => {
    const text = `x: &opts\n  temperature: 0.4\nmodels:\n  - name: A\n    provider: openai\n    model: m\n    defaultCompletionOptions: *opts\n`;
    const info = readModelBlock(text, "A");
    expect(YAML.parse(info.entryYaml!)).toEqual(info.entry);
    expect(entryYamlText(text, 0, info.entry!)).toContain("temperature: 0.4");
  });
});

describe("Advanced (YAML) tab: what a save does", () => {
  it("turns an edit into the same patch, keeping comments, unknown keys and masked values", () => {
    const { ops, refused } = yamlTabEdit(SRC, "Qwen", (y) =>
      y
        .replace("temperature: 0.2", "temperature: 0.7")
        .concat("pricing:\n  input: 0.5\n  output: 2\n"),
    );
    expect(refused).toEqual([]);
    expect(ops).toEqual([
      { path: ["defaultCompletionOptions", "temperature"], value: 0.7 },
      { path: ["pricing", "input"], value: 0.5 },
      { path: ["pricing", "output"], value: 2 },
    ]);
    const out = editModelBlockText(SRC, "Qwen", ops).text!;
    expect(out).toContain("temperature: 0.7 # tuned");
    expect(out).toContain("# the main one");
    expect(out).toContain(
      "futureKey: keep me # unknown to the schema of today",
    );
    expect(out).toContain("apiKey: sk-plain-key");
    expect(out).toContain("Authorization: Bearer sk-plain-header");
    expect(entryOf(out).pricing).toEqual({ input: 0.5, output: 2 });
  });

  it("keeps CRLF line endings", () => {
    const crlf = SRC.replace(/\n/g, "\r\n");
    const { ops } = yamlTabEdit(crlf, "Qwen", (y) =>
      y.replace("temperature: 0.2", "temperature: 0.9"),
    );
    const out = editModelBlockText(crlf, "Qwen", ops).text!;
    expect(out).toContain("temperature: 0.9 # tuned\r\n");
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("refuses a change to a setting the dialog does not manage", () => {
    const { ops, refused } = yamlTabEdit(SRC, "Qwen", (y) =>
      y
        .replace("futureKey: keep me", "futureKey: changed")
        .replace("name: Qwen", "name: Renamed")
        .concat("routes:\n  - connection: other\n"),
    );
    expect(ops).toEqual([]);
    expect(refused.sort()).toEqual(["futureKey", "name", "routes"]);
    // and core refuses such a path even when a client sends it
    const res = editModelBlockText(SRC, "Qwen", [
      { path: ["routes"], value: [{ connection: "other" }] },
    ]);
    expect(res.text).toBeUndefined();
    expect(res.errors[0].message).toBe("This setting cannot be changed here.");
  });

  it("refuses a plain credential typed over the mask", () => {
    const { ops } = yamlTabEdit(SRC, "Qwen", (y) =>
      y.replace(`apiKey: ${MASK}`, "apiKey: sk-new-plain"),
    );
    expect(ops).toEqual([{ path: ["apiKey"], value: "sk-new-plain" }]);
    const res = editModelBlockText(SRC, "Qwen", ops);
    expect(res.text).toBeUndefined();
    expect(res.errors[0].message).toMatch(/never written into config.yaml/);
  });

  it("accepts a secret reference in place of a plain AWS secret", () => {
    const { ops } = yamlTabEdit(SRC, "Claude", (y) =>
      y.replace(
        `secretAccessKey: ${MASK}`,
        "secretAccessKey: ${{ secrets.AWS_SECRET }}",
      ),
    );
    const out = editModelBlockText(SRC, "Claude", ops).text!;
    expect(entryOf(out, 1).env).toEqual({
      region: "us-east-1",
      secretAccessKey: "${{ secrets.AWS_SECRET }}",
    });
    expect(out).toContain("region: us-east-1 # home region");
  });

  it("reports a YAML error with its line", () => {
    const r = parseEntryYaml("name: Qwen\nmodel: [unclosed\n");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/^Line \d+:/);
    expect(parseEntryYaml("- a\n- b\n")).toEqual({
      ok: false,
      error: "The entry is a map of settings (name: ..., model: ...).",
    });
  });

  it("validates the result with the schema, at the field's path", () => {
    const { ops } = yamlTabEdit(SRC, "Qwen", (y) =>
      y.concat("pricing:\n  input: 1\n"),
    );
    const p = previewModelEditText(SRC, "Qwen", ops);
    expect(p.changed).toBe(false);
    expect(p.errors.map((e) => e.path.join("."))).toEqual(["pricing.output"]);
  });
});

describe("Templates & system message", () => {
  it("writes a system message over several lines and reads it back unchanged", () => {
    const message = "You are terse.\nAnswer in one line.\n  Indented: kept.";
    const out = editModelBlockText(SRC, "Qwen", [
      { path: ["chatOptions", "baseSystemMessage"], value: message },
      { path: ["promptTemplates", "chat"], value: "chatml" },
    ]).text!;
    expect(entryOf(out).chatOptions.baseSystemMessage).toBe(message);
    expect(entryOf(out).promptTemplates).toEqual({ chat: "chatml" });
    expect(out).toContain("temperature: 0.2 # tuned");
  });

  it("refuses a chat template the schema does not know", () => {
    expect(validateFieldValue(["promptTemplates", "chat"], "nope")).toMatch(
      /^Choose one of: llama2/,
    );
  });

  it("sets and removes one tool's override as a whole", () => {
    const override = { description: "Read one file.", disabled: false };
    const out = editModelBlockText(SRC, "Qwen", [
      { path: ["chatOptions", "toolOverrides", "read_file"], value: override },
    ]).text!;
    expect(entryOf(out).chatOptions.toolOverrides).toEqual({
      read_file: override,
    });
    const back = editModelBlockText(out, "Qwen", [
      { path: ["chatOptions", "toolOverrides", "read_file"] },
    ]).text!;
    expect(entryOf(back).chatOptions).toBeUndefined();
  });

  it("checks a tool override against the schema", () => {
    expect(
      validateFieldValue(["chatOptions", "toolOverrides", "read_file"], {
        disabled: "yes",
      }),
    ).toMatch(/^disabled: /);
    expect(
      validateFieldValue(["chatOptions", "toolOverrides", "bad name!"], {}),
    ).toBe("This setting cannot be changed here.");
  });

  it("an override typed in the YAML tab is one operation per tool", () => {
    const { ops, refused } = yamlTabEdit(SRC, "Qwen", (y) =>
      y.concat(
        "chatOptions:\n  toolOverrides:\n    run_terminal_command:\n      disabled: true\n",
      ),
    );
    expect(refused).toEqual([]);
    expect(ops).toEqual([
      {
        path: ["chatOptions", "toolOverrides", "run_terminal_command"],
        value: { disabled: true },
      },
    ]);
  });
});

describe("price field", () => {
  it("writes the four rates and removes the map with the last one", () => {
    const out = editModelBlockText(SRC, "Qwen", [
      { path: ["pricing", "input"], value: 0 },
      { path: ["pricing", "output"], value: 0 },
    ]).text!;
    expect(entryOf(out).pricing).toEqual({ input: 0, output: 0 });
    const gone = editModelBlockText(out, "Qwen", [
      { path: ["pricing", "input"] },
      { path: ["pricing", "output"] },
    ]).text!;
    expect(entryOf(gone).pricing).toBeUndefined();
  });

  it("refuses a negative rate", () => {
    expect(validateFieldValue(["pricing", "cacheRead"], -1)).toBe(
      "Must be 0 or more.",
    );
  });
});

describe("Bedrock and Azure settings", () => {
  it("offers exactly the cross-region values Bedrock applies", () => {
    expect([...CROSS_REGION_VALUES]).toEqual([
      "auto",
      ...INFERENCE_PROFILE_PREFIXES,
    ]);
  });

  it.each([
    [["env", "serviceTier"], "priority", undefined],
    [["env", "serviceTier"], "turbo", /^Choose one of: default, priority/],
    [["env", "latency"], "optimized", undefined],
    [["env", "crossRegionInference"], "eu", undefined],
    [["env", "guardrailIdentifier"], "gr-abc123", undefined],
    [["env", "guardrailVersion"], "1", undefined],
    [["env", "deploymentId"], "dep-1", undefined],
    [["env", "apiVersion"], "2024-10-21", undefined],
  ])("%j = %j", (path, value, message) => {
    const m = validateFieldValue(path, value);
    if (message) expect(m).toMatch(message);
    else expect(m).toBeUndefined();
  });

  it("takes AWS credentials only as secret references", () => {
    for (const key of ["accessKeyId", "secretAccessKey", "sessionToken"]) {
      expect(fieldFor(["env", key])?.kind).toBe("secretRef");
      expect(validateFieldValue(["env", key], "AKIAPLAIN")).toMatch(
        /is a credential and is never written into config.yaml/,
      );
      expect(
        validateFieldValue(["env", key], "${{ secrets.AWS_KEY }}"),
      ).toBeUndefined();
    }
  });

  it("writes the Bedrock settings under env and keeps the comment there", () => {
    const out = editModelBlockText(SRC, "Claude", [
      { path: ["env", "serviceTier"], value: "flex" },
      { path: ["env", "latency"], value: "optimized" },
      { path: ["env", "crossRegionInference"], value: "auto" },
      { path: ["env", "guardrailIdentifier"], value: "gr-1" },
      { path: ["env", "guardrailVersion"], value: "2" },
    ]).text!;
    expect(entryOf(out, 1).env).toMatchObject({
      region: "us-east-1",
      serviceTier: "flex",
      latency: "optimized",
      crossRegionInference: "auto",
      guardrailIdentifier: "gr-1",
      guardrailVersion: "2",
      secretAccessKey: "plain-aws-secret",
    });
    expect(out).toContain("region: us-east-1 # home region");
  });
});
