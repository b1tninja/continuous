import { clearBashEndsForTests, takeBashEnd } from "../audit/bashExit.js";

import { runTerminalCommandTool } from "./runTerminalCommand.js";

/**
 * The Bash tool's own time limit (no output for a while): the command is
 * killed, and the audit trail is told it ended that way. It used to note
 * nothing, so a timed-out command left no outcome at all.
 */
describe("Bash notes a command that hit its time limit", () => {
  const saved = process.env.TEST_TERMINAL_TIMEOUT;

  // The limit is for silence, and starting the shell counts: through the shell
  // this tool uses, a bare node takes about a second on a slow machine. So a
  // command that has to finish gets a limit well above that, and only the
  // cases that must time out get a short one.
  const SHORT = "400";
  const LONG = "8000";
  const limit = (ms: string) => {
    process.env.TEST_TERMINAL_TIMEOUT = ms;
  };

  beforeEach(() => {
    clearBashEndsForTests();
    // the tool reads this only in a test run and only when no timeout is given
    limit(SHORT);
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.TEST_TERMINAL_TIMEOUT;
    else process.env.TEST_TERMINAL_TIMEOUT = saved;
  });

  const ctx = (id: string) => ({ toolCallId: id, parallelToolCallCount: 1 });

  it("a command that goes quiet past the limit is noted as timed out, by SIGTERM, with no exit code", async () => {
    const out = await runTerminalCommandTool.run(
      { command: `node -e "setTimeout(()=>{}, 30000)"` },
      ctx("timeout-1"),
    );
    expect(out).toContain("timed out");
    expect(takeBashEnd("timeout-1")).toEqual({
      signal: "SIGTERM",
      timedOut: true,
    });
  });

  it("the end is noted once, and only for that call", async () => {
    await runTerminalCommandTool.run(
      { command: `node -e "setTimeout(()=>{}, 30000)"` },
      ctx("timeout-2"),
    );
    expect(takeBashEnd("timeout-2")?.timedOut).toBe(true);
    expect(takeBashEnd("timeout-2")).toBeUndefined();
    expect(takeBashEnd("some-other-call")).toBeUndefined();
  });

  it("a command that finishes before the limit is not noted as timed out", async () => {
    limit(LONG);
    await runTerminalCommandTool.run(
      { command: `node -e "process.exit(0)"` },
      ctx("timeout-3"),
    );
    const end = takeBashEnd("timeout-3");
    expect(end).toEqual({ exit: 0 });
    expect(end?.timedOut).toBeUndefined();
  });
});
