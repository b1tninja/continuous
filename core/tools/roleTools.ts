import { BuiltInToolNames } from "./builtIn";

/**
 * The role by tool table (plans/ROADMAP.md, Track TR, row TR1; plans/research/
 * tool-exposure-roles-prompts.md). One table, used twice:
 *
 *  - at EXPOSURE: the tool list a request carries holds only the tools the
 *    role may use (`filterToolsForRole`);
 *  - at EXECUTION: a call to a tool the role may not use is refused with an
 *    error result, whatever route it came by (`roleRefusal`). A model can emit
 *    the name of a tool it was never offered.
 *
 * Role gating only restricts. It never allows what the permission engine, the
 * user's tool settings or a mode's own rules refuse; it is applied after them
 * or beside them and can only remove a tool.
 */

/** What a tool does, in the terms a role is allowed or not. */
export const TOOL_CLASSES = [
  "read-fs",
  "search",
  "edit",
  "terminal",
  "network-fetch",
  /** An MCP tool the USER has marked read-only (see `PlanMcpTrust`) */
  "mcp-read-only",
  /** Every other MCP tool: a server's own read-only claim does not count */
  "mcp-other",
  "delegation",
  /** The session's own state: task list, plan, loop reports, tool search */
  "session",
  /** Writes a rule or asks for one */
  "rules",
  /** Not in the table: only a role that may use everything gets it */
  "unclassified",
] as const;
export type ToolClass = (typeof TOOL_CLASSES)[number];

export const TOOL_ROLES = [
  "chat",
  "agent",
  "background",
  "planner",
  "reviewer",
  "orchestrator",
] as const;
export type ToolRole = (typeof TOOL_ROLES)[number];

/** The IDE's built-in tools. Typed on the enum, so a new tool cannot compile without a row. */
export const BUILT_IN_TOOL_CLASS: Record<BuiltInToolNames, ToolClass> = {
  [BuiltInToolNames.ReadFile]: "read-fs",
  [BuiltInToolNames.ReadFileRange]: "read-fs",
  [BuiltInToolNames.ReadCurrentlyOpenFile]: "read-fs",
  [BuiltInToolNames.ViewDiff]: "read-fs",
  [BuiltInToolNames.LSTool]: "read-fs",
  [BuiltInToolNames.ReadSkill]: "read-fs",
  [BuiltInToolNames.ViewRepoMap]: "read-fs",
  [BuiltInToolNames.ViewSubdirectory]: "read-fs",
  [BuiltInToolNames.GrepSearch]: "search",
  [BuiltInToolNames.FileGlobSearch]: "search",
  [BuiltInToolNames.CodebaseTool]: "search",
  [BuiltInToolNames.CodeNavigation]: "search",
  [BuiltInToolNames.EditExistingFile]: "edit",
  [BuiltInToolNames.SingleFindAndReplace]: "edit",
  [BuiltInToolNames.MultiEdit]: "edit",
  [BuiltInToolNames.CreateNewFile]: "edit",
  [BuiltInToolNames.RunTerminalCommand]: "terminal",
  [BuiltInToolNames.SearchWeb]: "network-fetch",
  [BuiltInToolNames.FetchUrlContent]: "network-fetch",
  [BuiltInToolNames.Subagent]: "delegation",
  [BuiltInToolNames.TaskList]: "session",
  [BuiltInToolNames.PresentPlan]: "session",
  [BuiltInToolNames.HoldQuestion]: "session",
  [BuiltInToolNames.FinishItem]: "session",
  [BuiltInToolNames.RemindMe]: "session",
  [BuiltInToolNames.RecallMaskedResult]: "session",
  [BuiltInToolNames.SearchTools]: "session",
  [BuiltInToolNames.ListSessions]: "session",
  [BuiltInToolNames.SendMessage]: "delegation",
  [BuiltInToolNames.CreateRuleBlock]: "rules",
  [BuiltInToolNames.RequestRule]: "rules",
};

