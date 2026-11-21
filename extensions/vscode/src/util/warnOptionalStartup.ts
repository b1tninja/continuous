/**
 * Log that an optional part of start-up was skipped, as one line that starts
 * with this extension's name. Continue.continue can be installed next to this
 * extension and prints similar errors, so an unnamed line cannot be told
 * apart from its lines, and a stack trace buries the cause.
 */
export function warnOptionalStartup(what: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split(/\r?\n/)[0].trim();
  console.warn(`Continuous: ${what}: ${firstLine}`);
}
