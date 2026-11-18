/**
 * Base interface for command options that are shared across multiple commands
 * Uses command-line flag names for direct compatibility
 */
export interface BaseCommandOptions {
  /** Path to configuration file (--config) */
  config?: string;
  /** Organization slug to use for this session (--org) */
  org?: string;
  /** Array of rule specifications (--rule) */
  rule?: string[];
  /** Array of MCP server slugs from the hub (--mcp) */
  mcp?: string[];
  /** Array of model slugs from the hub (--model) */
  model?: string[];
  /** Array of prompt slugs from the hub (--prompt) */
  prompt?: string[];
  /** Array of tools to allow (--allow) */
  allow?: string[];
  /** Array of tools to ask permission for (--ask) */
  ask?: string[];
  /** Array of tools to exclude from use (--exclude) */
  exclude?: string[];
  /** Run limits of a headless run or serve (--max-budget-usd, --max-turns, --max-duration, --budget-allow-unpriced) */
  maxBudgetUsd?: string | number;
  maxTurns?: string | number;
  maxDuration?: string | number;
  budgetAllowUnpriced?: boolean;
  /** Agent file slug from the hub (--agent) */
  agent?: string;
  /** Enable beta Subagent tool */
  betaSubagentTool?: boolean;
  /** Run this project's hooks for this session without asking (--trust-project-hooks) */
  trustProjectHooks?: boolean;
  /** Headless: continue with a broken hook settings or permissions file ignored (--ignore-broken-config) */
  ignoreBrokenConfig?: boolean;
  /** Use this project's Continuous configuration for this session (--trust-project-config) */
  trustProjectConfig?: boolean;
}

/**
 * Extended base options that include verbose and tool control flags
 */
export interface ExtendedCommandOptions extends BaseCommandOptions {
  /** Enable verbose logging */
  verbose?: boolean;
  /** Start in plan mode (backward compatibility) */
  readonly?: boolean;
  /** Start in auto mode (all tools allowed) */
  auto?: boolean;
  /** Experimental: a reviewer-role model decides calls the rules leave open. */
  autoReview?: boolean;
}
