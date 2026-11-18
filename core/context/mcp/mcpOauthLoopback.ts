import http from "http";

/** Port of the local redirect server when `oauth.callbackPort` is not set. */
export const DEFAULT_OAUTH_CALLBACK_PORT = 3000;

/**
 * Host name written into the redirect URI.
 *
 * "localhost" is the long-standing default and what servers that registered a
 * redirect URL for an earlier version expect. RFC 8252 section 8.3 says
 * localhost is NOT RECOMMENDED in favour of the loopback IP literal, which is
 * selectable per server with `oauth.redirectHost: 127.0.0.1`. Whichever is
 * used, the listener only ever binds loopback addresses (see
 * `loopbackBindAddresses`).
 */
export const OAUTH_REDIRECT_HOSTS = ["localhost", "127.0.0.1"] as const;
export type OauthRedirectHost = (typeof OAUTH_REDIRECT_HOSTS)[number];
export const DEFAULT_OAUTH_REDIRECT_HOST: OauthRedirectHost = "localhost";

export function getOauthCallbackUrl(
  port = DEFAULT_OAUTH_CALLBACK_PORT,
  host: OauthRedirectHost = DEFAULT_OAUTH_REDIRECT_HOST,
) {
  return `http://${host}:${port}`;
}

/**
 * Addresses the callback listener binds, never a wildcard. A "localhost"
 * redirect may be resolved by the browser to either family, so both loopback
 * addresses are served; the IP literal needs only its own family.
 */
export function loopbackBindAddresses(host: OauthRedirectHost): string[] {
  return host === "127.0.0.1" ? ["127.0.0.1"] : ["127.0.0.1", "::1"];
}

/** IPv6 may be switched off on the machine; that is not an error for `::1`. */
const IPV6_UNAVAILABLE = new Set(["EADDRNOTAVAIL", "EAFNOSUPPORT", "EINVAL"]);

function listenOn(server: http.Server, port: number, address: string) {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => reject(err);
    server.once("error", onError);
    server.listen({ port, host: address }, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

/**
 * Start one server per loopback address on `port`. All of them are closed
 * again if any fails (other than IPv6 being unavailable).
 */
export async function listenOnLoopback(
  port: number,
  host: OauthRedirectHost,
  makeServer: () => http.Server,
): Promise<http.Server[]> {
  const started: http.Server[] = [];
  try {
    for (const address of loopbackBindAddresses(host)) {
      const server = makeServer();
      try {
        await listenOn(server, port, address);
        started.push(server);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? "";
        if (address === "::1" && IPV6_UNAVAILABLE.has(code)) continue;
        throw err;
      }
    }
    return started;
  } catch (err) {
    await closeServers(started);
    throw err;
  }
}

export async function closeServers(servers: http.Server[]): Promise<void> {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          // Don't wait on idle keep-alive connections from the browser
          (server as any).closeIdleConnections?.();
        }),
    ),
  );
}
