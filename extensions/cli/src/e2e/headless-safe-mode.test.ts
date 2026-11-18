import fs from "fs/promises";
import path from "path";

import {
  cleanupTestContext,
  createTestContext,
  runCLI,
  type CLITestContext,
} from "../test-helpers/cli-helpers.js";
import {
  cleanupMockLLMServer,
  createMockLLMConfig,
  setupMockLLMTest,
  type MockLLMServer,
} from "../test-helpers/mock-llm-server.js";

/**
 * `cn -p --safe` against the built CLI: a broken hook settings file, a
 * project agent file, a rules folder, a config.yaml rule and an MCP server
 * are all left out, and the run still answers. Everything is under the test
 * folder; the home and global folders point there too.
 */
describe("E2E: --safe", () => {
  let context: CLITestContext;
  let mockServer: MockLLMServer;
  let env: Record<string, string>;
  let plainConfig: string;
  let brokenMcpConfig: string;

  beforeEach(async () => {
    context = await createTestContext();
    mockServer = await setupMockLLMTest(context, { response: "Hello World!" });
    const home = path.join(context.testDir, "home");
    const globalDir = path.join(home, ".continuous");
    await fs.mkdir(path.join(context.testDir, ".continuous", "rules"), {
      recursive: true,
    });
    await fs.mkdir(globalDir, { recursive: true });
    env = {
      HOME: home,
      USERPROFILE: home,
      CONTINUOUS_GLOBAL_DIR: globalDir,
      CONTINUE_GLOBAL_DIR: globalDir,
    };
    await fs.writeFile(
      path.join(globalDir, "settings.json"),
      '{ "hooks": { "PreToolUse": [ { "hooks": [ ',
    );
    await fs.writeFile(
      path.join(context.testDir, "AGENTS.md"),
      "AGENT-FILE-MARKER",
    );
    await fs.writeFile(
      path.join(context.testDir, ".continuous", "rules", "r.md"),
      "RULE-FILE-MARKER",
    );
    plainConfig = context.configPath!;
    await fs.writeFile(
      plainConfig,
      `${createMockLLMConfig(mockServer)}rules:
  - CONFIG-RULE-MARKER
`,
    );
    brokenMcpConfig = path.join(context.testDir, "broken-mcp.yaml");
    await fs.writeFile(
      brokenMcpConfig,
      `${createMockLLMConfig(mockServer)}rules:
  - CONFIG-RULE-MARKER
mcpServers:
  - name: missing
    command: definitely-not-a-real-program-xyz
`,
    );
  });

  afterEach(async () => {
    await cleanupMockLLMServer(mockServer);
    await cleanupTestContext(context);
  });

  const systemText = () =>
    JSON.stringify(
      mockServer.requests[0].body.messages.filter(
        (m: { role: string }) => m.role === "system",
      ),
    );

  it("reads the agent file, rules and config rules without --safe", async () => {
    const result = await runCLI(context, {
      args: ["-p", "--config", plainConfig, "Hi"],
      env,
      timeout: 20000,
    });
    expect(result.stdout).toContain("Hello World!");
    expect(result.stderr).not.toContain("Safe mode:");
    const text = systemText();
    expect(text).toContain("AGENT-FILE-MARKER");
    expect(text).toContain("RULE-FILE-MARKER");
    expect(text).toContain("CONFIG-RULE-MARKER");
  }, 30000);

  it("is stopped by an MCP server that cannot start, without --safe", async () => {
    const result = await runCLI(context, {
      args: ["-p", "--config", brokenMcpConfig, "Hi"],
      env,
      timeout: 20000,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("MCP server");
    expect(mockServer.requests).toHaveLength(0);
  }, 30000);

  it("starts without them, and without the MCP server, with --safe", async () => {
    const result = await runCLI(context, {
      args: ["-p", "--safe", "--auto", "--config", brokenMcpConfig, "Hi"],
      env,
      timeout: 20000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Hello World!");
    const notice = result.stderr
      .split(/\r?\n/)
      .filter((line) => line.startsWith("Safe mode:"));
    expect(notice).toHaveLength(1);
    expect(notice[0]).toContain("Ignored: --auto.");
    expect(result.stdout).not.toContain("Safe mode:");
    const text = systemText();
    expect(text).not.toContain("AGENT-FILE-MARKER");
    expect(text).not.toContain("RULE-FILE-MARKER");
    expect(text).not.toContain("CONFIG-RULE-MARKER");
  }, 30000);
});
