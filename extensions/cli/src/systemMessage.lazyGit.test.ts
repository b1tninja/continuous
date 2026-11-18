import { describe, expect, it, vi } from "vitest";

// The git check behind "Is directory a git repo" used to run while the module
// loaded, so `cn --version` and `cn --help` paid for a git process. It now
// runs once, when the first prompt is built, against the folder the process
// started in.
const { execSync } = vi.hoisted(() => ({ execSync: vi.fn() }));
vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  execSync,
}));
vi.unmock("./systemMessage.js");

const startCwd = process.cwd();
const { getBaseSystemMessage, GIT_CHECK_TIMEOUT_MS } =
  await import("./systemMessage.js");

const gitCalls = () =>
  execSync.mock.calls.filter(([command]) =>
    String(command).startsWith("git rev-parse"),
  );

describe("the system message's git check", () => {
  it("does not run when the module loads", () => {
    expect(gitCalls()).toHaveLength(0);
  });

  it("runs once, in the starting folder, with a timeout", () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/somewhere/else");
    try {
      const first = getBaseSystemMessage();
      const second = getBaseSystemMessage();
      expect(second).toBe(first);
      expect(gitCalls()).toEqual([
        [
          "git rev-parse --is-inside-work-tree",
          { stdio: "ignore", cwd: startCwd, timeout: GIT_CHECK_TIMEOUT_MS },
        ],
      ]);
      // The folder named is the starting one, as when it was read at load
      expect(first).toContain(`Working directory: ${startCwd}\n`);
      expect(first).toContain("Is directory a git repo: true\n");
    } finally {
      cwdSpy.mockRestore();
    }
  });
});
