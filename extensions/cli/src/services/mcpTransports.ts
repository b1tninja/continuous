import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  HttpMcpServer,
  SseMcpServer,
  StdioMcpServer,
} from "node_modules/@continuedev/config-yaml/dist/schemas/mcp/index.js";

import { mcpStdioEnv } from "../childEnv.js";
import { networkFetch } from "../util/networkFetch.js";

import { MCPConnectionInfo } from "./types.js";

export function constructSseTransport(
  serverConfig: SseMcpServer,
  apiKey: string | undefined,
): SSEClientTransport {
  // proxy, caBundlePath, useSystemCa, client certificate and verifySsl
  const fetchFn = networkFetch(serverConfig.requestOptions);

  const headers = {
    ...serverConfig.requestOptions?.headers,
    ...(apiKey && {
      Authorization: `Bearer ${apiKey}`,
    }),
  };

  return new SSEClientTransport(new URL(serverConfig.url), {
    fetch: fetchFn,
    eventSourceInit: {
      fetch: (input, init) =>
        fetchFn(
          input as RequestInfo | URL,
          {
            ...init,
            headers: {
              ...init?.headers,
              ...headers,
            },
          } as RequestInit,
        ),
    },
    requestInit: {
      headers,
    },
  });
}

export function constructHttpTransport(
  serverConfig: HttpMcpServer,
  apiKey: string | undefined,
): StreamableHTTPClientTransport {
  const headers = {
    ...serverConfig.requestOptions?.headers,
    ...(apiKey && {
      Authorization: `Bearer ${apiKey}`,
    }),
  };

  return new StreamableHTTPClientTransport(new URL(serverConfig.url), {
    fetch: networkFetch(serverConfig.requestOptions),
    requestInit: {
      headers,
    },
  });
}

export function constructStdioTransport(
  serverConfig: StdioMcpServer,
  connection: MCPConnectionInfo,
): StdioClientTransport {
  const env = mcpStdioEnv(serverConfig.env);

  const transport = new StdioClientTransport({
    command: serverConfig.command,
    args: serverConfig.args || [],
    env,
    cwd: serverConfig.cwd,
    stderr: "pipe",
  });

  const stderrStream = transport.stderr;
  if (stderrStream) {
    stderrStream.on("data", (data: Buffer) => {
      const stderrOutput = data.toString().trim();
      if (stderrOutput) {
        connection.warnings.push(stderrOutput);
      }
    });
  }

  return transport;
}
