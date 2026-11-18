import { execSync } from "child_process";

import type { ChatCompletionMessageParam } from "openai/resources.mjs";

/**
 * The facts about a session that change between two runs in the same folder:
 * the date and the git status. They used to sit in the system message, where
 * a changed working tree invalidated the cached prefix (tool list, system
 * text, AGENTS.md and rules) on every provider that caches it. They now go in
 * the first user message of the request, after the system checkpoint, so two
 * sessions started from the same config in the same folder read the same
 * cached prefix. Computed once per process, so the request is stable from
 * turn to turn; the stable facts (working directory, platform) stay in the
 * system message.
 */

function isGitRepo(): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Most changed files listed in the block, and most characters they may take. */
export const MAX_GIT_STATUS_LINES = 40;
export const MAX_GIT_STATUS_CHARS = 4000;

/**
 * The porcelain lines in a fixed order (by path text), cut at the line and
 * character caps with an explicit "... and N more changed files" line, so a
 * large working tree cannot bloat the first user message.
 */
export function capGitStatus(
  status: string,
  maxLines: number = MAX_GIT_STATUS_LINES,
  maxChars: number = MAX_GIT_STATUS_CHARS,
): string {
  const lines = status
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .sort((a, b) => {
      const [pa, pb] = [a.slice(3), b.slice(3)];
      if (pa !== pb) return pa < pb ? -1 : 1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  const kept: string[] = [];
  let chars = 0;
  for (const line of lines) {
    if (kept.length >= maxLines || chars + line.length + 1 > maxChars) break;
    kept.push(line);
    chars += line.length + 1;
  }
  const more = lines.length - kept.length;
  if (more > 0) kept.push(`... and ${more} more changed files`);
  return kept.join("\n");
}

function getGitStatus(): string {
  try {
    if (!isGitRepo()) {
      return "Not a git repository";
    }
    const result = execSync("git status --porcelain", {
      encoding: "utf-8",
      cwd: process.cwd(),
    });
    return capGitStatus(result) || "Working tree clean";
  } catch {
    return "Git status not available";
  }
}

export const ENVIRONMENT_BLOCK_OPEN = '<context name="environment">';
export const ENVIRONMENT_BLOCK_CLOSE = "</context>";

let block: string | undefined;

/** The block for this process, built on first use. */
export function environmentContextBlock(): string {
  if (block === undefined) {
    const today = new Date().toISOString().split("T")[0];
    block = `${ENVIRONMENT_BLOCK_OPEN}
Today's date: ${today}
Git status at the start of the session (a snapshot; it does not update during the conversation):
${getGitStatus()}
${ENVIRONMENT_BLOCK_CLOSE}`;
  }
  return block;
}

/** Forget the block, so the next request builds it again. For tests. */
export function resetEnvironmentContextBlock(): void {
  block = undefined;
}

/**
 * The request's messages with the environment block appended to the first
 * user message. Nothing is written back to the history: the block is added at
 * request time, like the task list block, so saved sessions do not carry it
 * and a resumed session gets the date and status of the run that resumed it.
 * Messages without a user message are returned as they are.
 */
export function withEnvironmentBlock(
  messages: ChatCompletionMessageParam[],
  environmentBlock: string = environmentContextBlock(),
): ChatCompletionMessageParam[] {
  const index = messages.findIndex((m) => m.role === "user");
  if (index === -1) return messages;
  const first = messages[index];
  const content = first.content;
  let appended: ChatCompletionMessageParam;
  if (typeof content === "string") {
    appended = {
      ...first,
      content: content ? `${content}\n\n${environmentBlock}` : environmentBlock,
    };
  } else if (Array.isArray(content)) {
    appended = {
      ...first,
      content: [...content, { type: "text", text: environmentBlock }],
    } as ChatCompletionMessageParam;
  } else {
    return messages;
  }
  return [...messages.slice(0, index), appended, ...messages.slice(index + 1)];
}
