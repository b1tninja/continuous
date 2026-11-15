import { headlessLegacyAllow } from "./headlessPolicy.js";
import { ToolPermissionPolicy } from "./types.js";

/**
 * Default permission policies for all built-in tools.
 * These policies are applied in order - first match wins.
 *
 * A headless run takes the same lists as the terminal UI (CO2): Bash and
 * unlisted tools ask, and an ask is refused there because nobody can answer
 * it (headlessPolicy.ts). The old headless lists, which allowed Bash and
 * every unlisted tool, come back only with the one-release escape hatch
 * `CONTINUOUS_HEADLESS_LEGACY_ALLOW=1`.
 */
export function getDefaultToolPolicies(
  isHeadless = false,
  legacyHeadless: boolean = headlessLegacyAllow(),
): ToolPermissionPolicy[] {
  const policies: ToolPermissionPolicy[] = [
    // Write tools
    { tool: "Edit", permission: "ask" },
    { tool: "MultiEdit", permission: "ask" },
    { tool: "Write", permission: "ask" },
    { tool: "CheckBackgroundJob", permission: "allow" },
    { tool: "AskQuestion", permission: "allow" },
    { tool: "Checklist", permission: "allow" },
    { tool: "TaskList", permission: "allow" },
    // Loop mode's tools, offered only while the loop runs an item
    { tool: "HoldQuestion", permission: "allow" },
    { tool: "FinishItem", permission: "allow" },
    { tool: "RemindMe", permission: "allow" },
    { tool: "Diff", permission: "allow" },
    { tool: "Skills", permission: "allow" },
    { tool: "SearchTools", permission: "allow" },
    { tool: "Exit", permission: "allow" }, // Exit tool is generally safe (headless mode only)
    { tool: "Fetch", permission: "allow" }, // Technically not read only but edge casey to post w query params
    { tool: "List", permission: "allow" },
    { tool: "Read", permission: "allow" },
    { tool: "Search", permission: "allow" },
  ];

  // MCP and Bash ask, headless too; allowed headless only under the hatch
  if (isHeadless && legacyHeadless) {
    policies.push({ tool: "Bash", permission: "allow" });
    policies.push({ tool: "*", permission: "allow" });
  } else {
    policies.push({ tool: "Bash", permission: "ask" });
    policies.push({ tool: "*", permission: "ask" });
  }

  return policies;
}

// Plan mode: complete override. Reads are allowed; nothing that can change the
// workspace runs without asking. Write tools are excluded. Bash and MCP tools
// can write too, so they ask (and headless runs, with nobody to ask, are not
// offered them; see getRequestTools). PresentPlan writes only its own plan file
// under .continuous/plans and is offered in plan mode only.
export const PLAN_MODE_POLICIES: ToolPermissionPolicy[] = [
  { tool: "Edit", permission: "exclude" },
  { tool: "MultiEdit", permission: "exclude" },
  { tool: "Write", permission: "exclude" },

  { tool: "Bash", permission: "ask" },
  { tool: "PresentPlan", permission: "allow" },
  { tool: "CheckBackgroundJob", permission: "allow" },
  { tool: "AskQuestion", permission: "allow" },
  { tool: "Checklist", permission: "allow" },
  { tool: "TaskList", permission: "allow" },
  { tool: "Diff", permission: "allow" },
  { tool: "Exit", permission: "allow" },
  { tool: "Fetch", permission: "allow" },
  { tool: "List", permission: "allow" },
  { tool: "Read", permission: "allow" },
  { tool: "Search", permission: "allow" },
  { tool: "Skills", permission: "allow" },
  { tool: "SearchTools", permission: "allow" },

  // MCP tools and anything else not listed
  { tool: "*", permission: "ask" },
];

// Auto mode: Complete override - allow everything without asking
export const AUTO_MODE_POLICIES: ToolPermissionPolicy[] = [
  { tool: "*", permission: "allow" },
];
