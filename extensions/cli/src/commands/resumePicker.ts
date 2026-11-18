import { safeStderr } from "../init.js";
import {
  type ExtendedSessionMetadata,
  getResumeSessionId,
  listSessionsForWorkspace,
  sessionExists,
  setResumeSessionId,
} from "../session.js";
import { gracefulExit } from "../util/exit.js";

export const RESUME_FLAG_HELP =
  "Resume a session: the one with this id, or choose one with the newest of this folder selected (with -p: the newest of this folder)";

/** What a session id looks like (a UUID), as opposed to a prompt. */
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ResumeArgument =
  | { sessionId: string; prompt: string | undefined }
  | { sessionId: undefined; prompt: string | undefined }
  | { error: string };

/**
 * The value given to `--resume <value>`. A saved session's id resumes that
 * session. Anything else that is not shaped like an id is the start of the
 * prompt, as it was before `--resume` took a value (`cn --resume "go on"`).
 * An id that no session has is an error, so a typo does not silently
 * resume some other conversation.
 */
export function resolveResumeArgument(
  value: string,
  prompt: string | undefined,
): ResumeArgument {
  const text = value.trim();
  if (text !== "" && sessionExists(text)) {
    return { sessionId: text, prompt };
  }
  if (SESSION_ID_PATTERN.test(text)) {
    return {
      error: `Error: no saved session has the id ${text}. \`continuous ls\` lists the sessions you can resume.`,
    };
  }
  const asPrompt = text === "" ? prompt : prompt ? `${text} ${prompt}` : text;
  return { sessionId: undefined, prompt: asPrompt };
}

/**
 * Shows the session picker (ui/SessionSelector.tsx) with `sessions` in the
 * order given; resolves with the chosen id, or null when the person leaves
 * it with Esc or Ctrl+D.
 */
export async function pickSession(
  sessions: ExtendedSessionMetadata[],
  title?: string,
): Promise<string | null> {
  const [{ render }, React, { SessionSelector }] = await Promise.all([
    import("ink"),
    import("react"),
    import("../ui/SessionSelector.js"),
  ]);
  return new Promise<string | null>((resolve) => {
    let done = false;
    const finish = (id: string | null) => {
      if (done) return;
      done = true;
      app.unmount();
      resolve(id);
    };
    const app = render(
      React.createElement(SessionSelector, {
        sessions,
        title,
        onSelect: (sessionId: string) => finish(sessionId),
        onExit: () => finish(null),
      }),
    );
  });
}

export type ResumeChoice = "chosen" | "cancelled" | "none";

/**
 * `--resume` without an id in a terminal: the sessions of this folder first,
 * its newest selected, so Enter resumes it and the person sees what they
 * resume. "none": there are no sessions at all (the caller starts a new
 * one); "cancelled": the person left the picker.
 */
export async function chooseSessionToResume(
  cwd: string = process.cwd(),
): Promise<ResumeChoice> {
  const sessions = await listSessionsForWorkspace(100, cwd);
  if (sessions.length === 0) {
    console.log("No previous sessions found; starting a new one.");
    return "none";
  }
  const chosen = await pickSession(sessions, "Resume a session");
  if (!chosen) return "cancelled";
  setResumeSessionId(chosen);
  return "chosen";
}

/** Whether `--resume` can ask which session: a terminal on both ends, nothing piped in. */
export function canPickInteractively(hasPipedInput: boolean): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && !hasPipedInput);
}

/**
 * `--resume` before the chat starts (index.ts). `--resume <value>`: the
 * session with that id, or the value is the prompt (`resolveResumeArgument`).
 * `--resume` alone in a terminal: the picker, the newest session of this
 * folder selected; Esc quits, and with no sessions at all a new one starts.
 * Headless (`-p`) runs choose nothing here: `loadSession` takes the newest
 * session of this folder. Answers the prompt to send.
 */
export async function prepareResume(
  options: { resume?: boolean | string; print?: boolean },
  prompt: string | undefined,
): Promise<string | undefined> {
  if (typeof options.resume === "string") {
    const resolved = resolveResumeArgument(options.resume, prompt);
    if ("error" in resolved) {
      safeStderr(`${resolved.error}\n`);
      await gracefulExit(1);
      return prompt;
    }
    if (resolved.sessionId) setResumeSessionId(resolved.sessionId);
    prompt = resolved.prompt;
    options.resume = true;
  }
  const hasPipedInput = Boolean(
    (options as { hasPipedInput?: boolean }).hasPipedInput,
  );
  if (
    options.resume &&
    !options.print &&
    !getResumeSessionId() &&
    canPickInteractively(hasPipedInput)
  ) {
    const choice = await chooseSessionToResume();
    if (choice === "cancelled") await gracefulExit(0);
    if (choice === "none") options.resume = false;
  }
  return prompt;
}
