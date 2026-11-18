import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { CertsCache } from "@continuedev/fetch";
import { IDE, McpOauthSettings } from "../..";
import { GlobalContext } from "../../util/GlobalContext";
import { getGlobalContextFilePath } from "../../util/paths";
import { knownValueMatcher, scanText } from "../../util/secretScan";
import { MCPManagerSingleton } from "./MCPManagerSingleton";
import { getCallbackListenAddresses, performAuth } from "./MCPOauth";
import {
  MockOAuthMcpServer,
  MockOptions,
  createTestCa,
  freePort,
  hasOpenssl,
  waitFor,
} from "./mockOAuthMcpServer";
import { oauthOptionsFromSettings } from "./mcpOauthSettings";

// The MCP SDK needs the native fetch/Request/Response; core's Vitest setup
// swaps them for node-fetch's (see MCPOauth.e2e.vitest.ts).
const nativeGlobals = {
  fetch: globalThis.fetch,
  Request: globalThis.Request,
  Response: globalThis.Response,
};
let setupGlobals: typeof nativeGlobals;
beforeAll(() => {
  setupGlobals = {
    fetch: globalThis.fetch,
    Request: globalThis.Request,
    Response: globalThis.Response,
  };
  Object.assign(globalThis, nativeGlobals);
});
afterAll(() => {
  Object.assign(globalThis, setupGlobals);
});

/**
 * Acceptance tests for the hardened MCP OAuth client (plans/research/
 * agent-security.md R5): RFC 9207 `iss`, static clients, registration
 * metadata, loopback-only listener, and no secrets in logs. They run the real
 * sign-in code against the mock MCP server and authorization server.
 */

// A GitHub-token shaped value built at run time, so the scanner's provider
// rule would flag it if it ever reached a log line.
const STATIC_SECRET = "ghp_" + "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5";
const STATIC_ID = "static-client-id-123";
const LOG_METHODS = ["log", "debug", "info", "warn", "error"] as const;

