import { ToolCallPreview } from "../tools/types.js";

export type PermissionPolicy = "allow" | "ask" | "exclude";

export type PermissionMode = "normal" | "plan" | "auto";

export interface ToolPermissionPolicy {
  /** The tool name to match against */
  tool: string;
  /** The permission to apply */
  permission: PermissionPolicy;
  /** Optional argument matching patterns. If not specified, applies to all calls to this tool */
  argumentMatches?: Record<string, any>;
  /**
   * A limit of the run's shape, not a permission (a subagent cannot start a
   * subagent or write the parent's task list): IDGAF does not lift it.
   */
  structural?: boolean;
}

export interface ToolPermissions {
  /** Array of permission policies that are evaluated in order */
  policies: ToolPermissionPolicy[];
}

export interface ToolCallRequest {
  name: string;
  arguments: Record<string, any>;
  preview?: ToolCallPreview[];
}

export interface PermissionCheckResult {
  permission: PermissionPolicy;
  /** The policy that matched this tool call */
  matchedPolicy?: ToolPermissionPolicy;
}
