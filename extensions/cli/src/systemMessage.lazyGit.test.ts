import { describe, expect, it, vi } from "vitest";

// Building the preamble must not start a git process. The system line is the
// renderer's platform sentence; the folder and the git state are gathered
// later, with the session, for the first user message.
const { execSync } = vi.hoisted(() => ({ execSync: vi.fn() }));
vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  execSync,
}));
vi.unmock("./systemMessage.js");

const { getBaseSystemMessage } = await import("./systemMessage.js");

const gitCalls = () =>
  execSync.mock.calls.filter(([command]) =>
    String(command).startsWith("git rev-parse"),
  );

describe("the system message's git check", () => {
  it("does not run when the module loads", () => {
    expect(gitCalls()).toHaveLength(0);
  });

  it("names the platform and no folder, and starts no git process", () => {
    const first = getBaseSystemMessage();
    const second = getBaseSystemMessage();
    expect(second).toBe(first);
    expect(gitCalls()).toHaveLength(0);
    expect(first).toContain("<env>");
    expect(first).toContain("Platform:");
    expect(first).not.toContain("Working directory:");
    expect(first).not.toContain("Is directory a git repo");
    expect(first).toContain(
      `The working folder, today's date and the git state are in a <context name="environment"> block in the first user message.`,
    );
  });
});
