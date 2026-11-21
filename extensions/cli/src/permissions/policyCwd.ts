import { effectiveCwdForPolicy } from "core/tools/implementations/terminalCwd.js";

/**
 * The folder a call is judged from. A Bash call that was given `cwd` runs
 * there, so a relative path in its command is read from there. Every other
 * call runs where the CLI was started.
 */
export function policyCwd(
  input: { cwd?: string; cliToolName?: string },
  parsedArgs: Record<string, unknown>,
): string {
  const base = input.cwd ?? process.cwd();
  if (input.cliToolName === "Bash") {
    return effectiveCwdForPolicy(parsedArgs?.cwd, {
      defaultCwd: base,
      workspaceRoots: [base],
    });
  }
  return base;
}