describe("MCP OAuth hardening", { timeout: 20_000 }, () => {
  let mock: MockOAuthMcpServer;
  let ide: {
    openUrl: ReturnType<typeof vi.fn>;
    showToast: ReturnType<typeof vi.fn>;
  };
  let callbackPort: number;
  let globalContextFile: string;
  let oauth: McpOauthSettings;
  const serverId = "hardening";

  const connection = () =>
    MCPManagerSingleton.getInstance().getConnection(serverId)!;
  const stored = () =>
    new GlobalContext().get("mcpOauthStorage")?.[mock.mcpUrl];

  async function startServer(
    mockOptions: MockOptions = {},
    settings: McpOauthSettings = {},
  ) {
    oauth = { callbackPort, ...settings };
    mock = new MockOAuthMcpServer(mockOptions);
    await mock.start();
    MCPManagerSingleton.getInstance().setConnections(
      [
        {
          id: serverId,
          name: serverId,
          type: "streamable-http",
          url: mock.mcpUrl,
          oauth,
        } as any,
      ],
      true,
      { ide: ide as unknown as IDE },
    );
    await waitFor(
      () => ["error", "connected"].includes(connection().status),
      "the first connection attempt",
    );
  }

  /** Start sign-in the way core.ts does, up to the browser being opened. */
  async function begin() {
    const result = await performAuth(
      serverId,
      mock.mcpUrl,
      ide as unknown as IDE,
      oauthOptionsFromSettings(oauth),
    );
    expect(result).toBe("REDIRECT");
    const authorizeUrl = new URL(ide.openUrl.mock.calls.at(-1)![0]);
    const code = mock.issueCode(
      authorizeUrl.searchParams.get("code_challenge")!,
    );
    return { authorizeUrl, code };
  }

  /** What the browser does at the end: GET the redirect URI with parameters. */
  async function redirect(
    authorizeUrl: URL,
    params: Record<string, string | undefined>,
  ) {
    const callback = new URL(authorizeUrl.searchParams.get("redirect_uri")!);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) callback.searchParams.set(k, v);
    }
    return fetch(callback);
  }

  const okParams = (authorizeUrl: URL, code: string) => ({
    code,
    state: authorizeUrl.searchParams.get("state") ?? undefined,
  });

  async function expectRejected() {
    await waitFor(() => ide.showToast.mock.calls.length > 0, "an error toast");
    expect(mock.grants).toEqual([]); // the code never went to the token endpoint
    expect(stored()).toBeUndefined();
    expect(connection().status).toBe("error");
  }

  beforeEach(async () => {
    globalContextFile = getGlobalContextFilePath();
    if (fs.existsSync(globalContextFile)) fs.unlinkSync(globalContextFile);
    ide = { openUrl: vi.fn(async () => {}), showToast: vi.fn(async () => {}) };
    callbackPort = await freePort();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await MCPManagerSingleton.getInstance().shutdown();
    await mock?.stop();
    if (fs.existsSync(globalContextFile)) fs.unlinkSync(globalContextFile);
  });

  describe("RFC 9207 iss", () => {
    test("a wrong iss is rejected before the code is exchanged", async () => {
      await startServer({ issParameterSupported: true });
      const { authorizeUrl, code } = await begin();
      const resp = await redirect(authorizeUrl, {
        ...okParams(authorizeUrl, code),
        iss: "https://evil.example",
      });
      expect(resp.status).toBe(400);
      await expectRejected();
      expect(ide.showToast.mock.calls[0][1]).toContain("different issuer");
    });

    test("a missing iss is rejected when the server advertises support", async () => {
      await startServer({ issParameterSupported: true });
      const { authorizeUrl, code } = await begin();
      const resp = await redirect(authorizeUrl, okParams(authorizeUrl, code));
      expect(resp.status).toBe(400);
      await expectRejected();
      expect(ide.showToast.mock.calls[0][1]).toContain("no `iss` parameter");
    });

    test("the matching iss is accepted", async () => {
      await startServer({ issParameterSupported: true });
      const { authorizeUrl, code } = await begin();
      const resp = await redirect(authorizeUrl, {
        ...okParams(authorizeUrl, code),
        iss: mock.base,
      });
      expect(resp.status).toBe(200);
      await waitFor(() => connection().status === "connected", "connected");
      expect(mock.grants).toEqual(["authorization_code"]);
    });

    test("without advertised support, a missing iss is accepted", async () => {
      await startServer();
      const { authorizeUrl, code } = await begin();
      const resp = await redirect(authorizeUrl, okParams(authorizeUrl, code));
      expect(resp.status).toBe(200);
      await waitFor(() => connection().status === "connected", "connected");
    });

    test("without advertised support, a wrong iss is still rejected", async () => {
      await startServer();
      const { authorizeUrl, code } = await begin();
      const resp = await redirect(authorizeUrl, {
        ...okParams(authorizeUrl, code),
        iss: "https://evil.example",
      });
      expect(resp.status).toBe(400);
      await expectRejected();
    });

    test("a response with an unknown state is refused and does not cancel the waiting sign-in", async () => {
      await startServer();
      const { authorizeUrl, code } = await begin();
      const stray = await redirect(authorizeUrl, { code, state: "not-ours" });
      expect(stray.status).toBe(400);
      expect(ide.showToast).not.toHaveBeenCalled();
      expect(mock.grants).toEqual([]);

      const real = await redirect(authorizeUrl, okParams(authorizeUrl, code));
      expect(real.status).toBe(200);
      await waitFor(() => connection().status === "connected", "connected");
    });
  });

  describe("registration", () => {
    test("DCR sends application_type native and a redirect URI without ?state=", async () => {
      await startServer();
      const { authorizeUrl, code } = await begin();
      expect(mock.registrations).toHaveLength(1);
      const registered = mock.registrations[0];
      expect(registered.application_type).toBe("native");
      expect(registered.token_endpoint_auth_method).toBe("none");
      const uris = registered.redirect_uris as string[];
      expect(uris).toEqual([`http://localhost:${callbackPort}`]);
      expect(uris[0]).not.toContain("?");
      // exact match with what the authorization request carries
      expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(uris[0]);
      // our own state travels in the authorization request instead
      expect(authorizeUrl.searchParams.get("state")).toBeTruthy();
      expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe(
        "S256",
      );
      await redirect(authorizeUrl, okParams(authorizeUrl, code));
      await waitFor(() => connection().status === "connected", "connected");
    });

    test("the resource indicator (RFC 8707) is sent in both requests", async () => {
      await startServer();
      const { authorizeUrl, code } = await begin();
      expect(authorizeUrl.searchParams.get("resource")).toBe(mock.mcpUrl);
      await redirect(authorizeUrl, okParams(authorizeUrl, code));
      await waitFor(() => connection().status === "connected", "connected");
      const exchange = mock.tokenRequests[0].form;
      expect(exchange.resource).toBe(mock.mcpUrl);
      expect(exchange.code_verifier).toBeTruthy();
    });
  });

  describe("static client", () => {
    test("a confidential client skips registration and authenticates with its secret", async () => {
      await startServer(
        { dcr: false, staticClient: { id: STATIC_ID, secret: STATIC_SECRET } },
        { clientId: STATIC_ID, clientSecret: STATIC_SECRET },
      );
      const { authorizeUrl, code } = await begin();
      expect(authorizeUrl.searchParams.get("client_id")).toBe(STATIC_ID);
      await redirect(authorizeUrl, okParams(authorizeUrl, code));
      await waitFor(() => connection().status === "connected", "connected");

      expect(mock.registrations).toEqual([]);
      expect(mock.requests).not.toContain("POST /register");
      expect(mock.tokenRequests[0].basicAuth).toBe(
        `${STATIC_ID}:${STATIC_SECRET}`,
      );
      // the secret comes from config; it is not copied into the token store
      expect(JSON.stringify(stored())).not.toContain(STATIC_SECRET);
    });

    test("a public client sends only its client id", async () => {
      await startServer(
        { dcr: false, staticClient: { id: STATIC_ID } },
        { clientId: STATIC_ID },
      );
      const { authorizeUrl, code } = await begin();
      await redirect(authorizeUrl, okParams(authorizeUrl, code));
      await waitFor(() => connection().status === "connected", "connected");
      const request = mock.tokenRequests[0];
      expect(request.basicAuth).toBeUndefined();
      expect(request.form.client_id).toBe(STATIC_ID);
      expect(request.form.client_secret).toBeUndefined();
    });

    test("a server without registration and no configured client fails clearly", async () => {
      await startServer({ dcr: false });
      await expect(
        performAuth(serverId, mock.mcpUrl, ide as unknown as IDE, {
          callbackPort,
        }),
      ).rejects.toThrow(/dynamic client registration/i);
      expect(stored()).toBeUndefined();
    });
  });

  describe("loopback listener", () => {
    const nonLoopbackIPv4 = () =>
      Object.values(os.networkInterfaces())
        .flat()
        .filter((i) => i && i.family === "IPv4" && !i.internal)
        .map((i) => i!.address);

    /** "connected" is the failure; a refusal or a silent drop both mean closed. */
    function probe(host: string) {
      return new Promise<"connected" | "closed">((resolve) => {
        const socket = net.connect({ host, port: callbackPort });
        socket.setTimeout(1500, () => {
          socket.destroy();
          resolve("closed");
        });
        socket.once("connect", () => {
          socket.destroy();
          resolve("connected");
        });
        socket.once("error", () => resolve("closed"));
      });
    }

    test("the default redirect host is localhost and the listener binds loopback only", async () => {
      await startServer();
      const { authorizeUrl } = await begin();
      expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
        `http://localhost:${callbackPort}`,
      );
      const addresses = getCallbackListenAddresses(callbackPort);
      expect(addresses).toContain("127.0.0.1");
      for (const address of addresses) {
        expect(["127.0.0.1", "::1"]).toContain(address);
      }
      expect(addresses).not.toContain("0.0.0.0");
      expect(addresses).not.toContain("::");
      // and from the outside: another local interface cannot reach the port
      for (const address of nonLoopbackIPv4()) {
        expect(await probe(address)).toBe("closed");
      }
    });

    test("redirectHost 127.0.0.1 puts the IP literal in the URI and binds only IPv4", async () => {
      await startServer({}, { redirectHost: "127.0.0.1" });
      const { authorizeUrl } = await begin();
      expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
        `http://127.0.0.1:${callbackPort}`,
      );
      expect(mock.registrations[0].redirect_uris).toEqual([
        `http://127.0.0.1:${callbackPort}`,
      ]);
      expect(getCallbackListenAddresses(callbackPort)).toEqual(["127.0.0.1"]);
    });

    test("the listener is closed once the sign-in is rejected", async () => {
      await startServer({ issParameterSupported: true });
      const { authorizeUrl, code } = await begin();
      await redirect(authorizeUrl, okParams(authorizeUrl, code));
      await expectRejected();
      await waitFor(
        () => getCallbackListenAddresses(callbackPort).length === 0,
        "the listener to close",
      );
    });
  });

  describe("logging", () => {
    test("no token, code, verifier or client secret reaches the console", async () => {
      const lines: string[] = [];
      for (const method of LOG_METHODS) {
        vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          lines.push(
            args
              .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
              .join(" "),
          );
        });
      }
      await startServer(
        {
          dcr: false,
          issParameterSupported: true,
          staticClient: { id: STATIC_ID, secret: STATIC_SECRET },
        },
        { clientId: STATIC_ID, clientSecret: STATIC_SECRET },
      );
      // a rejected sign-in logs too
      const rejected = await begin();
      await redirect(rejected.authorizeUrl, {
        ...okParams(rejected.authorizeUrl, rejected.code),
        iss: "https://evil.example",
      });
      await waitFor(() => ide.showToast.mock.calls.length > 0, "a toast");

      const { authorizeUrl, code } = await begin();
      await redirect(authorizeUrl, {
        ...okParams(authorizeUrl, code),
        iss: mock.base,
      });
      await waitFor(() => connection().status === "connected", "connected");
      mock.expireAccessTokens();
      await MCPManagerSingleton.getInstance().refreshConnection(serverId);
      const tokens = stored()?.tokens;

      const verifier = mock.tokenRequests[0].form.code_verifier;
      const secrets = [
        tokens?.access_token,
        tokens?.refresh_token,
        code,
        rejected.code,
        verifier,
        STATIC_SECRET,
      ];
      expect(secrets.every(Boolean)).toBe(true);

      const output = lines.join("\n");
      expect(lines.length).toBeGreaterThan(0);
      for (const secret of secrets) {
        expect(output).not.toContain(secret as string);
      }
      const known = knownValueMatcher(secrets as string[], 4);
      expect(scanText(output, "at-rest", { known })).toEqual([]);
      expect(scanText(output, "outbound", { known })).toEqual([]);
    });
  });
});