/**
 * Tools named outside BuiltInToolNames (definitions/commandOutput.ts): reading
 * a command's kept output is the session's own state, so the planner (which
 * never runs commands) may have it; ending a command is the terminal's.
 */
export const COMMAND_OUTPUT_TOOL_CLASS: Record<string, ToolClass> = {
  read_command_output: "session",
  stop_command: "terminal",
};

/**
 * The CLI's built-in tools, by the names the CLI gives them. A test in the CLI
 * holds this table to `ALL_BUILT_IN_TOOLS`.
 */
export const CLI_TOOL_CLASS: Record<string, ToolClass> = {
  Read: "read-fs",
  List: "read-fs",
  Diff: "read-fs",
  Skills: "read-fs",
  Search: "search",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
  Bash: "terminal",
  Fetch: "network-fetch",
  Subagent: "delegation",
  TaskList: "session",
  Checklist: "session",
  PresentPlan: "session",
  AskQuestion: "session",
  HoldQuestion: "session",
  FinishItem: "session",
  RemindMe: "session",
  SearchTools: "session",
  CheckBackgroundJob: "session",
  Status: "session",
  Exit: "session",
  // Report to the platform that started the agent (they need --id)
  ReportFailure: "session",
  UploadArtifact: "session",
};

/** Every class: what the agent and background roles may use. */
const ALL_CLASSES: readonly ToolClass[] = TOOL_CLASSES;

/**
 * The classes each role may use. Agent and background are the same list on
 * purpose: one cache prefix, and a background run is an agent run. The planner
 * reads, searches and fetches, and keeps the session tools (present_plan is how
 * Plan mode ends); MCP only when the user marked the tool read-only. The
 * reviewer and chat get no tools. The orchestrator is PROPOSED (decision TR13:
 * a mode of agent and loop for now): it only delegates and keeps the session,
 * and no mode maps to it yet.
 */
export const ROLE_CLASSES: Record<ToolRole, readonly ToolClass[]> = {
  chat: [],
  reviewer: [],
  agent: ALL_CLASSES,
  background: ALL_CLASSES,
  planner: [
    "read-fs",
    "search",
    "network-fetch",
    "mcp-read-only",
    "delegation",
    "session",
  ],
  orchestrator: ["delegation", "session"],
};

/**
 * Plan mode has no terminal on either surface: the IDE never offered it, the
 * CLI used to and no longer does. A person who wants it back in the CLI says so
 * in their own permissions.yaml (`plan.allowTerminal: true`); the call then
 * still goes through the permission engine, which asks. Claude Code's plan mode
 * runs shell commands with approval; Gemini CLI's does not. The default here
 * follows the second.
 */
export interface RoleOptions {
  trust?: PlanMcpTrust;
  /** The user opted the terminal back into Plan mode (`plan.allowTerminal`) */
  allowPlanTerminal?: boolean;
}

export function roleClasses(
  role: ToolRole,
  options: Pick<RoleOptions, "allowPlanTerminal"> = {},
): readonly ToolClass[] {
  return role === "planner" && options.allowPlanTerminal
    ? [...ROLE_CLASSES.planner, "terminal"]
    : ROLE_CLASSES[role];
}

/** The role a message mode runs as. A mode this does not know gets the agent's. */
export function roleForMode(mode: string | undefined): ToolRole {
  switch (mode) {
    case "chat":
      return "chat";
    case "plan":
      return "planner";
    case "background":
      return "background";
    default:
      return "agent";
  }
}

/** For the audit record: the role of a mode word, or none when it names no mode. */
export function toolRoleOfMode(mode: string | undefined): ToolRole | undefined {
  return mode === "chat" ||
    mode === "agent" ||
    mode === "plan" ||
    mode === "background"
    ? roleForMode(mode)
    : undefined;
}

