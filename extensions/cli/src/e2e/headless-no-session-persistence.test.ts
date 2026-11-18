import * as fs from "fs";
import * as path from "path";

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

/** Session files (`.json`, `.jsonl`) other than the list. */
function sessionFiles(globalDir: string): string[] {
  const dir = path.join(globalDir, "sessions");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(
      (f) =>
        (f.endsWith(".json") || f.endsWith(".jsonl")) && f !== "sessions.json",
    );
}

describe("E2E: -p --no-session-persistence (V11)", () => {
  let context: any;
  let mockServer: MockLLMServer;
  let globalDir: string;

  beforeEach(async () => {
    context = await createTestContext();
    mockServer = await setupMockLLMTest(context, {
      response: "Not kept.",
    });
    globalDir = path.join(context.testDir, ".continue");
  });

  afterEach(async () => {
    await cleanupMockLLMServer(mockServer);
    await cleanupTestContext(context);
  });

  it("answers and writes no session file", async () => {
    const result = await runCLI(context, {
      args: [
        "-p",
        "--no-session-persistence",
        "--config",
        context.configPath,
        "hello",
      ],
      env: {
        CONTINUE_CLI_TEST_SESSION_ID: "no-persist-1",
        CONTINUE_GLOBAL_DIR: globalDir,
      },
      timeout: 15000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Not kept.");
    expect(sessionFiles(globalDir)).toEqual([]);
    const list = path.join(globalDir, "sessions", "sessions.json");
    if (fs.existsSync(list)) {
      expect(fs.readFileSync(list, "utf8")).not.toContain("no-persist-1");
    }
  }, 30000);

  it("without the flag, the same run writes its session (the control)", async () => {
    const result = await runCLI(context, {
      args: ["-p", "--config", context.configPath, "hello"],
      env: {
        CONTINUE_CLI_TEST_SESSION_ID: "persist-1",
        CONTINUE_GLOBAL_DIR: globalDir,
      },
      timeout: 15000,
    });
    expect(result.exitCode).toBe(0);
    expect(sessionFiles(globalDir)).toHaveLength(1);
  }, 30000);

  it("is refused without -p", async () => {
    const result = await runCLI(context, {
      args: ["--no-session-persistence", "--config", context.configPath],
      env: { CONTINUE_GLOBAL_DIR: globalDir },
      timeout: 15000,
      expectError: true,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(
      "--no-session-persistence can only be used with -p/--print",
    );
  }, 30000);
});
