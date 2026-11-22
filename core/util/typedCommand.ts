/**
 * The text the webview may have typed into the editor's terminal (the
 * `runCommand` message: a code block's Run button, the onboarding card).
 *
 * The editor types the text and leaves Enter to the person, so the message
 * itself runs nothing. That holds only for one line of plain text: a line
 * break runs what is before it, any other control character reaches the shell
 * as a key press (Ctrl-C, an escape sequence, tab completion), and a
 * direction override shows the person a command other than the one Enter
 * would run. The webview renders what models and web pages wrote, so the
 * editor checks the text; JetBrains has the same check
 * (WebviewIdeGate.typedCommandRefusal).
 */

/** Windows takes a command line of 8,191 characters; nothing longer is typed. */
export const MAX_TYPED_COMMAND_CHARS = 8_000;

// Control characters (C0, DEL, C1), the line and paragraph separators, and
// the marks that change the direction text is shown in
const NOT_TYPED =
  /[\p{Cc}\u2028\u2029\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

/** Why `command` is not typed into the terminal, or undefined when it may be. */
export function typedCommandRefusal(command: unknown): string | undefined {
  if (typeof command !== "string" || !command.trim()) {
    return "there is no command";
  }
  if (command.length > MAX_TYPED_COMMAND_CHARS) {
    return `it is longer than ${MAX_TYPED_COMMAND_CHARS} characters`;
  }
  if (NOT_TYPED.test(command)) {
    return "it has a line break or a control character";
  }
  return undefined;
}
