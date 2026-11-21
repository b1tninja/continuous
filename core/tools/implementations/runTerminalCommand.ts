import childProcess from "node:child_process";
import os from "node:os";
import { decodeCommandOutput } from "../../util/commandOutput";
import {
  COMMAND_STDIO,
  commandEnvironment,
  spawnAgentCommand,
} from "../../util/commandSpawn";
import { ContinueError, ContinueErrorReason } from "../../util/errors";
import { resolveRequestedCwd } from "./terminalCwd";

// Default timeout for terminal commands (2 minutes)
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

/**
 * After a kill, how long to wait for the process's streams to close before
 * the call is finished anyway. A child of the shell (a pipeline, a test run)
 * can outlive it and keep the pipes open, and a call that waits for them
 * would stay "running" for ever.
 */
export const FORCE_FINISH_AFTER_KILL_MS = 3_000;

/** How long after the shell exits to wait for its streams before finishing. */
export const EXIT_GRACE_MS = 2_000;

// Ends the process and everything it started (taskkill /T on Windows)
export { killProcessTree };

/** At most one view update per command this often, carrying only the end. */
export const VIEW_UPDATE_MS = 100;

/** Stops listening to a process whose streams will not close. */
function releaseStreams(child: childProcess.ChildProcess): void {
  child.stdout?.destroy?.();
  child.stderr?.destroy?.();
}

// UTF-8, or on Windows the machine's OEM code page when the bytes are not UTF-8
function getDecodedOutput(data: Buffer): string {
  return decodeCommandOutput(data);
}

/**
 * Starts the command through the executor: Windows PowerShell on Windows, the
 * login shell elsewhere, bash in WSL or a container, started from the
 * workspace folder (which a container mounts). PowerShell is asked for the
 * exit code the command's own program chose.
 */
function startCommand(
  command: string,
  options: childProcess.SpawnOptions,
): Promise<childProcess.ChildProcess> {
  return spawnAgentCommand(getCommandExecutor(), command, options);
}

import { fileURLToPath, pathToFileURL } from "node:url";
import { ToolImpl } from ".";
import { getCommandExecutor } from "../../util/commandExecutor";
import {
  appendChunk,
  CaptureState,
  modelText,
  newCapture,
  outputStats,
  RunawayAction,
  runawayMessage,
  RunawayReason,
  viewText,
} from "../../util/commandOutputBuffer";
import { hasAnsi, stripAnsi } from "../../util/ansi";
import {
  CommandRecord,
  finishCommand,
  recordOutput,
  registerCommand,
} from "../../util/commandOutputStore";
import { killProcessTree } from "../../util/killProcessTree";
import {
  isProcessBackgrounded,
  killCommandsOnExit,
  markProcessAsRunning,
  removeBackgroundedProcess,
  removeRunningProcess,
} from "../../util/processTerminalStates";
import { executionShell, LOCAL_REMOTE_NAMES } from "../../util/shell";
import { terminalEnvironment } from "../../util/terminalEnvironment";
import { getBooleanArg, getStringArg } from "../parseArgs";
import { commandLintGate } from "../permissions/commandLint";
import { missingBinaryGate } from "../permissions/missingBinaryGate";

/**
 * Where a call runs: the folder asked for with `cwd` when it is a workspace
 * folder or inside one, otherwise the workspace's first folder. The same
 * facts the permission layer reads (effectiveCwdForPolicy).
 */
export function workingDirectoryFor(
  workspaceDirs: string[],
  requested: unknown,
) {
  const defaultCwd = resolveWorkingDirectory(workspaceDirs);
  const roots = workspaceDirs
    .filter((d) => d.startsWith("file:/"))
    .flatMap((d) => {
      try {
        return [fileURLToPath(d)];
      } catch {
        return [];
      }
    });
  return resolveRequestedCwd(requested, {
    defaultCwd,
    workspaceRoots: roots.length ? roots : [defaultCwd],
  });
}

/**
 * Resolves the working directory from workspace dirs.
 * Falls back to home directory or temp directory if no workspace is available.
 */
