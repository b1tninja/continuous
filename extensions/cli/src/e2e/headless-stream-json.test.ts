import fs from "fs";
import * as http from "http";
import path from "path";

import { z } from "zod";

import {
  cleanupTestContext,
  createTestContext,
  runCLI,
} from "../test-helpers/cli-helpers.js";
import {
  cleanupMockLLMServer,
  setupMockLLMTest,
  type MockLLMServer,
} from "../test-helpers/mock-llm-server.js";

const schema = z.fromJSONSchema(
  JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, "../../spec/stream-json.schema.json"),
      "utf-8",
    ),
  ),
);

const CANARY = "sk-ant-api03-CANARYCANARYCANARYCANARY0123456789";

function sse(res: http.ServerResponse, chunks: unknown[]) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

describe("E2E: -p --format stream-json", () => {
  let context: any;
  let mockServer: MockLLMServer | undefined;

  beforeEach(async () => {
    context = await createTestContext();
  });

  afterEach(async () => {
    if (mockServer) await cleanupMockLLMServer(mockServer);
    mockServer = undefined;
    await cleanupTestContext(context);
  });

  it("prints only schema-valid events: a tool call, its decision and result, then the answer", async () => {
    let requests = 0;
    mockServer = await setupMockLLMTest(context, {
      customHandler: (req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          if (req.method !== "POST" || req.url !== "/chat/completions") {
            res.writeHead(404);
            res.end();
            return;
          }
          requests++;
          if (requests === 1) {
            sse(res, [
              {
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_1",
                          type: "function",
                          function: {
                            name: "Read",
                            arguments: JSON.stringify({
                              filepath: `notes-${CANARY}.txt`,
                            }),
                          },
                        },
                      ],
                    },
                  },
                ],
              },
              { usage: { prompt_tokens: 10, completion_tokens: 5 } },
            ]);
          } else {
            sse(res, [
              {
                choices: [
                  { index: 0, delta: { content: `All done. ${CANARY}` } },
                ],
              },
              { usage: { prompt_tokens: 20, completion_tokens: 3 } },
            ]);
          }
        });
      },
    });

    const result = await runCLI(context, {
      args: [
        "-p",
        "--format",
        "stream-json",
        "--config",
        context.configPath,
        "read the notes",
      ],
      timeout: 20000,
    });

    const lines = result.stdout.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(3);
    const events = lines.map((l) => JSON.parse(l));
    for (const e of events) {
      expect(schema.safeParse(e).success, JSON.stringify(e)).toBe(true);
    }
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("init");
    expect(types.at(-1)).toBe("result");
    expect(types.filter((t) => t === "result")).toHaveLength(1);
    const use = types.indexOf("tool_use");
    const decision = types.indexOf("tool_decision");
    const toolResult = types.indexOf("tool_result");
    expect(use).toBeGreaterThan(0);
    expect(decision).toBeGreaterThan(use);
    expect(toolResult).toBeGreaterThan(decision);
    expect(types.filter((t) => t === "usage")).toHaveLength(2);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.at(-1)).toMatchObject({
      status: "success",
      exitCode: 0,
      numRequests: 2,
      numToolCalls: 1,
    });
    expect(events.at(-1).result).toContain("All done.");
    expect(result.stdout).not.toContain(CANARY);
    expect(result.exitCode).toBe(0);
  }, 30000);

  it("ends a stopped run with run_limit, then result with exit code 21", async () => {
    mockServer = await setupMockLLMTest(context, {
      customHandler: (req, res) => {
        req.on("data", () => {});
        req.on("end", () =>
          sse(res, [
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: `call_${Date.now()}`,
                        type: "function",
                        function: {
                          name: "Read",
                          arguments: '{"filepath":"a.txt"}',
                        },
                      },
                    ],
                  },
                },
              ],
            },
            { usage: { prompt_tokens: 10, completion_tokens: 5 } },
          ]),
        );
      },
    });

    const result = await runCLI(context, {
      args: [
        "-p",
        "--format",
        "stream-json",
        "--max-turns",
        "1",
        "--config",
        context.configPath,
        "go",
      ],
      timeout: 20000,
      expectError: true,
    });

    const events = result.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const types = events.map((e) => e.type);
    expect(types.at(-2)).toBe("run_limit");
    expect(events.at(-1)).toMatchObject({
      type: "result",
      status: "stopped",
      exitCode: 21,
    });
    expect(result.exitCode).toBe(21);
  }, 30000);
});

