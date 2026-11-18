import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { getCommandExecutor } from "./commandExecutor";

const output = async (
  started: ReturnType<ReturnType<typeof getCommandExecutor>["spawn"]>,
) => {
  const child = await started;
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.on("close", (code) => resolve({ code, out }));
  });
};

describe("getCommandExecutor", () => {
  it("is the machine's own shell by default", () => {
    const executor = getCommandExecutor({
      platform: "linux",
      env: { SHELL: "/bin/bash" },
    });
    expect(executor.kind).toBe("local");
    expect(executor.shell.kind).toBe("bash");
    expect(executor.invocation("ls")).toEqual({
      shell: "/bin/bash",
      args: ["-l", "-c", "ls"],
    });
    expect(executor.describe()).toBe("bash on this machine");
  });

  it("reads PowerShell on a Windows host", () => {
    const executor = getCommandExecutor({ platform: "win32", env: {} });
    expect(executor.kind).toBe("local");
    expect(executor.shell.kind).toBe("powershell");
  });

  it("is WSL, with bash's grammar, when asked on Windows", () => {
    const executor = getCommandExecutor({
      platform: "win32",
      terminalShell: { kind: "wsl", distro: "Ubuntu" },
    });
    expect(executor.kind).toBe("wsl");
    expect(executor.shell.kind).toBe("bash");
    expect(executor.invocation("echo hi").shell).toBe("wsl.exe");
    expect(executor.describe()).toContain("WSL");
  });

  it("an explicit default beats a WSL preference in the environment", () => {
    const executor = getCommandExecutor({
      platform: "win32",
      env: { CONTINUOUS_TERMINAL_SHELL: "wsl" },
      terminalShell: "default",
    });
    expect(executor.kind).toBe("local");
  });

  it("starts a command in the shell and returns its output and exit code", async () => {
    const executor = getCommandExecutor();
    const { code, out } = await output(
      executor.spawn("echo hello; exit 3", { stdio: "pipe" }),
    );
    expect(code).toBe(3);
    expect(out.trim()).toBe("hello");
  });
});

/** wsl.exe is on this machine and has a distribution to run in. */
const hasWsl =
  process.platform === "win32" &&
  spawnSync("wsl.exe", ["--", "true"], { timeout: 20000 }).status === 0;

describe.runIf(hasWsl)("the WSL executor (this machine's distribution)", () => {
  const wsl = () => getCommandExecutor({ terminalShell: { kind: "wsl" } });

  it("runs a command exactly as written", async () => {
    const { code, out } = await output(
      wsl().spawn(`cat <<'EOF'\n$HOME "x" 'y'\nEOF`, { stdio: "pipe" }),
    );
    expect(code).toBe(0);
    expect(out).toBe(`$HOME "x" 'y'\n`);
  });

  it("stops the process inside the distribution when the Windows side is killed", async () => {
    const marker = `sleep 4${Math.floor(Math.random() * 900 + 100)}`;
    const child = await wsl().spawn(marker, { stdio: "ignore" });
    // The checker's own shell mentions the marker once, so a running command is 2
    const running = () =>
      Number(
        execFileSync(
          "wsl.exe",
          ["--", "bash", "-c", `pgrep -f '${marker}' | wc -l`],
          { encoding: "utf8" },
        ).trim(),
      );
    await new Promise((r) => setTimeout(r, 3000));
    expect(running()).toBe(2);
    execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    await new Promise((r) => setTimeout(r, 1500));
    expect(running()).toBe(1);
  }, 30000);
});
