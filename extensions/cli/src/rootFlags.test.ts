/**
 * Root flags that change what the agent may do must reach the subcommands that
 * start an agent. `continuous --policy careful serve` used to drop the policy
 * without a word, so the user believed a stricter policy applied.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const serve = vi.fn(async () => {});
const acp = vi.fn(async () => {});
const chat = vi.fn(async () => {});

vi.mock("./commands/serve.js", () => ({ serve }));
vi.mock("./commands/acp.js", () => ({ acp }));
vi.mock("./commands/chat.js", () => ({ chat }));
vi.mock("./util/stdin.js", () => ({ readStdinSync: () => null }));

async function run(...args: string[]) {
  // A fresh program each time: commander keeps parsed values between parses
  vi.resetModules();
  const { program } = await import("./index.js");
  await program.parseAsync(["node", "continuous", ...args]);
}

describe("root safety flags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes a root --policy to serve", async () => {
    await run("--policy", "careful", "serve");
    expect(serve).toHaveBeenCalledTimes(1);
    expect((serve.mock.calls[0] as unknown[])[1]).toMatchObject({
      policy: "careful",
    });
  });

  it("passes a root --trust-project-hooks to serve", async () => {
    await run("--trust-project-hooks", "serve");
    expect((serve.mock.calls[0] as unknown[])[1]).toMatchObject({
      trustProjectHooks: true,
    });
  });

  it("passes a root --policy to acp", async () => {
    await run("--policy", "tools=manual", "acp");
    expect((acp.mock.calls[0] as unknown[])[0]).toMatchObject({
      policy: "tools=manual",
    });
  });

  it("passes --policy to a -p run", async () => {
    await run("--policy", "careful", "-p", "hello");
    expect(chat).toHaveBeenCalledTimes(1);
    expect((chat.mock.calls[0] as unknown[])[1]).toMatchObject({
      policy: "careful",
      headless: true,
    });
  });
});
