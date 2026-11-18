import childProcess from "node:child_process";

/**
 * Ends a process and everything it started. `kill` on Windows ends only the
 * shell, so its children go on running and holding the pipes; taskkill /T
 * takes the whole tree.
 */
export function killProcessTree(
  child: childProcess.ChildProcess,
  signal: NodeJS.Signals,
): void {
  child.kill(signal);
  if (process.platform === "win32" && child.pid) {
    try {
      const killer = childProcess.spawn(
        "taskkill",
        ["/pid", String(child.pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true },
      );
      killer?.on?.("error", () => undefined);
    } catch {
      // The shell is already killed; the caller's forced finish covers the rest
    }
  }
}

/** A process Node started, not a stand-in (tests pass plain objects). */
export function isStartedProcess(child: unknown): boolean {
  const ChildProcessClass = (childProcess as { ChildProcess?: unknown })
    .ChildProcess;
  return (
    typeof ChildProcessClass === "function" &&
    child instanceof (ChildProcessClass as typeof childProcess.ChildProcess)
  );
}

/**
 * Ends a process tree, for when there is no time to wait: the host is
 * exiting. Synchronous, so it finishes before the process does.
 */
export function killProcessTreeNow(child: childProcess.ChildProcess): void {
  try {
    if (process.platform === "win32" && child.pid) {
      childProcess.spawnSync(
        "taskkill",
        ["/pid", String(child.pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true, timeout: 2_000 },
      );
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    // Nothing more can be done while exiting
  }
}
