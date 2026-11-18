/**
 * The literal openings of the parts constructSystemMessage appends after the
 * preamble, in order. The builder writes them and the prompt-segment manifest
 * (src/promptSegments.ts) finds them, so the two cannot drift apart.
 */
export const SYSTEM_MARKERS = {
  plan: '\n<context name="planMode">\n',
  agent: '\n<context name="agentMode">\n',
  commit: '\n<context name="attribution">',
  headless: "\n\nIMPORTANT: You are running in headless mode.",
  json: "\n\nIMPORTANT: You are operating in JSON output mode.",
  rules: '\n\n<context name="userRules">',
} as const;