describe("E2E: headless exit codes", () => {
  let context: any;
  let mockServer: MockLLMServer | undefined;

  beforeEach(async () => {
    context = await createTestContext();
  });

  afterEach(async () => {
    if (mockServer) await cleanupMockLLMServer(mockServer);
    mockServer = undefined;
    await cleanupTestContext(context);
  });

  const answering = (text: string) => (req: any, res: any) => {
    req.on("data", () => {});
    req.on("end", () =>
      sse(res, [
        { choices: [{ index: 0, delta: { content: text } }] },
        { usage: { prompt_tokens: 5, completion_tokens: 2 } },
      ]),
    );
  };

  it("exits 6 when the answer does not match --output-schema, 0 when it does", async () => {
    const schemaPath = path.join(context.testDir, "s.json");
    fs.writeFileSync(
      schemaPath,
      JSON.stringify({
        type: "object",
        required: ["ok"],
        properties: { ok: { type: "boolean" } },
      }),
    );
    mockServer = await setupMockLLMTest(context, {
      customHandler: answering('{"ok":"yes"}'),
    });
    const bad = await runCLI(context, {
      args: [
        "-p",
        "--output-schema",
        schemaPath,
        "--config",
        context.configPath,
        "q",
      ],
      timeout: 20000,
      expectError: true,
    });
    expect(bad.exitCode).toBe(6);
    expect(bad.stdout).toContain('{"ok":"yes"}');
    expect(bad.stderr).toMatch(/does not match --output-schema/);

    await cleanupMockLLMServer(mockServer);
    mockServer = await setupMockLLMTest(context, {
      customHandler: answering('{"ok":true}'),
    });
    const good = await runCLI(context, {
      args: [
        "-p",
        "--output-schema",
        schemaPath,
        "--config",
        context.configPath,
        "q",
      ],
      timeout: 20000,
    });
    expect(good.exitCode).toBe(0);
  }, 45000);

  it("exits 2 on an unusable --output-schema file, before any model request", async () => {
    mockServer = await setupMockLLMTest(context, {
      customHandler: answering("{}"),
    });
    const result = await runCLI(context, {
      args: [
        "-p",
        "--format",
        "stream-json",
        "--output-schema",
        path.join(context.testDir, "missing.json"),
        "--config",
        context.configPath,
        "q",
      ],
      timeout: 20000,
      expectError: true,
    });
    expect(result.exitCode).toBe(2);
    const events = result.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(events.map((e) => e.type)).toEqual(["error", "result"]);
    expect(events[1]).toMatchObject({ status: "error", exitCode: 2 });
  }, 30000);

  it("exits 4 when the provider answers with an HTTP error", async () => {
    mockServer = await setupMockLLMTest(context, {
      customHandler: (req, res) => {
        req.on("data", () => {});
        req.on("end", () => {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                message: "Incorrect API key",
                type: "invalid_request_error",
              },
            }),
          );
        });
      },
    });
    const result = await runCLI(context, {
      args: [
        "-p",
        "--format",
        "stream-json",
        "--config",
        context.configPath,
        "q",
      ],
      timeout: 30000,
      expectError: true,
    });
    const events = result.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(events.at(-2)).toMatchObject({ type: "error", kind: "provider" });
    expect(events.at(-1)).toMatchObject({ type: "result", exitCode: 4 });
    expect(result.exitCode).toBe(4);
  }, 40000);
});
