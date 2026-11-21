import type { ToolPolicy } from "@continuedev/terminal-security";

// JSON Schema compatible parameter definition
export interface ParameterSchema {
  type: string;
  description: string;
  enum?: string[];
  required?: string[];
  properties?: Record<string, ParameterSchema>;
  items?: {
    type: string;
    properties?: Record<string, ParameterSchema>;
    required?: string[];
  };
}

export interface ToolParametersSchema {
  type: "object";
  required?: string[];
  properties: Record<string, ParameterSchema>;
}

export interface ToolCallPreview {
  type: "text" | "diff" | "checklist";
  content: string;
  color?: string;
  paddingLeft?: number;
}

export interface PreprocessToolCallResult {
  preview?: ToolCallPreview[];
  args: Record<string, any>;
  /**
   * What preprocessing worked out about the arguments, for the permission
   * check (core's `processedArgs`). Fetch: whether the host is non-public.
   */
  processedArgs?: Record<string, unknown>;
  context?: { toolCallId: string };
}

export interface ToolRunContext {
  toolCallId: string;
  /**
   * Number of tool calls being executed in parallel.
   * Tools should divide their output limits by this number to avoid context overflow.
   */
  parallelToolCallCount: number;
  /**
   * The signal of the turn this call belongs to. It aborts when the person
   * cancels the turn (Esc in the TUI, an interrupt in `serve`, a signal in
   * headless mode); long-running tools should stop when it does.
   */
  abortSignal?: AbortSignal;
  /**
   * The permission prompt of the session that made this call, when it has
   * one. Lets a tool that runs its own agent loop (a subagent) put that
   * loop's "ask" calls in front of the person.
   */
  onToolPermissionRequest?: ToolPermissionPrompt;
  /**
   * The session the call belongs to (a subagent's run has its own), so a
   * tool can find that session's pages in the web content store
   * (core/util/web/contentStore.ts): core's `ToolExtras.sessionId`.
   */
  sessionId?: string;
}

export type ToolPermissionPrompt = (
  toolName: string,
  toolArgs: any,
  requestId: string,
  preview?: ToolCallPreview[],
  /** The model's id for the call being asked about, when the caller has one */
  toolCallId?: string,
) => void;

export interface Tool {
  name: string;
  displayName: string;
  description: string;
  parameters: ToolParametersSchema;
  preprocess?: (args: any) => Promise<PreprocessToolCallResult>;
  run: (args: any, context?: ToolRunContext) => Promise<string>;
  readonly?: boolean; // Indicates if the tool is readonly
  isBuiltIn: boolean;
  /** MCP server this tool belongs to, so floor rules on `mcp__server__*` apply. */
  mcpServer?: string;
  /** The tool's own name on that server, which the model-facing `name` may qualify */
  mcpToolName?: string;
  /** Not approved yet (TR4): not offered until the person approves it in `/mcp` */
  mcpPendingApproval?: "new" | "added" | "changed";
  evaluateToolCallPolicy?: (
    basePolicy: ToolPolicy,
    parsedArgs: Record<string, unknown>,
    processedArgs?: Record<string, unknown>,
  ) => ToolPolicy;
  /**
   * Set when an ask from `evaluateToolCallPolicy` must stand at the default
   * levels and in headless runs, as it does in the IDE: why the check asks
   * for these arguments. Without it, the CLI's own allow wins over the
   * tool's ask (Bash relies on that in headless runs).
   */
  ownAskReason?: (args: Record<string, unknown>) => string | undefined;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: any;
  argumentsStr: string;
  startNotified: boolean;
  extra_content?: Record<string, unknown>;
  /**
   * Set when `argumentsStr` did not parse: the result the model gets in
   * place of a run. `arguments` is then `{}` and must not be used.
   */
  unparsedArguments?: string;
}

export interface PreprocessedToolCall extends ToolCall {
  tool: Tool;
  preprocessResult?: PreprocessToolCallResult;
}
