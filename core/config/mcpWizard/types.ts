/*
  Shared shapes for the MCP add wizard (plans/research/mcp-server-wizard.md,
  rows MCPW1 to MCPW5). Everything here is data: nothing in these types is
  ever executed by the parser or the analysis.
*/

/** How the client talks to the server. `http` is Streamable HTTP. */
export type McpWizardTransport = "stdio" | "http" | "sse";

/** Which shape the pasted text had. */
export type McpPasteFormat =
  /** `{"mcpServers": {...}}`: Claude Desktop, Cursor, Cline, Windsurf, Devin */
  | "mcpServers-json"
  /** `{"servers": {...}}`, or `{"mcp": {"servers": {...}}}`: VS Code mcp.json and settings.json */
  | "vscode-json"
  /** `{"context_servers": {...}}`: Zed */
  | "zed-json"
  /** `{"mcp": {...}}` with entries directly under it: OpenCode */
  | "opencode-json"
  /** One server object, `{"command": ...}` or `{"url": ...}` */
  | "server-json"
  /** `[mcp_servers.<name>]` in TOML: Codex */
  | "codex-toml"
  /** A launcher line: `npx`, `uvx`, `docker run`, `node`, `python` ... */
  | "command-line"
  /** A bare `https://` URL */
  | "url"
  /** `claude mcp add ...` */
  | "claude-mcp-add"
  /** `claude mcp add-json <name> '<json>'` */
  | "claude-mcp-add-json"
  /** `code --add-mcp '<json>'` */
  | "code-add-mcp"
  /** `<other tool> mcp add <name> -- <command>`: Codex, Gemini, Amp, Grok, Droid */
  | "cli-mcp-add"
  /** `vscode:mcp/install?<json>` */
  | "vscode-link"
  /** `cursor://anysphere.cursor-deeplink/mcp/install?name=...&config=...` */
  | "cursor-link";

/** A `${...}` in a value: another tool's variable or one of our secrets. */
export interface McpValueReference {
  /**
   * `vscode-input` is `${input:id}`, `env` is `${env:NAME}`, `${NAME}` or
   * `${NAME:-default}`, `secret` is our own `${{ secrets.NAME }}`.
   */
  kind: "vscode-input" | "env" | "secret";
  name: string;
}

/** An environment variable or a header, as the paste gave it. */
export interface McpNamedValue {
  name: string;
  /**
   * Present only when the paste had a literal value. A value that is a
   * reference to another tool's variable is not kept: `reference` says what
   * it was.
   */
  value?: string;
  reference?: McpValueReference;
  /** A literal value that has the shape of a credential, or a credential-named key with a real-looking value. */
  secretLooking: boolean;
  /** A literal value that is an instruction to the reader, such as `<YOUR_TOKEN>` or `YOUR_API_KEY`. */
  placeholder: boolean;
}

/** One server the parser found. Never executed by the parser. */
export interface McpCandidate {
  name: string;
  /** True when the paste had no name and one was made from the package or host. */
  nameGuessed: boolean;
  transport: McpWizardTransport;
  /** True when the transport is a guess (a URL without a type). The probe decides. */
  transportGuessed: boolean;
  command?: string;
  args?: string[];
  cwd?: string;
  env: McpNamedValue[];
  url?: string;
  headers: McpNamedValue[];
  sourceFormat: McpPasteFormat;
  /** What the parser could not carry over, or noticed. Plain text, safe to show. */
  warnings: string[];
}

export interface McpPasteResult {
  candidates: McpCandidate[];
  /** About the paste as a whole (a block that was skipped, and why). */
  warnings: string[];
}

/**
 * A server ready to test or save: the candidate after the person reviewed it.
 * `value` holds what the person typed or accepted; `secret` says it goes to
 * the secret store and the file gets a reference.
 */
export interface McpDraftValue {
  name: string;
  value: string;
  secret: boolean;
}

export interface McpServerDraft {
  name: string;
  transport: McpWizardTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: McpDraftValue[];
  url?: string;
  headers?: McpDraftValue[];
  /** Connection timeout in milliseconds, written as `connectionTimeout`. */
  connectionTimeoutMs?: number;
}
