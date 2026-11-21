import { clearBashEndsForTests, takeBashEnd } from "../audit/bashExit.js";

import { runTerminalCommandTool } from "./runTerminalCommand.js";

const ESC = "\u001b";

/**
 * Two things about how Bash reports a command: the model reads its output
 * without terminal escape sequences (colours), and the audit trail is told
 * how it ended, including a command a signal ended (which has no exit code).
 */
describe("Bash output has no terminal escape sequences", () => {
  beforeEach(() => clearBashEndsForTests());

  const ctx = (id: string) => ({ toolCallId: id, parallelToolCallCount: 1 });

  // node -e with the escape written as a character code, so no shell quoting is involved
  const colourCommand = (text: string, code = 0) =>
    `node -e "process.stdout.write(String.fromCharCode(27)+'[31m${text}'+String.fromCharCode(27)+'[0m\\n'); process.exit(${code})"`;

  it("removes colour from the output the model reads", async () => {
    const out = await runTerminalCommandTool.run(
      { command: colourCommand("FAIL") },
      ctx("colour-1"),
    );
    expect(out).toContain("FAIL");
    expect(out).not.toContain(ESC);
    expect(out).not.toContain("[31m");
  });

  it("leaves plain output exactly as it was", async () => {
    const out = await runTerminalCommandTool.run(
      { command: `node -e "console.log('plain text')"` },
      ctx("plain-1"),
    );
    expect(out).toContain("plain text");
    expect(out).not.toContain(ESC);
  });

  it("removes colour from a failure that is thrown", async () => {
    await expect(
      runTerminalCommandTool.run(
        {
          command: `node -e "process.stderr.write(String.fromCharCode(27)+'[31mboom'+String.fromCharCode(27)+'[0m\\n'); process.exit(2)"`,
        },
        ctx("colour-fail"),
      ),
    ).rejects.toSatisfy((e: unknown) => {
      const text = String(e);
      return text.includes("boom") && !text.includes(ESC);
    });
    expect(takeBashEnd("colour-fail")).toEqual({ exit: 2 });
  });

  it("still notes the exit code of a coloured command that failed quietly", async () => {
    const out = await runTerminalCommandTool.run(
      { command: colourCommand("nope", 4) },
      ctx("colour-quiet"),
    );
    expect(out).not.toContain(ESC);
    expect(takeBashEnd("colour-quiet")).toEqual({ exit: 4 });
  });
});

describe("Bash notes a command that a signal ended", () => {
  beforeEach(() => clearBashEndsForTests());

  const ctx = (id: string) => ({ toolCallId: id, parallelToolCallCount: 1 });

  // A process cannot be killed by a signal this way on Windows
  const posix = process.platform !== "win32";
  const itPosix = posix ? it : it.skip;

  itPosix(
    "a command that kills itself with SIGTERM is noted by its signal, with no exit code",
    async () => {
      await runTerminalCommandTool
        .run(
          { command: `node -e "process.kill(process.pid, 'SIGTERM')"` },
          ctx("sig-1"),
        )
        .catch(() => undefined);
      const end = takeBashEnd("sig-1");
      expect(end?.signal).toBe("SIGTERM");
      expect(end?.exit).toBeUndefined();
      expect(end?.timedOut).toBeUndefined();
    },
  );

  itPosix("a clean exit has no signal", async () => {
    await runTerminalCommandTool.run(
      { command: `node -e "process.exit(0)"` },
      ctx("sig-2"),
    );
    const end = takeBashEnd("sig-2");
    expect(end).toEqual({ exit: 0 });
    expect(end?.signal).toBeUndefined();
  });

  it("a code and no signal is just the code", async () => {
    await runTerminalCommandTool.run(
      { command: `node -e "process.exit(5)"` },
      ctx("sig-3"),
    );
    expect(takeBashEnd("sig-3")).toEqual({ exit: 5 });
  });
});
