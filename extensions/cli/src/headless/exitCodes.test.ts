import fs from "fs";
import os from "os";
import path from "path";

import { describePromptBlocked } from "../hooks/promptHook.js";

import {
  classifyHeadlessFailure,
  configError,
  HEADLESS_EXIT_CODES,
} from "./exitCodes.js";
import {
  answerAsJson,
  loadOutputSchema,
  outputSchemaProblem,
} from "./outputSchema.js";

const DOC = path.resolve(__dirname, "../../../../docs/cli/exit-codes.mdx");

/** The rows of the first table in the page: code and name. */
function documentedCodes(): Array<[number, string]> {
  const rows: Array<[number, string]> = [];
  for (const line of fs.readFileSync(DOC, "utf-8").split("\n")) {
    const m = /^\|\s*(\d+)\s*\|\s*([a-z-]+)\s*\|/.exec(line);
    if (m) rows.push([Number(m[1]), m[2]]);
  }
  return rows;
}

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

describe("headless exit codes", () => {
  it("docs/cli/exit-codes.mdx lists exactly the codes in HEADLESS_EXIT_CODES", () => {
    const fromCode = Object.entries(HEADLESS_EXIT_CODES)
      .map(([name, code]) => [code, kebab(name)] as [number, string])
      .sort((a, b) => a[0] - b[0]);
    expect(documentedCodes()).toEqual(fromCode);
  });

  it("keeps the codes that existed before the table", () => {
    expect(HEADLESS_EXIT_CODES).toMatchObject({
      success: 0,
      error: 1,
      config: 2,
      secretsFound: 3,
      budget: 20,
      turns: 21,
      duration: 22,
      interrupted: 130,
    });
  });

  it.each([
    [configError("No models were found."), "config", 2],
    [new Error("Failed to load config: bad yaml"), "config", 2],
    [
      new Error("hub assistants are not supported; pass a config.yaml path"),
      "config",
      2,
    ],
    [new Error(describePromptBlocked("no secrets")), "refused", 5],
    [Object.assign(new Error("bad key"), { status: 401 }), "provider", 4],
    [
      new Error("x", { cause: Object.assign(new Error("y"), { status: 429 }) }),
      "provider",
      4,
    ],
    [new Error("Context length exceeded: too long"), "provider", 4],
    [
      new Error("fetch failed", {
        cause: Object.assign(new Error("getaddrinfo"), {
          code: "ENOTFOUND",
          hostname: "api.example.com",
        }),
      }),
      "provider",
      4,
    ],
    [new Error("something broke"), "internal", 1],
  ])("classifies %s", (error, kind, exitCode) => {
    expect(classifyHeadlessFailure(error)).toMatchObject({ kind, exitCode });
  });
});

describe("--output-schema", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-schema-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = (name: string, text: string) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    return file;
  };

  const schemaFile = () =>
    write(
      "s.json",
      JSON.stringify({
        type: "object",
        required: ["verdict"],
        properties: { verdict: { enum: ["approve", "changes"] } },
      }),
    );

  it("accepts a matching answer, bare or in one json fence", () => {
    const schema = loadOutputSchema(schemaFile());
    expect(
      outputSchemaProblem(schema, '{"verdict":"approve"}'),
    ).toBeUndefined();
    expect(
      outputSchemaProblem(schema, '```json\n{"verdict":"changes"}\n```'),
    ).toBeUndefined();
  });

  it("names the problem when the answer does not match or is not JSON", () => {
    const schema = loadOutputSchema(schemaFile());
    expect(outputSchemaProblem(schema, '{"verdict":"maybe"}')).toMatch(
      /does not match --output-schema .*verdict/,
    );
    expect(outputSchemaProblem(schema, "Looks good to me.")).toMatch(
      /not JSON/,
    );
    expect(answerAsJson("text then {}").ok).toBe(false);
  });

  it("a missing, non-JSON or unsupported schema file is a config error (exit 2)", () => {
    for (const file of [
      path.join(dir, "missing.json"),
      write("bad.json", "{not json"),
      write("odd.json", JSON.stringify({ type: "strin" })),
    ]) {
      let thrown: unknown;
      try {
        loadOutputSchema(file);
      } catch (e) {
        thrown = e;
      }
      expect(classifyHeadlessFailure(thrown)).toMatchObject({
        kind: "config",
        exitCode: 2,
      });
    }
  });
});
