/**
 * The sentences a model reads when a call is refused or held, for the IDE and
 * the CLI. They were written out in each place that refuses (three copies of
 * the carry-on tail, two wordings of "the person said no"), and drifted.
 *
 * Each says what happened, then what to do next. None tells the model to stop
 * and ask: whether the turn ends is the harness's decision (the refusal cap),
 * not the prose's (plans/policy-areas.md, "Decision order"). None says to
 * "try something else": a model that reads a refusal as a hint to route
 * around it does exactly that.
 */

/** The second half of a refusal: no retry, no detour, finish the rest. */
const carryOn =
  "Do not retry this call or reach the same result another way. Do what else the request needs, then say what you could not do and why.";

/** After a reviewer model's refusal: a safer route to the same end is allowed. */
const carryOnSaferRoute =
  "Do not retry this call or reach the same result another way. Find a safer route to the same end if one exists; otherwise do what else the request needs, then say what you could not do and why.";

/** After a call to a tool the person turned off. */
const carryOnToolOff =
  "Do not work around this. Do what else the request needs, then say what you could not do and why.";

/** After a call to a tool the mode's role may not use. */
const carryOnOtherTools =
  "Do not retry it or reach the same result another way. Use the tools you were given, then say what you could not do.";

export const refusalText = {
  carryOn,
  carryOnSaferRoute,
  carryOnToolOff,
  carryOnOtherTools,

  /** The person answered no when asked about the call. */
  declined: (toolName: string): string =>
    `The person declined ${toolName}, so it was not run. ${carryOn}`,

  /** Whether a result is `declined`'s, for a surface that shows it in short. */
  isDeclined: (result: string): boolean =>
    /^The person declined \S+, so it was not run\./.test(result),

  /**
   * The tool is excluded for the run (the CLI's `--exclude`, or an exclude
   * rule that gave no reason).
   */
  excluded: (toolName: string): string =>
    `${toolName} is excluded for this run, so it was not run. ${carryOn}`,

  /** A rule, a protected path or a reviewer refused, and said why (CLI). */
  blockedByPolicy: (reason: string): string =>
    `Command blocked by security policy: ${reason} ${carryOn}`,

  /** A reviewer model refused the call (IDE). */
  reviewerRefused: (
    command: string,
    reason: string | undefined,
    category?: string,
  ): string =>
    `A reviewer model refused this call${category ? ` (${category})` : ""}: ${reason ?? "no reason given"}\n\n${command}\n\n${carryOnSaferRoute}`,

  /** One of the person's deny rules matched (IDE). */
  denyRule: (command: string, reason: string | undefined): string =>
    `${reason ?? "Blocked by a rule in the user's config.yaml."}\n\n${command}\n\n${carryOn}`,

  /** The tool is turned off in the person's tool settings (IDE). */
  toolOff: (command: string, reason: string | undefined): string =>
    `${reason ?? "This tool is turned off in the user's tool settings."}\n\n${command}\n\n${carryOnToolOff}`,

  /**
   * Loop mode: a call that would ask when the item can hold no more
   * questions. The harness ends the item's run with this one result; the
   * questions already open are what wake it.
   */
  questionCapWaiting: (toolName: string, open: number): string =>
    `${toolName} needs the person's approval, so it was not run. This item already has ${open} questions open in their inbox, which is the limit, so its run ends here as waiting. The work so far and the open questions are kept. The item runs again once the person answers, and a call they allow then runs once without asking.`,

  /**
   * The same end with no question of the item open for the person (the
   * loop's own cap): nothing would wake a waiting item, so it ends as stuck.
   */
  questionCapStuck: (toolName: string): string =>
    `${toolName} needs the person's approval, so it was not run. The loop cannot hold another question, so this item's run ends here as stuck. The work so far is kept. The item runs again when the person answers or writes a note on it.`,

  /** Loop mode: a later call of the reply whose earlier call ended the run. */
  runEnded: (toolName: string): string =>
    `${toolName} was not run. An earlier call in this reply ended this item's run.`,

  /** Refused by policy with no source named (IDE). */
  disabledByPolicy: (command: string): string =>
    `This command has been disabled by security policy:\n\n${command}\n\n${carryOn}`,
} as const;
