import { decodeFQSN, getTemplateVariables } from "@continuedev/config-yaml";
import type { AssistantUnrolled as AssistantConfig } from "@continuedev/config-yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  listPromptsPaged,
  listToolsPaged,
} from "core/context/mcp/mcpClientLists.js";
import { connectModernIfSupported } from "core/context/mcp/mcpModernConnect.js";
import { announcePins } from "core/context/mcp/mcpPinNotices.js";
import {
  adoptLegacyPin,
  evaluatePins,
  getToolPinStore,
  launchSpec,
  pinKey,
  recordApproval,
  type ApprovalEvents,
} from "core/context/mcp/mcpToolPins.js";

import { getErrorString } from "../util/error.js";
import { logger } from "../util/logger.js";

import { BaseService, ServiceWithDependencies } from "./BaseService.js";
import {
  constructHttpTransport,
  constructSseTransport,
  constructStdioTransport,
} from "./mcpTransports.js";
import { isAuthError } from "./mcpUtils.js";
import { serviceContainer } from "./ServiceContainer.js";
import {
  MCPConnectionInfo,
  MCPServerConfig,
  MCPServiceState,
  SERVICE_NAMES,
} from "./types.js";

interface ServerConnection extends MCPConnectionInfo {
  client: Client | null;
  /** Tools that must ask again: a changed definition, or a changed launch definition */
  pinChanges?: Map<
    string,
    { kind: "changed" | "added" | "launch"; summary: string }
  >;
}

export const EMPTY_MCP_STATE: MCPServiceState = {
  mcpService: null,
  connections: [],
  tools: [],
  prompts: [],
};

