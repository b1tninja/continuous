import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import * as fs from "fs";
import { createRequire } from "module";
import * as os from "os";
import * as path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  InternalSseMcpOptions,
  InternalStdioMcpOptions,
  InternalWebsocketMcpOptions,
} from "../..";
import * as ideUtils from "../../util/ideUtils";
import MCPConnection from "./MCPConnection";

// Mock the shell path utility
vi.mock("../../util/shellPath", () => ({
  getEnvPathFromUserShell: vi
    .fn()
    .mockResolvedValue("/usr/local/bin:/usr/bin:/bin"),
}));

describe("MCPConnection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("should create instance with stdio transport", () => {
      const options: InternalStdioMcpOptions = {
        name: "test-mcp",
        id: "test-id",
        type: "stdio",
        command: "test-cmd",
        args: ["--test"],
        env: { TEST: "true" },
      };

      const conn = new MCPConnection(options);
      expect(conn).toBeInstanceOf(MCPConnection);
      expect(conn.status).toBe("not-connected");
    });

    it("should create instance with stdio transport including cwd", () => {
      const options: InternalStdioMcpOptions = {
        name: "test-mcp",
        id: "test-id",
        type: "stdio",
        command: "test-cmd",
        args: ["--test"],
        env: { TEST: "true" },
        cwd: "/path/to/working/directory",
      };

      const conn = new MCPConnection(options);
      expect(conn).toBeInstanceOf(MCPConnection);
      expect(conn.status).toBe("not-connected");
      if (conn.options.type === "stdio") {
        expect(conn.options.cwd).toBe("/path/to/working/directory");
      }
    });

    it("should create instance with websocket transport", () => {
      const options: InternalWebsocketMcpOptions = {
        name: "test-mcp",
        id: "test-id",
        type: "websocket",
        url: "ws://test.com",
      };

      const conn = new MCPConnection(options);
      expect(conn).toBeInstanceOf(MCPConnection);
      expect(conn.status).toBe("not-connected");
    });

    it("should create instance with SSE transport", () => {
      const options: InternalSseMcpOptions = {
        name: "test-mcp",
        id: "test-id",
        type: "sse",
        url: "http://test.com/events",
      };

      const conn = new MCPConnection(options);
      expect(conn).toBeInstanceOf(MCPConnection);
      expect(conn.status).toBe("not-connected");
    });

    it("should create instance with SSE transport and custom headers", () => {
      const options: InternalSseMcpOptions = {
        name: "test-mcp",
        id: "test-id",
        type: "sse",
        url: "http://test.com/events",
        requestOptions: {
          headers: {
            Authorization: "Bearer token123",
            "X-Custom-Header": "custom-value",
          },
        },
      };

      const conn = new MCPConnection(options);
      expect(conn).toBeInstanceOf(MCPConnection);
      expect(conn.status).toBe("not-connected");
    });

    it("should throw on invalid transport type", async () => {
      const options = {
        name: "test-mcp",
        id: "test-id",
        type: "invalid" as any,
        url: "",
      };

      const conn = new MCPConnection(options);
      const abortController = new AbortController();

      // The validation now happens during connectClient, not constructor
      await conn.connectClient(false, abortController.signal);

      expect(conn.status).toBe("error");
      expect(conn.errors[0]).toContain("Unsupported transport type: invalid");
    });

    it("does not start a server the folder defined until that folder is trusted", async () => {
      const conn = new MCPConnection({
        name: "lint",
        id: "lint",
        command: "sh",
        args: ["-c", "echo"],
        projectTrust: "required",
      });
      expect(conn.status).toBe("disabled");
      await conn.connectClient(true, new AbortController().signal);
      expect(conn.status).toBe("disabled");
      conn.status = "not-connected";
      await conn.connectClient(true, new AbortController().signal);
      expect(conn.status).toBe("disabled");
    });
  });

  describe("getStatus", () => {
    it("should return current status", () => {
      const options: InternalStdioMcpOptions = {
        name: "test-mcp",
        id: "test-id",
        type: "stdio",
        command: "test",
        args: [],
      };

      const conn = new MCPConnection(options);
      const status = conn.getStatus();

      expect(status).toEqual({
        ...options,
        errors: [],
        infos: [],
        isProtectedResource: false,
        prompts: [],
        resources: [],
        resourceTemplates: [],
        tools: [],
        status: "not-connected",
      });
    });
  });

  describe("resolveCwd", () => {
    const baseOptions = {
      name: "test-mcp",
      id: "test-id",
      type: "stdio" as const,
      command: "test-cmd",
      args: [],
    };

    it("should return absolute cwd unchanged", async () => {
      const conn = new MCPConnection(baseOptions);

      await expect((conn as any).resolveCwd("/tmp/project")).resolves.toBe(
        "/tmp/project",
      );
    });

    // A POSIX file: URI is not an absolute path on Windows
    it.skipIf(process.platform === "win32")(
      "should resolve relative cwd using IDE workspace",
      async () => {
        const ide = {} as any;
        const mockResolve = vi
          .spyOn(ideUtils, "resolveRelativePathInDir")
          .mockResolvedValue("file:///workspace/src");
        const conn = new MCPConnection(baseOptions, { ide });

        await expect((conn as any).resolveCwd("src")).resolves.toBe(
          "/workspace/src",
        );
        expect(mockResolve).toHaveBeenCalledWith("src", ide);
      },
    );

    it("should fall back to homedir for remote URIs that cannot be used as local cwd", async () => {
      const ide = {} as any;
      vi.spyOn(ideUtils, "resolveRelativePathInDir").mockResolvedValue(
        "vscode-remote://ssh-remote+192.168.137.2/home/user/project",
      );
      const conn = new MCPConnection(baseOptions, { ide });

      const { homedir } = require("os");
      await expect((conn as any).resolveCwd("src")).resolves.toBe(homedir());
    });
  });

  describe("connectClient", () => {
    const options: InternalStdioMcpOptions = {
      name: "test-mcp",
      id: "test-id",
      type: "stdio",
      command: "test-cmd",
      args: [],
    };

    it("should connect successfully", async () => {
      const conn = new MCPConnection(options);
      const mockConnect = vi
        .spyOn(Client.prototype, "connect")
        .mockResolvedValue(undefined);
      const mockGetServerCapabilities = vi
        .spyOn(Client.prototype, "getServerCapabilities")
        .mockReturnValue({
          resources: {},
          tools: {},
          prompts: {},
        });

      const mockListResources = vi
        .spyOn(Client.prototype, "listResources")
        .mockResolvedValue({
          resources: [{ name: "test-resource", uri: "test-uri" }],
        });
      const mockListTools = vi
        .spyOn(Client.prototype, "listTools")
        .mockResolvedValue({
          tools: [
            {
              name: "test-tool",
              inputSchema: {
                type: "object",
              },
            },
          ],
        });
      const mockListPrompts = vi
        .spyOn(Client.prototype, "listPrompts")
        .mockResolvedValue({ prompts: [{ name: "test-prompt" }] });

      const abortController = new AbortController();
      await conn.connectClient(false, abortController.signal);

      expect(conn.status).toBe("connected");
      expect(conn.resources).toHaveLength(1);
      expect(conn.tools).toHaveLength(1);
      expect(conn.prompts).toHaveLength(1);
      expect(mockConnect).toHaveBeenCalled();
    });

    it("should handle custom connection timeout", async () => {
      const conn = new MCPConnection({ ...options, timeout: 1500 });
      const mockConnect = vi
        .spyOn(Client.prototype, "connect")
        .mockImplementation(
          () => new Promise((resolve) => setTimeout(resolve, 1000)),
        );

      // Mock the required methods for successful connection
      const mockGetServerCapabilities = vi
        .spyOn(Client.prototype, "getServerCapabilities")
        .mockReturnValue({
          resources: {},
          tools: {},
          prompts: {},
        });

      const abortController = new AbortController();
      await conn.connectClient(false, abortController.signal);

      expect(conn.status).toBe("connected");
      expect(mockConnect).toHaveBeenCalled();
    });

    it("should handle connection timeout", async () => {
      const conn = new MCPConnection({ ...options, timeout: 50 });
      const mockConnect = vi
        .spyOn(Client.prototype, "connect")
        .mockImplementation(
          () => new Promise((resolve) => setTimeout(resolve, 100)),
        );

      const abortController = new AbortController();
      await conn.connectClient(false, abortController.signal);

      expect(conn.status).toBe("error");
      expect(conn.errors[0]).toContain("Failed to connect");
      // The connection should timeout before connect is called due to transport construction
      // Since transport construction happens first, and we're not mocking that,
      // the timeout will happen during transport construction or connect attempt
    });

    it("should handle already connected state", async () => {
      const conn = new MCPConnection(options);
      conn.status = "connected";

      const mockConnect = vi.spyOn(Client.prototype, "connect");
      const abortController = new AbortController();

      await conn.connectClient(false, abortController.signal);

      expect(mockConnect).not.toHaveBeenCalled();
      expect(conn.status).toBe("connected");
    });

    it("should handle transport errors", async () => {
      const conn = new MCPConnection(options);
      const mockConnect = vi
        .spyOn(Client.prototype, "connect")
        .mockRejectedValue(new Error("spawn test-cmd ENOENT"));

      const abortController = new AbortController();
      await conn.connectClient(false, abortController.signal);

      expect(conn.status).toBe("error");
      expect(conn.errors[0]).toContain('command "test-cmd" not found');
      expect(mockConnect).toHaveBeenCalled();
    });

    it("should include stderr output in error message when stdio command fails", async () => {
      // Clear any existing mocks to ensure we get real behavior
      vi.restoreAllMocks();

      // Use a command that will definitely fail and produce stderr output
      const failingOptions: InternalStdioMcpOptions = {
        name: "failing-mcp",
        id: "failing-id",
        type: "stdio",
        command: "node",
        args: [
          "-e",
          "console.error('Custom error message from stderr'); process.exit(1);",
        ],
        timeout: 5000, // Give enough time for the command to run and fail
      };

      const conn = new MCPConnection(failingOptions);
      const abortController = new AbortController();

      await conn.connectClient(false, abortController.signal);

      expect(conn.status).toBe("error");
      expect(conn.errors).toHaveLength(1);
      expect(conn.errors[0]).toContain("Failed to connect");
      expect(conn.errors[0]).toContain("Process output:");
      expect(conn.errors[0]).toContain("STDERR:");
      expect(conn.errors[0]).toContain("Custom error message from stderr");
      // Starts a real node process, which can take longer than the 5 s default
      // on a loaded runner.
    }, 30_000);

    it("masks secrets and caps the stderr shown in the connect-failure message", async () => {
      vi.restoreAllMocks();
      // Assembled at run time so the file holds no literal that looks like a key.
      const canary = ["AKIA", "QXZN2M4K", "KPQR5TWV"].join("");
      const envSecret = "plain-looking-secret-value-77";
      // The child ends with `process.exitCode`, not `process.exit()`. Its
      // stderr is a pipe, which Node writes asynchronously on Linux and macOS,
      // and `process.exit()` drops whatever is still queued: the child itself
      // would never write the last line.
      const conn = new MCPConnection({
        name: "noisy-mcp",
        id: "noisy-id",
        type: "stdio",
        command: "node",
        args: [
          "-e",
          `console.error("key " + process.env.NOISY_API_KEY + " and ${canary}");` +
            `console.error("x".repeat(200000));` +
            `console.error("final words"); process.exitCode = 1;`,
        ],
        env: { NOISY_API_KEY: envSecret },
        timeout: 5000,
      });

      await conn.connectClient(false, new AbortController().signal);

      expect(conn.status).toBe("error");
      const message = conn.errors[0];
      expect(message).toContain("STDERR:");
      expect(message).toContain("final words");
      expect(message).not.toContain(canary);
      expect(message).not.toContain(envSecret);
      expect(message).toContain("characters omitted");
      expect(message.length).toBeLessThan(10_000);
    }, 30_000);
  });

  // Needs the real filesystem MCP server from npm and times out in CI.
  describe.skip("actually connect to Filesystem MCP", () => {
    it("should connect and include correct tools", async () => {
      const conn = new MCPConnection({
        id: "filesystem",
        name: "Filesystem",
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
      });

      try {
        const abortController = new AbortController();
        await conn.connectClient(false, abortController.signal);
        expect(conn.status).toBe("connected");
      } finally {
        await conn.disconnect();
      }
    });
  });

  describe("Windows launch of shim commands", () => {
    const evilArgs = [
      "-y",
      "pkg & calc",
      "a|b",
      "c^d",
      "%PATH%",
      "(x)",
      "<in >out",
      'say "hi"',
    ];

    async function transportFor(command: string, platform: string) {
      const conn = new MCPConnection({
        name: "test-mcp",
        id: "test-id",
        type: "stdio",
        command,
        args: evilArgs,
      });
      const original = process.platform;
      Object.defineProperty(process, "platform", { value: platform });
      try {
        return (await (conn as any).constructStdioTransport(conn.options)) as {
          _serverParams: { command: string; args: string[] };
        };
      } finally {
        Object.defineProperty(process, "platform", { value: original });
      }
    }

    it.each(["npx", "npm", "pnpm", "yarn", "bunx", "uvx", "python"])(
      "passes %s and its arguments to the transport unchanged on Windows",
      async (command) => {
        const transport = await transportFor(command, "win32");
        // No cmd.exe wrapper: cross-spawn in the transport resolves .cmd
        // shims and escapes the arguments for cmd.exe.
        expect(transport._serverParams.command).toBe(command);
        expect(transport._serverParams.args).toEqual(evilArgs);
      },
    );

    it("does not wrap on Linux either", async () => {
      const transport = await transportFor("npx", "linux");
      expect(transport._serverParams.command).toBe("npx");
      expect(transport._serverParams.args).toEqual(evilArgs);
    });

    // Real cmd.exe, so only where it exists: the transport's spawn must hand a
    // .cmd shim every argument literally, metacharacters included.
    it.skipIf(process.platform !== "win32")(
      "runs a .cmd shim with metacharacter arguments literally",
      async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-shim-"));
        try {
          fs.writeFileSync(
            path.join(dir, "shim.cmd"),
            [
              "@echo off",
              'node -e "console.log(JSON.stringify(process.argv.slice(1)))" -- %*',
              "",
            ].join("\r\n"),
          );
          const canary = path.join(dir, "pwned.txt").split(path.sep).join("/");
          const args = [`a&echo x>${canary}`, "b|c", "%COMPUTERNAME%", "d e"];
          // cross-spawn is the transport SDK's own spawn, not a direct dependency.
          const crossSpawn = createRequire(path.join(process.cwd(), "noop.js"))(
            "cross-spawn",
          );
          const result = crossSpawn.sync("shim", args, {
            env: {
              ...process.env,
              PATH: dir + path.delimiter + process.env.PATH,
            },
            encoding: "utf8",
          });
          expect(JSON.parse(result.stdout)).toEqual(args);
          expect(fs.existsSync(canary)).toBe(false);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
      30_000,
    );
  });
});
