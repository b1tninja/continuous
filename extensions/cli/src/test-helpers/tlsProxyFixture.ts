import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { Duplex } from "node:stream";

export function hasOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export interface TlsProxyFixture {
  caPath: string;
  /** https URL of the origin, signed by the throwaway CA. */
  url: string;
  /** http URL of a CONNECT proxy that tunnels to the origin. */
  proxyUrl: string;
  /** `host:port` of each CONNECT the proxy served. */
  connects: string[];
  close(): Promise<void>;
}

/**
 * A TLS origin whose certificate is signed by a throwaway CA, behind a CONNECT
 * proxy: the shape of a TLS-inspecting corporate network. Needs the `openssl`
 * CLI. `respond` answers every request to the origin.
 */
export async function startTlsProxyFixture(
  respond: (req: http.IncomingMessage, res: http.ServerResponse) => void = (
    req,
    res,
  ) => {
    req.resume();
    req.on("end", () => res.end("hello"));
  },
): Promise<TlsProxyFixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-tls-proxy-"));
  const openssl = (...args: string[]) =>
    execFileSync("openssl", args, {
      cwd: dir,
      stdio: "ignore",
      // Git's openssl would otherwise rewrite "/CN=..." as a path.
      env: { ...process.env, MSYS_NO_PATHCONV: "1" },
    });
  openssl(
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
    "-days",
    "2",
    "-subj",
    "/CN=Test Inspection Root",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  );
  openssl(
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "srv.key",
    "-out",
    "srv.csr",
    "-subj",
    "/CN=localhost",
  );
  fs.writeFileSync(
    path.join(dir, "ext.cnf"),
    "subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n",
  );
  openssl(
    "x509",
    "-req",
    "-in",
    "srv.csr",
    "-CA",
    "ca.pem",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-out",
    "srv.pem",
    "-days",
    "2",
    "-extfile",
    "ext.cnf",
  );

  const server = https.createServer(
    {
      key: fs.readFileSync(path.join(dir, "srv.key")),
      cert: fs.readFileSync(path.join(dir, "srv.pem")),
    },
    respond,
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const serverPort = (server.address() as AddressInfo).port;

  const connects: string[] = [];
  const tunnels = new Set<Duplex>();
  const proxy = http.createServer();
  proxy.on("connect", (req, clientSocket, head) => {
    connects.push(req.url ?? "");
    tunnels.add(clientSocket);
    const upstream = net.connect(serverPort, "127.0.0.1", () => {
      tunnels.add(upstream);
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  const proxyPort = (proxy.address() as AddressInfo).port;

  return {
    caPath: path.join(dir, "ca.pem"),
    url: `https://127.0.0.1:${serverPort}/`,
    proxyUrl: `http://127.0.0.1:${proxyPort}`,
    connects,
    async close() {
      for (const socket of tunnels) socket.destroy();
      server.closeAllConnections?.();
      proxy.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      await new Promise((r) => proxy.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
