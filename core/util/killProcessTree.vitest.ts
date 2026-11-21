import childProcess from "node:child_process";
import { describe, expect, it } from "vitest";
import { killProcessTree } from "./killProcessTree";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !alive(pid);
}

describe("killProcessTree", () => {
  // The real thing, not a mock: with `kill` before taskkill the shell is gone
  // when taskkill looks for its tree, and the command it started stays.
  it.runIf(process.platform === "win32")(
    "ends what the shell started on Windows",
    async () => {
      const shell = childProcess.spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          'node -e "console.log(process.pid); setTimeout(() => {}, 60000)"',
        ],
        { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
      );
      const started = await new Promise<number>((resolve) =>
        shell.stdout!.once("data", (d) => resolve(Number(String(d).trim()))),
      );
      try {
        expect(alive(started)).toBe(true);
        killProcessTree(shell, "SIGTERM");
        expect(await waitUntilGone(started, 8_000)).toBe(true);
        expect(await waitUntilGone(shell.pid!, 2_000)).toBe(true);
      } finally {
        if (alive(started)) process.kill(started);
      }
    },
    20_000,
  );

  it("kills the process itself when it has no pid to find a tree by", () => {
    const signals: string[] = [];
    const child = {
      pid: undefined,
      kill: (signal: string) => signals.push(signal),
    } as unknown as childProcess.ChildProcess;
    killProcessTree(child, "SIGKILL");
    expect(signals).toEqual(["SIGKILL"]);
  });
});
