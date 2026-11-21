import { clearBashEndsForTests, takeBashEnd } from "../audit/bashExit.js";

import { runTerminalCommandTool } from "./runTerminalCommand.js";

/**
 * The Bash tool notes how a command ended, for the audit trail: the string it
 * returns or throws does not carry the code the command chose.
 */
describe("Bash notes the exit code for the audit", () => {
  beforeEach(() => clearBashEndsForTests());

  const ctx = (id: string) => ({
    toolCallId: id,
    parallelToolCallCount: 1,
  });

  it("a command that succeeds is noted with exit 0", async () => {
    await runTerminalCommandTool.run(
      { command: `node -e "process.exit(0)"` },
      ctx("ok-1"),
    );
    expect(takeBashEnd("ok-1")).toEqual({ exit: 0 });
  });

  it("a command that exits non-zero with nothing on stderr returns normally and is noted", async () => {
    const out = await runTerminalCommandTool.run(
      { command: `node -e "process.exit(3)"` },
      ctx("fail-quiet"),
    );
    expect(out).toBe("Exit code 3.");
    expect(takeBashEnd("fail-quiet")).toEqual({ exit: 3 });
  });

  it("a command that exits non-zero with stderr is rejected, and the real code is noted", async () => {
    await expect(
      runTerminalCommandTool.run(
        {
          command: `node -e "console.error('boom'); process.exit(7)"`,
        },
        ctx("fail-loud"),
      ),
    ).rejects.toContain("Exit code 7.");
    expect(takeBashEnd("fail-loud")).toEqual({ exit: 7 });
  });

  it("nothing is noted without a call id", async () => {
    await runTerminalCommandTool.run({ command: `node -e "process.exit(0)"` });
    expect(takeBashEnd("")).toBeUndefined();
  });
});