export class MCPService
  extends BaseService<MCPServiceState>
  implements ServiceWithDependencies
{
  private connections: Map<string, ServerConnection> = new Map();
  private assistant: AssistantConfig | null = null;
  private isShuttingDown = false;
  private isHeadless: boolean | undefined;
  private apiKeyCache: Map<string, string> = new Map();

  getDependencies(): string[] {
    return [SERVICE_NAMES.CONFIG, SERVICE_NAMES.AUTH];
  }
  constructor() {
    super("MCPService", {
      ...EMPTY_MCP_STATE,
    });

    // Register shutdown handler
    process.on("exit", () => this.cleanup());
    process.on("SIGINT", () => this.cleanup());
    process.on("SIGTERM", () => this.cleanup());
  }

  /**
   * Initialize the MCP service
   */
  async doInitialize(
    assistant: AssistantConfig,
    hasAgentFile: boolean,
    isHeadless: boolean | undefined,
  ): Promise<MCPServiceState> {
    this.isHeadless = isHeadless;

    await this.shutdownConnections();

    this.assistant = assistant;
    this.connections.clear();

    const connectionPromises = assistant.mcpServers?.map(async (config) => {
      if (config) {
        return await this.connectServer(config);
      }
    });

    const connectionInit = Promise.all(connectionPromises ?? []);
    if (isHeadless || hasAgentFile) {
      await connectionInit;

      if (isHeadless) {
        // With headless or agent, throw error if any MCP server failed to connect
        const failedConnections = Array.from(this.connections.values()).filter(
          (c) => c.status === "error",
        );
        if (failedConnections.length > 0) {
          const errorMessages = failedConnections.map(
            (c) => `${c.config?.name}: ${c.error}`,
          );
          throw new Error(
            `MCP server(s) failed to load:\n${errorMessages.join("\n")}`,
          );
        }
      }
    } else {
      this.updateState();
    }

    return this.currentState;
  }

  /**
   * Update internal state based on current connections
   */
  private updateState() {
    const connections: MCPConnectionInfo[] = Array.from(
      this.connections.values(),
    ).map(({ client: _, ...rest }) => rest);
    const connectedServers = connections.filter(
      (c) => c.status === "connected",
    );
    const tools = connectedServers.flatMap((s) =>
      s.tools.map((tool) => ({
        ...tool,
        serverName: s.config?.name,
      })),
    );
    const prompts = connectedServers.flatMap((s) => s.prompts);

    const newState: MCPServiceState = {
      mcpService: this,
      connections,
      tools,
      prompts,
    };
    this.setState(newState);
    serviceContainer.set(SERVICE_NAMES.MCP, newState);
  }

  /**
   * Get current MCP service state
   */
  getState(): MCPServiceState {
    return { ...this.currentState };
  }

  /**
   * Get overall status for UI indicator
   */
  getOverallStatus(): {
    status: "idle" | "connecting" | "connected" | "error";
    hasWarnings: boolean;
  } {
    const connections = Array.from(this.connections.values());
    const hasWarnings = connections.some((c) => c.warnings.length > 0);

    if (connections.some((c) => c.status === "connecting")) {
      return { status: "connecting", hasWarnings };
    }
    if (connections.some((c) => c.status === "error")) {
      return { status: "error", hasWarnings };
    }
    if (connections.some((c) => c.status === "connected")) {
      return { status: "connected", hasWarnings };
    }

    return { status: "idle", hasWarnings };
  }

  /**
   * Generic wrapper for client operations that handles 401 errors with token refresh
   * Only applies to SSE/HTTP connections, not stdio
   */
  private async withTokenRefresh<T>(
    serverName: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const connection = this.connections.get(serverName);
    if (!connection) {
      throw new Error(`Connection ${serverName} not found`);
    }

    const serverConfig = connection.config;
    if (!serverConfig || "command" in serverConfig) {
      // For stdio connections, just execute normally (no token refresh possible)
      return await operation();
    }

    // No auth/token refresh available - just execute the operation directly
    return await operation();
  }

  /** The pin options of a connection: its config as the core pin code reads it. */
  private pinOptions(connection: ServerConnection) {
    return connection.config as never;
  }

  /** Compare a server's tools and launch definition with what was approved. */
  public async refreshPins(connection: ServerConnection): Promise<void> {
    try {
      const options = this.pinOptions(connection);
      const store = getToolPinStore();
      await adoptLegacyPin(options, store);
      const { flagged } = await evaluatePins(
        pinKey(options),
        connection.tools as never,
        store,
        launchSpec(options),
      );
      connection.pinChanges = flagged;
    } catch (error) {
      logger.warn("Could not check the saved MCP pins", {
        name: connection.config?.name,
        error: getErrorString(error),
      });
    }
  }

  /**
   * A call ran, so it was approved (or the person runs at IDGAF): pin it. The
   * first call to a server pins all of its tools, and a changed launch
   * definition is accepted here; both are announced.
   */
  public async recordPins(
    connection: ServerConnection,
    toolName: string,
  ): Promise<void> {
    try {
      const options = this.pinOptions(connection);
      const events: ApprovalEvents = {};
      await adoptLegacyPin(options, getToolPinStore());
      const changed = await recordApproval(
        pinKey(options),
        connection.tools as never,
        getToolPinStore(),
        toolName,
        new Date(),
        launchSpec(options),
        events,
      );
      if (!changed) return;
      announcePins(connection.config.name, events, connection.warnings, (m) =>
        logger.warn(m),
      );
      await this.refreshPins(connection);
    } catch (error) {
      logger.warn("Could not save the MCP pin", {
        error: getErrorString(error),
      });
    }
  }

  /** What the policy needs to know before it lets a call to this tool run. */
  public getPinChange(serverName: string, toolName: string) {
    return this.connections.get(serverName)?.pinChanges?.get(toolName);
  }

  /**
   * Run a tool of one server. With `serverName` the call goes to that server
   * and no other. Without it the name must belong to exactly one connected
   * server: when two offer it the call is refused, because running "whichever
   * connected first" is how an approval card and the executed server differ.
   */
  public async runTool(
    name: string,
    args: Record<string, any>,
    serverName?: string,
  ) {
    const owners = [...this.connections.values()].filter(
      (c) =>
        c.status === "connected" &&
        c.client &&
        (serverName === undefined || c.config?.name === serverName) &&
        c.tools.some((t) => t.name === name),
    );
    if (owners.length > 1) {
      throw new Error(
        `Tool ${name} is offered by more than one MCP server (${owners
          .map((c) => c.config?.name)
          .join(", ")}); refusing to guess which one to run`,
      );
    }
    const [owner] = owners;
    if (owner) {
      const ownerName = owner.config!.name;
      return await this.withTokenRefresh(ownerName, async () => {
        const conn = this.connections.get(ownerName);
        if (!conn?.client) {
          throw new Error(`Client for ${ownerName} not available`);
        }
        const result = await conn.client.callTool({
          name,
          arguments: args,
        });
        await this.recordPins(conn, name);
        return result;
      });
    }
    throw new Error(`Tool ${name} not found`);
  }

  /**
   * Restart all servers
   */
  public async restartAllServers(): Promise<void> {
    if (!this.assistant) return;

    await this.shutdownConnections();
    await this.initialize(this.assistant);
  }

  /**
   * Restart a specific server
   */
  public async restartServer(serverName: string): Promise<void> {
    if (!this.assistant || !this.assistant.mcpServers) return;

    const serverConfig = this.assistant.mcpServers.find(
      (s, index) => s && (s.name || `server-${index}`) === serverName,
    );

    if (!serverConfig) {
      throw new Error(`Server ${serverName} not found in configuration`);
    }

    const existingConnection = this.connections.get(serverName);
    if (existingConnection) {
      if (existingConnection.status === "connected") {
        await this.shutdownConnection(existingConnection);
      }
      this.connections.delete(serverName);
    }
    await this.connectServer(serverConfig);
  }

  private async connectServer(serverConfig: MCPServerConfig) {
    const connection: ServerConnection = {
      config: serverConfig,
      client: null,
      prompts: [],
      tools: [],
      status: "connecting",
      warnings: [],
    };
    const serverName = serverConfig.name;
    this.connections.set(serverName, connection);
    this.updateState();

    const vars = getTemplateVariables(JSON.stringify(serverConfig));
    const secretVars = vars.filter((v) => v.startsWith("secrets."));
    const unrendered = secretVars.map((v) => {
      return decodeFQSN(v.replace("secrets.", "")).secretName;
    });

    try {
      if (unrendered.length > 0) {
        const message = `${serverConfig.name} MCP Server has unresolved secrets: ${unrendered.join(", ")}
Set each secret as an environment variable or in a .env file (~/.continuous/.env, .continuous/.env, .continue/.env or .env in the project). Secrets are never fetched from a server.`;
        if (this.isHeadless) {
          throw new Error(message);
        } else {
          connection.warnings.push(message);
        }
      }

      const client = await this.getConnectedClient(serverConfig, connection);

      connection.client = client;
      connection.status = "connected";
      this.updateState();

      const capabilities = client.getServerCapabilities();

      if (capabilities?.prompts) {
        try {
          connection.prompts = await this.withTokenRefresh(
            serverName,
            async () => {
              const conn = this.connections.get(serverName);
              if (!conn?.client) {
                throw new Error(`Client for ${serverName} not available`);
              }
              const { items, warning } = await listPromptsPaged(conn.client);
              if (warning) connection.warnings.push(warning);
              return items;
            },
          );
        } catch (error) {
          const errorMessage = getErrorString(error);
          connection.warnings.push(`Failed to load prompts: ${errorMessage}`);
          logger.warn("Failed to load MCP prompts", {
            name: serverName,
            error: errorMessage,
          });
        }
      }

      if (capabilities?.tools) {
        try {
          connection.tools = await this.withTokenRefresh(
            serverName,
            async () => {
              const conn = this.connections.get(serverName);
              if (!conn?.client) {
                throw new Error(`Client for ${serverName} not available`);
              }
              const { items, warning } = await listToolsPaged(conn.client);
              if (warning) connection.warnings.push(warning);
              return items;
            },
          );
        } catch (error) {
          const errorMessage = getErrorString(error);
          connection.warnings.push(`Failed to load tools: ${errorMessage}`);
          logger.warn("Failed to load MCP tools", {
            name: serverName,
            error: errorMessage,
          });
        }
      }
      await this.refreshPins(connection);
    } catch (error) {
      const errorMessage = getErrorString(error);
      connection.status = "error";

      // Convert any warnings to error at time of connection failure
      if (connection.warnings.length > 0) {
        const stderrContent = connection.warnings.join("\n");
        connection.error = `${errorMessage}\n\nServer stderr:\n${stderrContent}`;
        connection.warnings = [];
      } else {
        connection.error = errorMessage;
      }

      logger.error("Failed to connect to MCP server", {
        name: serverName,
        error: connection.error,
      });
    }

    this.updateState();
  }

  /**
   * Stop a specific server
   */
  public async stopServer(serverName: string): Promise<void> {
    const connection = this.connections.get(serverName);
    if (connection) {
      await this.shutdownConnection(connection);
    }
  }

  /**
   * Shutdown all connections
   */
  public async shutdownConnections(): Promise<void> {
    const shutdownPromises = Array.from(this.connections.values()).map(
      (connection) => this.shutdownConnection(connection),
    );
    await Promise.all(shutdownPromises);
    this.updateState();
  }

  /**
   * Shutdown a single connection
   */
  private async shutdownConnection(
    connection: ServerConnection,
  ): Promise<void> {
    try {
      if (connection.client) {
        await connection.client.close();
      }
      connection.status = "idle";
      connection.warnings = [];
      connection.client = null;
      connection.tools = [];
      connection.prompts = [];
      connection.error = undefined;
      this.updateState();
    } catch (error) {
      const errorMessage = getErrorString(error);
      logger.warn("Error shutting down MCP connection", {
        name: connection.config?.name,
        error: errorMessage,
      });
    }
  }

  public async cleanup(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    this.removeAllListeners();
    await this.shutdownConnections();
  }

  /**
   * Construct transport based on server configuration and connect client
   */
  private async getConnectedClient(
    serverConfig: MCPServerConfig,
    connection: ServerConnection,
  ): Promise<Client> {
    const client = new Client(
      { name: "continuous-cli-client", version: "1.0.0" },
      { capabilities: {} },
    );

    // Revision 2026-07-28 servers answer `server/discover` and need no handshake;
    // everything else (and any failure of the probe) takes the classic path.
    if (
      !("command" in serverConfig) &&
      (serverConfig.type === undefined ||
        serverConfig.type === "streamable-http") &&
      serverConfig.requestOptions?.verifySsl !== false
    ) {
      const modern = await connectModernIfSupported({
        url: serverConfig.url,
        clientInfo: { name: "continuous-cli-client", version: "1.0.0" },
        headers: {
          ...serverConfig.requestOptions?.headers,
          ...((serverConfig.apiKey ||
            this.apiKeyCache.get(serverConfig.name)) && {
            Authorization: `Bearer ${serverConfig.apiKey ?? this.apiKeyCache.get(serverConfig.name)}`,
          }),
        },
      });
      if (modern) return modern as unknown as Client;
    }

    if ("command" in serverConfig) {
      // STDIO: no need to check type, just if command is present
      const transport = constructStdioTransport(serverConfig, connection);
      await client.connect(transport, {});
    } else {
      // SSE/HTTP: if type isn't explicit: try http and fall back to sse
      try {
        await this.withTokenRefresh(serverConfig.name, async () => {
          if (serverConfig.apiKey && !this.apiKeyCache.get(serverConfig.name)) {
            this.apiKeyCache.set(serverConfig.name, serverConfig.apiKey);
          }
          const apiKey = this.apiKeyCache.get(serverConfig.name);
          if (serverConfig.type === "sse") {
            const transport = constructSseTransport(serverConfig, apiKey);
            await client.connect(transport, {});
          } else if (serverConfig.type === "streamable-http") {
            const transport = constructHttpTransport(serverConfig, apiKey);
            await client.connect(transport, {});
          } else {
            try {
              const transport = constructHttpTransport(serverConfig, apiKey);
              await client.connect(transport, {});
            } catch (e) {
              if (isAuthError(e)) {
                throw e;
              }
              const transport = constructSseTransport(serverConfig, apiKey);
              await client.connect(transport, {});
            }
          }
        });
      } catch (error: unknown) {
        // If token refresh didn't work and it's a 401, fall back to mcp-remote
        if (isAuthError(error) && !this.isHeadless) {
          // Build mcp-remote args with Supabase-specific OAuth scopes if needed
          const mcpRemoteArgs = ["-y", "mcp-remote", serverConfig.url];

          // Detect Supabase MCP and add custom OAuth scopes
          if (serverConfig.url.includes("mcp.supabase.com")) {
            const supabaseScopes = [
              "organizations:read",
              "projects:read",
              "database:read",
              "analytics:read",
              "secrets:read",
              "edge_functions:read",
              "environment:read",
              "storage:read",
            ].join(" ");

            mcpRemoteArgs.push(
              "--static-oauth-client-metadata",
              JSON.stringify({ scope: supabaseScopes }),
            );
          }

          const transport = constructStdioTransport(
            {
              name: serverConfig.name,
              command: "npx",
              args: mcpRemoteArgs,
            },
            connection,
          );
          await client.connect(transport, {});
        } else {
          throw error;
        }
      }
    }

    return client;
  }
}