function resolveWorkingDirectory(workspaceDirs: string[]): string {
  // Handle file:// URIs (local workspaces)
  const fileWorkspaceDir = workspaceDirs.find((dir) =>
    dir.startsWith("file:/"),
  );
  if (fileWorkspaceDir) {
    try {
      return fileURLToPath(fileWorkspaceDir);
    } catch {
      // fileURLToPath can fail on malformed URIs or in some remote environments
      // Fall through to default handling
    }
  }

  // Handle other URI schemes (vscode-remote://wsl, vscode-remote://ssh-remote, etc.)
  const remoteWorkspaceDir = workspaceDirs.find(
    (dir) => dir.includes("://") && !dir.startsWith("file:/"),
  );
  if (remoteWorkspaceDir) {
    try {
      const url = new URL(remoteWorkspaceDir);
      return decodeURIComponent(url.pathname);
    } catch {
      // Fall through to other handlers
    }
  }

  // Default to user's home directory with fallbacks
  try {
    return process.env.HOME || process.env.USERPROFILE || process.cwd();
  } catch {
    // Final fallback if even process.cwd() fails - use system temp directory
    return os.tmpdir();
  }
}

// Add color-supporting environment variables
const getColorEnv = () => ({
  // Pagers that print and end: a command has no terminal to page in
  ...commandEnvironment(terminalEnvironment()),
  FORCE_COLOR: "1",
  COLORTERM: "truecolor",
  TERM: "xterm-256color",
  CLICOLOR: "1",
  CLICOLOR_FORCE: "1",
});

/** A foreground command: colours on, and no open standard input, so a prompt fails instead of waiting. */
const spawnOptions = (cwd: string): childProcess.SpawnOptions => ({
  cwd,
  env: getColorEnv(),
  stdio: COMMAND_STDIO,
});

// Only spawn processes locally when there is no remote workspace.
// With extensionKind: ["ui", "workspace"], the extension host almost always
// runs on the local machine. executor.spawn() executes on the extension
// host, so for any remote workspace it would run commands on the wrong machine
// (or fail with ENOENT when the local shell doesn't match the remote OS).
// All remote types delegate to ide.runCommand() which routes through VS Code's
// integrated terminal and executes in the correct remote environment.
const LOCAL_ONLY = LOCAL_REMOTE_NAMES;

/**
 * Why a command is not run: the place it should run in is not there (WSL asked
 * for and not installed, which never falls back to the host), or the lint.
 */
function commandBlocked(
  command: string,
  remoteName?: string,
): string | undefined {
  if (executionShell(remoteName).source === "terminal") {
    // The command goes to a remote window's terminal: this machine's shell
    // does not read it, so its dialect rules (no && in Windows PowerShell)
    // do not apply and nothing is started here that could be missing
    return commandLintGate(command, "unknown");
  }
  const executor = getCommandExecutor();
  return (
    executor.unavailable ??
    commandLintGate(command, executor.shell.kind) ??
    missingBinaryGate(command, executor)
  );
}

/** The Tools level's choice, as the tool call carried it; stop when unsaid. */
function runawayActionOf(value: string | undefined): RunawayAction {
  return value === RunawayAction.KeepRunning
    ? RunawayAction.KeepRunning
    : RunawayAction.Stop;
}

/**
 * The terminal item, with the meter's numbers and where the full output is.
 * `content` is what the model reads, so it has no terminal escape sequences.
 * `display` is the coloured text for the screen, present only when there was
 * colour to show.
 */
function terminalItem(
  content: string,
  status: string | undefined,
  record: CommandRecord,
  display?: string,
) {
  const plain = stripAnsi(content);
  const coloured = display ?? content;
  return {
    name: "Terminal",
    description: "Terminal command output",
    content: plain,
    ...(status === undefined ? {} : { status }),
    commandOutput: {
      id: record.id,
      ...(hasAnsi(coloured) ? { display: coloured } : {}),
      ...outputStats(record.capture),
      ...(record.outputPath
        ? {
            outputPath: record.outputPath,
            outputUri: pathToFileURL(record.outputPath).toString(),
          }
        : {}),
    },
  };
}

/**
 * What the model gets for a command that has finished. `keepAnsi` is the same
 * text with its colours, for the screen.
 */
