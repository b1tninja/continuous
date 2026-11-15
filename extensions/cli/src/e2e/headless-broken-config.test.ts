import fs from "fs/promises";
import path from "path";

import {
  cleanupTestContext,
  createTestConfig,
  createTestContext,
  runCLI,
} from "../test-helpers/cli-helpers.js";

const CONFIG = `name: Test Assistant
version: 1.0.0
schema: v1
models:
  - model: gpt-4
    provider: openai
    apiKey: test-key
    roles:
      - chat`;

describe("E2E: Headless Mode - broken hook settings or permissions file", () => {
  let context: any;

  beforeEach(async () => {
    context = await createTestContext();
    await createTestConfig(context, CONFIG);
  });

  afterEach(async () => {
    await cleanupTestContext(context);
  });

  const run = (extra: string[] = []) =>
    runCLI(context, {
      args: ["-p", "--config", context.configPath, ...extra, "Hello"],
      env: { OPENAI_API_KEY: "test-key" },
      expectError: true,
      timeout: 15000,
    });

  it("exits 2 naming the file and the position when ~/.claude/settings.json is broken", async () => {
    const dir = path.join(context.testDir, ".claude");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "settings.json");
    await fs.writeFile(file, '{ "apiKey": "sk-canary-value",\n}');

    const result = await run();

    expect(result.exitCode).toBe(2);
    const output = result.stderr + result.stdout;
    expect(output).toContain("settings.json");
    expect(output).toMatch(/not valid JSON at line 2, column 1/);
    expect(output).toContain("--ignore-broken-config");
    expect(output).not.toContain("sk-canary-value");
  });

  it("exits 2 when permissions.yaml is broken", async () => {
    const dir = path.join(context.testDir, ".continuous");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "permissions.yaml"), "allow: [Read\n");

    const result = await run();

    expect(result.exitCode).toBe(2);
    expect(result.stderr + result.stdout).toContain("permissions.yaml");
  });

  it("goes on past the check with --ignore-broken-config", async () => {
    const dir = path.join(context.testDir, ".claude");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "settings.json"), "{");

    const result = await run(["--ignore-broken-config"]);

    // It fails later (no real model; with the exit-code table that is also code 2, config),
    // so the check is that the broken-file refusal is absent, not the code
    const output = result.stderr + result.stdout;
    expect(output).not.toContain("Cannot start");
  });

  it("does not refuse when no policy file exists", async () => {
    const result = await run();
    expect(result.stderr + result.stdout).not.toContain("Cannot start");
  });
});
