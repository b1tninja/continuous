import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { testConnectionCommand } from "./testConnection.js";

const fetchFn = (async (url: string) => ({
  ok: url.endsWith("/models"),
  status: url.endsWith("/models") ? 200 : 500,
  json: async () => ({ data: [{ id: "m1" }] }),
  text: async () => "",
})) as never;

function capture() {
  const out: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    out.push(String(s));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    out.push(String(s));
    return true;
  });
  return out;
}

afterEach(() => vi.restoreAllMocks());

describe("testConnectionCommand", () => {
  it("needs a provider", async () => {
    const out = capture();
    expect(await testConnectionCommand({})).toBe(2);
    expect(out.join("")).toContain("--provider");
  });

  it("refuses a named key variable that is not set", async () => {
    capture();
    expect(
      await testConnectionCommand({
        provider: "openai",
        apiKeyEnv: "NOPE_KEY",
        env: {},
      }),
    ).toBe(2);
  });

  it("lists the models and exits 0", async () => {
    const out = capture();
    const code = await testConnectionCommand({
      provider: "lmstudio",
      fetchFn,
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("Connected. 1 model listed: m1");
  });

  it("exits 1 on failure and never prints the key", async () => {
    const out = capture();
    const code = await testConnectionCommand({
      provider: "openai",
      apiKeyEnv: "K",
      env: { K: "sk-secret" },
      fetchFn: (async () => ({
        ok: false,
        status: 401,
        json: async () => ({}),
        text: async () => "bad sk-secret",
      })) as never,
    });
    expect(code).toBe(1);
    expect(out.join("")).not.toContain("sk-secret");
  });
});

describe("testConnectionCommand recording and recovery hint", () => {
  const textFetch = (async (url: string) => ({
    ok: true,
    status: 200,
    json: async () =>
      url.endsWith("/models")
        ? { data: [{ id: "qwen3-coder" }] }
        : {
            choices: [
              {
                message: {
                  content:
                    "<tool_call>\n<function=echo_text>\n<parameter=text>\nq\n</parameter>\n<parameter=count>\n1\n</parameter>\n</function>\n</tool_call>",
                },
              },
            ],
          },
    text: async () => "",
  })) as never;
  const freshFile = () =>
    join(mkdtempSync(join(tmpdir(), "tc-")), "facts.json");

  it("records locally and prints a config snippet, changing nothing", async () => {
    const out = capture();
    const file = freshFile();
    const code = await testConnectionCommand({
      provider: "lmstudio",
      model: "qwen3-coder",
      fetchFn: textFetch,
      measuredFile: file,
    });
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain("Recorded locally (1 probe");
    expect(text).toContain("toolDialect: qwen-xml");
    expect(text).toContain("nothing was changed");
    expect(JSON.parse(readFileSync(file, "utf8")).entries).toHaveLength(1);
  });

  it("--no-record writes nothing", async () => {
    capture();
    const file = freshFile();
    await testConnectionCommand({
      provider: "lmstudio",
      model: "qwen3-coder",
      fetchFn: textFetch,
      measuredFile: file,
      record: false,
    });
    expect(existsSync(file)).toBe(false);
  });
});