function finalContent(
  record: CommandRecord,
  failed: boolean,
  keepAnsi = false,
): string {
  const text = modelText(record.capture, {
    failed,
    keepAnsi,
    outputPath: record.outputPath,
    commandId: record.id,
    limits: record.limits,
  });
  const stopped =
    record.stoppedFor && record.stoppedFor !== "stopped"
      ? `[Stopped by Continuous: ${runawayMessage(record.stoppedFor, record.capture, record.limits)}. The command and what it started were ended. If the output was expected, write it to a file or filter it instead of printing it all.]\n`
      : "";
  return stopped + text;
}

/** The result of a command the lint stopped: nothing ran. */
function commandNotRun(message: string) {
  return [
    {
      name: "Terminal",
      description: "Command not run",
      content: message,
      status: "Command not run",
    },
  ];
}

export const runTerminalCommandImpl: ToolImpl = async (args, extras) => {
  // Nothing the agent starts outlives the window
  killCommandsOnExit();
  const command = getStringArg(args, "command");
  // Default to waiting for completion if not specified
  const waitForCompletion =
    getBooleanArg(args, "waitForCompletion", false) ?? true;

  const ideInfo = await extras.ide.getIdeInfo();
  const toolCallId = extras.toolCallId || "";

  // Mistakes in how the command is written, before the shell reports them
  const lintMessage = commandBlocked(command, ideInfo.remoteName);
  if (lintMessage) {
    return commandNotRun(lintMessage);
  }

  if (LOCAL_ONLY.includes(ideInfo.remoteName)) {
    // For streaming output
    if (extras.onPartialOutput) {
      try {
        const workspaceDirs = await extras.ide.getWorkspaceDirs();
        const where = workingDirectoryFor(workspaceDirs, args.cwd);
        if (!where.ok) return commandNotRun(where.error);
        const cwd = where.cwd;

        if (!waitForCompletion) {
          const status = "Command is running in the background...";
          if (extras.onPartialOutput) {
            extras.onPartialOutput({
              toolCallId,
              contextItems: [
                {
                  name: "Terminal",
                  description: "Terminal command output",
                  content: "",
                  status: status,
                },
              ],
            });
          }
        }

        // Started with the color environment; a shell that cannot start
        // rejects here, as its "error" event did
        const childProc = await startCommand(command, spawnOptions(cwd));

        return new Promise((resolve, reject) => {
          // Bounded whatever the command prints (commandOutputBuffer.ts)
          const record = registerCommand({
            toolCallId,
            command,
            process: childProc,
            runawayAction: runawayActionOf(extras.runawayAction),
            background: !waitForCompletion,
          });
          // Once the call has returned nothing more is sent to the chat:
          // the tool message is part of the next request, and changing it
          // would break the prompt cache
          let returned = false;
          let stopping = false;
          let lastViewAt = 0;
          let viewTimeoutId: ReturnType<typeof setTimeout> | undefined;
          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          let sigkillTimeoutId: ReturnType<typeof setTimeout> | undefined;
          let forceTimeoutId: ReturnType<typeof setTimeout> | undefined;
          let exitTimeoutId: ReturnType<typeof setTimeout> | undefined;
          let timedOut = false;
          let finished = false;

          // Track this process for foreground cancellation
          if (toolCallId && waitForCompletion) {
            markProcessAsRunning(
              toolCallId,
              childProc,
              extras.onPartialOutput,
              "",
            );
          }

          // Check if the child process is still running.
          // `childProc.killed` only indicates that kill() was called,
          // not that the process has actually exited.
          const isRunning = () =>
            childProc.exitCode === null && childProc.signalCode === null;

          /** Ends the command and its children; the call finishes even if pipes stay open. */
          const endCommand = () => {
            killProcessTree(childProc, "SIGTERM");
            sigkillTimeoutId = setTimeout(() => {
              if (isRunning()) {
                killProcessTree(childProc, "SIGKILL");
              }
            }, 5_000);
            // A child holding the pipes open must not hold the call open
            forceTimeoutId = setTimeout(() => {
              releaseStreams(childProc);
              onDone(null);
            }, 5_000 + FORCE_FINISH_AFTER_KILL_MS);
          };

          // The chat view: the end of the output, at most every VIEW_UPDATE_MS
          const sendView = (status: string | undefined) => {
            lastViewAt = Date.now();
            extras.onPartialOutput?.({
              toolCallId,
              contextItems: [
                // The chat view draws colour, so it gets the escape sequences;
                // content, which a saved session keeps, does not have them
                terminalItem(
                  viewText(record.capture, record.limits),
                  status,
                  record,
                  viewText(record.capture, record.limits),
                ),
              ],
            });
          };
          const runningStatus = waitForCompletion
            ? ""
            : "Command is running in the background...";
          const scheduleView = () => {
            if (returned || finished || isProcessBackgrounded(toolCallId)) {
              return;
            }
            const wait = VIEW_UPDATE_MS - (Date.now() - lastViewAt);
            if (wait <= 0) {
              sendView(runningStatus);
            } else if (!viewTimeoutId) {
              viewTimeoutId = setTimeout(() => {
                viewTimeoutId = undefined;
                if (!returned && !finished) sendView(runningStatus);
              }, wait);
            }
          };

          // A flood or a loop: stopped, unless the Tools level lets it run.
          // A full output file always stops it.
          const checkRunaway = () => {
            if (stopping || finished) return;
            const reason = record.capture.runaway;
            if (!reason) return;
            if (
              reason !== RunawayReason.FileCap &&
              record.runawayAction === RunawayAction.KeepRunning
            ) {
              return;
            }
            stopping = true;
            record.stoppedFor = reason;
            if (timeoutId) clearTimeout(timeoutId);
            endCommand();
          };

          // Set up timeout for waitForCompletion mode
          if (waitForCompletion) {
            timeoutId = setTimeout(() => {
              if (isRunning() && !stopping) {
                timedOut = true;
                stopping = true;
                recordOutput(
                  record,
                  "\n[Timeout: process killed after 2 minutes]\n",
                  0,
                );
                if (!returned && !isProcessBackgrounded(toolCallId)) {
                  sendView("Command timed out");
                }
                endCommand();
              }
            }, DEFAULT_TOOL_TIMEOUT_MS);
          }

          // Both streams, into one bounded capture. A command moved to the
          // background keeps its output (for read_command_output) but sends
          // nothing more to the chat.
          const onData = (data: Buffer) => {
            if (finished) return;
            recordOutput(record, getDecodedOutput(data), data.length);
            checkRunaway();
            scheduleView();
          };
          childProc.stdout?.on("data", onData);
          childProc.stderr?.on("data", onData);

          // If we don't need to wait for completion, resolve immediately
          if (!waitForCompletion) {
            returned = true;
            const status = "Command is running in the background...";
            resolve([
              terminalItem(
                `Command is running in the background (id ${record.id}). Its output is kept: read it with read_command_output, and end the command with stop_command.`,
                status,
                record,
              ),
            ]);
          }

          const onDone = (code: number | null) => {
            if (finished) return;
            finished = true;
            // Clear timeout on normal completion
            if (timeoutId) {
              clearTimeout(timeoutId);
            }

            // Clear inner SIGKILL timeout if process exits before grace period
            if (sigkillTimeoutId) {
              clearTimeout(sigkillTimeoutId);
            }
            if (forceTimeoutId) clearTimeout(forceTimeoutId);
            if (exitTimeoutId) clearTimeout(exitTimeoutId);
            if (viewTimeoutId) clearTimeout(viewTimeoutId);
            finishCommand(record, code, undefined, {
              signal: childProc.signalCode,
              timedOut,
            });

            // Clean up process tracking
            if (toolCallId) {
              if (isProcessBackgrounded(toolCallId)) {
                removeBackgroundedProcess(toolCallId);
                return;
              }
              // Remove from foreground tracking if it was tracked
              removeRunningProcess(toolCallId);
            }

            // A background command already returned; its end is read with
            // read_command_output, not sent into a message already sent
            if (!waitForCompletion || returned) return;
            returned = true;
            if (record.stoppedFor && record.stoppedFor !== "stopped") {
              resolve([
                terminalItem(
                  finalContent(record, true),
                  "Command stopped: its output looked like a runaway",
                  record,
                  finalContent(record, true, true),
                ),
              ]);
            } else if (timedOut) {
              resolve([
                terminalItem(
                  finalContent(record, true),
                  "Command timed out",
                  record,
                  finalContent(record, true, true),
                ),
              ]);
            } else if (!code || code === 0) {
              resolve([
                terminalItem(
                  finalContent(record, false),
                  "Command completed",
                  record,
                  finalContent(record, false, true),
                ),
              ]);
            } else {
              resolve([
                terminalItem(
                  finalContent(record, true),
                  `Command failed with exit code ${code}`,
                  record,
                  finalContent(record, true, true),
                ),
              ]);
            }
          };

          childProc.on("close", onDone);
          // The shell is gone but something it started may hold the pipes:
          // finish shortly after the exit instead of waiting for them
          childProc.on("exit", (code) => {
            if (!waitForCompletion || finished) return;
            exitTimeoutId = setTimeout(() => {
              releaseStreams(childProc);
              onDone(code);
            }, EXIT_GRACE_MS);
          });

          childProc.on("error", (error) => {
            finished = true;
            if (forceTimeoutId) clearTimeout(forceTimeoutId);
            if (exitTimeoutId) clearTimeout(exitTimeoutId);
            if (viewTimeoutId) clearTimeout(viewTimeoutId);
            finishCommand(record, null);
            // Clear timeout on error
            if (timeoutId) {
              clearTimeout(timeoutId);
            }

            // Clear SIGKILL timeout to prevent delayed kill after rejection
            if (sigkillTimeoutId) {
              clearTimeout(sigkillTimeoutId);
            }

            // Clean up process tracking
            if (toolCallId) {
              if (isProcessBackgrounded(toolCallId)) {
                removeBackgroundedProcess(toolCallId);
                return;
              }
              // Remove from foreground tracking if it was tracked
              removeRunningProcess(toolCallId);
            }

            reject(error);
          });
        });
      } catch (error: any) {
        throw error;
      }
    } else {
      // Fallback to non-streaming for older clients
      const workspaceDirs = await extras.ide.getWorkspaceDirs();
      const where = workingDirectoryFor(workspaceDirs, args.cwd);
      if (!where.ok) return commandNotRun(where.error);
      const cwd = where.cwd;

      if (waitForCompletion) {
        // Standard execution, waiting for completion
        try {
          // Same start as the streaming version; a shell that cannot start
          // is reported below, as its "error" event was
          const childProc = await startCommand(command, spawnOptions(cwd));
          const output = await new Promise<{ stdout: string; stderr: string }>(
            (resolve, reject) => {
              let timeoutId: ReturnType<typeof setTimeout> | undefined;
              let sigkillTimeoutId: ReturnType<typeof setTimeout> | undefined;
              let forceTimeoutId: ReturnType<typeof setTimeout> | undefined;
              let exitTimeoutId: ReturnType<typeof setTimeout> | undefined;
              let finished = false;

              // Track this process for foreground cancellation
              if (toolCallId) {
                markProcessAsRunning(toolCallId, childProc, undefined, "");
              }

              // Bounded, as in the streaming version
              let stdout: CaptureState = newCapture(Date.now());
              let stderr: CaptureState = newCapture(Date.now());
              const add = (state: CaptureState, data: Buffer | string) =>
                appendChunk(
                  state,
                  typeof data === "string" ? data : getDecodedOutput(data),
                  typeof data === "string" ? 0 : data.length,
                  Date.now(),
                );

              // Check if the child process is still running.
              // `childProc.killed` only indicates that kill() was called,
              // not that the process has actually exited.
              const isRunning = () =>
                childProc.exitCode === null && childProc.signalCode === null;

              // Set up timeout
              timeoutId = setTimeout(() => {
                if (isRunning()) {
                  stderr = add(
                    stderr,
                    "\n[Timeout: process killed after 2 minutes]\n",
                  );

                  // Try graceful termination first
                  killProcessTree(childProc, "SIGTERM");

                  // Force kill after 5 seconds if still running
                  sigkillTimeoutId = setTimeout(() => {
                    if (isRunning()) {
                      killProcessTree(childProc, "SIGKILL");
                    }
                  }, 5_000);

                  // A child holding the pipes open must not hold the call open
                  forceTimeoutId = setTimeout(() => {
                    releaseStreams(childProc);
                    onDone(null);
                  }, 5_000 + FORCE_FINISH_AFTER_KILL_MS);
                }
              }, DEFAULT_TOOL_TIMEOUT_MS);

              childProc.stdout?.on("data", (data) => {
                stdout = add(stdout, data);
              });

              childProc.stderr?.on("data", (data) => {
                stderr = add(stderr, data);
              });

              const onDone = (code: number | null) => {
                if (finished) return;
                finished = true;
                if (forceTimeoutId) clearTimeout(forceTimeoutId);
                if (exitTimeoutId) clearTimeout(exitTimeoutId);
                // Clear outer timeout
                if (timeoutId) {
                  clearTimeout(timeoutId);
                }

                // Clear inner SIGKILL timeout if process exits before grace period
                if (sigkillTimeoutId) {
                  clearTimeout(sigkillTimeoutId);
                }

                // Clean up process tracking
                if (toolCallId) {
                  removeRunningProcess(toolCallId);
                }

                if (code === 0) {
                  resolve({
                    stdout: modelText(stdout, { failed: false }),
                    stderr: modelText(stderr, { failed: true }),
                  });
                } else {
                  const error = new ContinueError(
                    ContinueErrorReason.CommandExecutionFailed,
                    `Command failed with exit code ${code}`,
                  );
                  (error as any).stderr = modelText(stderr, { failed: true });
                  reject(error);
                }
              };

              childProc.on("close", onDone);
              childProc.on("exit", (code) => {
                if (finished) return;
                exitTimeoutId = setTimeout(() => {
                  releaseStreams(childProc);
                  onDone(code);
                }, EXIT_GRACE_MS);
              });

              childProc.on("error", (error) => {
                finished = true;
                if (forceTimeoutId) clearTimeout(forceTimeoutId);
                if (exitTimeoutId) clearTimeout(exitTimeoutId);
                // Clear timeout on error
                if (timeoutId) {
                  clearTimeout(timeoutId);
                }

                // Clear SIGKILL timeout to prevent delayed kill after rejection
                if (sigkillTimeoutId) {
                  clearTimeout(sigkillTimeoutId);
                }

                // Clean up process tracking
                if (toolCallId) {
                  removeRunningProcess(toolCallId);
                }
                reject(error);
              });
            },
          );

          const status = "Command completed";
          return [
            {
              name: "Terminal",
              description: "Terminal command output",
              content: output.stdout ?? "",
              status: status,
            },
          ];
        } catch (error: any) {
          const status = `Command failed with: ${error.message || error.toString()}`;
          return [
            {
              name: "Terminal",
              description: "Terminal command output",
              content: error.stderr ?? error.toString(),
              status: status,
            },
          ];
        }
      } else {
        // For non-streaming but also not waiting for completion, use spawn
        // but don't attach any listeners other than error
        try {
          // Use spawn with color environment
          const childProc = await startCommand(command, {
            cwd,
            env: getColorEnv(), // Add color environment
            // Detach the process so it's not tied to the parent
            detached: true,
            // Redirect to /dev/null equivalent (works cross-platform)
            stdio: "ignore",
          });

          // Even for detached processes, add event handlers to clean up the background process map
          childProc.on("close", () => {
            if (isProcessBackgrounded(toolCallId)) {
              removeBackgroundedProcess(toolCallId);
            }
          });

          childProc.on("error", () => {
            if (isProcessBackgrounded(toolCallId)) {
              removeBackgroundedProcess(toolCallId);
            }
          });

          // Unref the child to allow the Node.js process to exit
          childProc.unref();
          const status = "Command is running in the background...";
          return [
            {
              name: "Terminal",
              description: "Terminal command output",
              content: status,
              status: status,
            },
          ];
        } catch (error: any) {
          const status = `Command failed with: ${error.message || error.toString()}`;
          return [
            {
              name: "Terminal",
              description: "Terminal command output",
              content: status,
              status: status,
            },
          ];
        }
      }
    }
  }

  if (typeof args.cwd === "string" && args.cwd.trim() !== "") {
    return commandNotRun(
      "cwd is not supported in a remote window: start the command with cd instead.",
    );
  }
  return runInRemoteTerminal(extras.ide, command);
};

/**
 * For remote environments (SSH, WSL, Dev Container, Codespaces, etc.),
 * delegate to VS Code's integrated terminal which handles remote execution.
 * Note: output capture and waitForCompletion are not yet supported for remotes.
 */
async function runInRemoteTerminal(
  ide: Parameters<ToolImpl>[1]["ide"],
  command: string,
) {
  await ide.runCommand(command);
  return [
    {
      name: "Terminal",
      description: "Terminal command output",
      content:
        "Command executed in remote terminal. Output capture is not yet available for remote environments.",
      status: "Command executed",
    },
  ];
}