/**
 * What the USER has said about MCP tools for Plan mode, from their own
 * permissions.yaml (never from a workspace file or a server):
 *
 *   mcpServers:
 *     docs: trusted        # believe this server's readOnlyHint
 *   plan:
 *     mcpTools:            # or name the tools, whatever the server claims
 *       - search/query
 *       - wiki/*
 *     allowTerminal: true  # CLI: offer Bash in Plan mode again (it asks)
 *
 * A server's own `readOnlyHint` is a claim, not a fact (the MCP spec treats
 * annotations as untrusted unless the server is trusted), so it opens nothing
 * by itself.
 */
export interface PlanMcpTrust {
  trustedServers?: readonly string[];
  /** "server/tool", "server/*" or "server" */
  tools?: readonly string[];
}

/** The part of a tool the table needs; both surfaces build it from their own tool type. */
export interface RoleToolRef {
  name: string;
  mcp?: {
    server: string;
    /** The tool's name on the server */
    tool: string;
    /** The server's `readOnlyHint` */
    readOnlyHint: boolean;
    /** The server came with the open folder, not from the person's own config */
    fromWorkspace?: boolean;
  };
}

function listedForPlan(
  trust: PlanMcpTrust | undefined,
  server: string,
  tool: string,
): boolean {
  return !!trust?.tools?.some(
    (entry) =>
      entry === server ||
      entry === `${server}/*` ||
      entry === `${server}/${tool}`,
  );
}

/** True only when the user, not the server, said the tool reads and changes nothing. */
export function mcpToolIsUserReadOnly(
  mcp: NonNullable<RoleToolRef["mcp"]>,
  trust: PlanMcpTrust | undefined,
): boolean {
  // A server a folder brought can share a name with one the person listed
  if (mcp.fromWorkspace) return false;
  if (listedForPlan(trust, mcp.server, mcp.tool)) return true;
  return mcp.readOnlyHint && !!trust?.trustedServers?.includes(mcp.server);
}

export function classOfTool(
  tool: RoleToolRef,
  trust?: PlanMcpTrust,
): ToolClass {
  if (tool.mcp) {
    return mcpToolIsUserReadOnly(tool.mcp, trust)
      ? "mcp-read-only"
      : "mcp-other";
  }
  return (
    (BUILT_IN_TOOL_CLASS as Record<string, ToolClass | undefined>)[tool.name] ??
    COMMAND_OUTPUT_TOOL_CLASS[tool.name] ??
    CLI_TOOL_CLASS[tool.name] ??
    "unclassified"
  );
}

export function isToolAllowedForRole(
  role: ToolRole,
  tool: RoleToolRef,
  options: RoleOptions = {},
): boolean {
  return roleClasses(role, options).includes(classOfTool(tool, options.trust));
}

/** The tools a role may be offered, in their order. */
export function filterToolsForRole<T>(
  role: ToolRole,
  tools: readonly T[],
  toRef: (tool: T) => RoleToolRef,
  options: RoleOptions = {},
): T[] {
  return tools.filter((t) => isToolAllowedForRole(role, toRef(t), options));
}

const ROLE_LABEL: Record<ToolRole, string> = {
  chat: "Chat mode",
  agent: "Agent mode",
  background: "a background run",
  planner: "Plan mode",
  reviewer: "the reviewer",
  orchestrator: "an orchestrator run",
};

/**
 * The error a refused call returns, or undefined when the call may run. Names
 * the reason so the model does not retry, and says what unlocks an MCP tool.
 */
export function roleRefusal(
  role: ToolRole,
  tool: RoleToolRef,
  options: RoleOptions = {},
): string | undefined {
  if (isToolAllowedForRole(role, tool, options)) return undefined;
  const where = ROLE_LABEL[role];
  const lead = `The ${tool.name} tool is not available in ${where}, so it was not run.`;
  const tail =
    "Do not retry it or reach the same result another way. Use the tools you were given, then say what you could not do.";
  if (tool.mcp && role === "planner") {
    return `${lead} Plan mode only uses MCP tools the user has marked read-only in their own settings; a server's own read-only claim is not enough. ${tail}`;
  }
  return `${lead} ${tail}`;
}