describe.skipIf(!hasOpenssl())(
  "MCP OAuth hardening over TLS with a private CA",
  { timeout: 20_000 },
  () => {
    let ca: ReturnType<typeof createTestCa>;
    let mock: MockOAuthMcpServer;
    let ide: {
      openUrl: ReturnType<typeof vi.fn>;
      showToast: ReturnType<typeof vi.fn>;
    };
    let callbackPort: number;
    let globalContextFile: string;
    const serverId = "hardening-tls";
    const connection = () =>
      MCPManagerSingleton.getInstance().getConnection(serverId)!;

    beforeAll(() => {
      ca = createTestCa();
    });
    afterAll(() => ca.cleanup());

    beforeEach(async () => {
      globalContextFile = getGlobalContextFilePath();
      if (fs.existsSync(globalContextFile)) fs.unlinkSync(globalContextFile);
      ide = {
        openUrl: vi.fn(async () => {}),
        showToast: vi.fn(async () => {}),
      };
      callbackPort = await freePort();
      await CertsCache.getInstance().clear();
    });

    afterEach(async () => {
      await MCPManagerSingleton.getInstance().shutdown();
      await mock?.stop();
      if (fs.existsSync(globalContextFile)) fs.unlinkSync(globalContextFile);
    });

    async function start(mockOptions: MockOptions, settings: McpOauthSettings) {
      mock = new MockOAuthMcpServer({ tls: ca.tls, ...mockOptions });
      await mock.start();
      MCPManagerSingleton.getInstance().setConnections(
        [
          {
            id: serverId,
            name: serverId,
            type: "streamable-http",
            url: mock.mcpUrl,
            oauth: { callbackPort, ...settings },
            requestOptions: { caBundlePath: ca.caPath },
          } as any,
        ],
        true,
        { ide: ide as unknown as IDE },
      );
      await waitFor(
        () => ["error", "connected"].includes(connection().status),
        "the first connection attempt",
      );
    }

    async function signIn(settings: McpOauthSettings, iss: string) {
      await performAuth(serverId, mock.mcpUrl, ide as unknown as IDE, {
        ...oauthOptionsFromSettings({ callbackPort, ...settings }),
        fetchFn: connection().getFetch() as any,
      });
      const authorizeUrl = new URL(ide.openUrl.mock.calls.at(-1)![0]);
      const callback = new URL(authorizeUrl.searchParams.get("redirect_uri")!);
      callback.searchParams.set(
        "code",
        mock.issueCode(authorizeUrl.searchParams.get("code_challenge")!),
      );
      callback.searchParams.set(
        "state",
        authorizeUrl.searchParams.get("state")!,
      );
      callback.searchParams.set("iss", iss);
      return (await fetch(callback)).status;
    }

    test("a static client signs in over TLS and a wrong iss is rejected", async () => {
      const settings = { clientId: STATIC_ID, clientSecret: STATIC_SECRET };
      await start(
        {
          dcr: false,
          issParameterSupported: true,
          staticClient: { id: STATIC_ID, secret: STATIC_SECRET },
        },
        settings,
      );
      expect(await signIn(settings, "https://evil.example")).toBe(400);
      await waitFor(
        () => ide.showToast.mock.calls.length > 0,
        "an error toast",
      );
      expect(mock.grants).toEqual([]);

      expect(await signIn(settings, mock.base)).toBe(200);
      await waitFor(() => connection().status === "connected", "connected");
      expect(mock.registrations).toEqual([]);
    });
  },
);
