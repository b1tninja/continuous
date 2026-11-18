import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { constructHttpTransport } from "../services/mcpTransports.js";
import {
  hasOpenssl,
  startTlsProxyFixture,
  type TlsProxyFixture,
} from "../test-helpers/tlsProxyFixture.js";

import { cliFetch, networkFetch, transportOptions } from "./networkFetch.js";

const ENV = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
];

describe("transportOptions", () => {
  it("drops model-only options", () => {
    expect(
      transportOptions({
        proxy: "http://p:1",
        headers: { "X-Gateway": "secret" },
        extraBodyProperties: { a: 1 },
        verifySsl: false,
      }),
    ).toEqual({ proxy: "http://p:1", verifySsl: false });
  });
});

describe.skipIf(!hasOpenssl())(
  "CLI requests behind a TLS-inspecting proxy",
  () => {
    let fixture: TlsProxyFixture;
    let seenHeaders: Record<string, unknown>[] = [];

    beforeAll(async () => {
      fixture = await startTlsProxyFixture((req, res) => {
        seenHeaders.push({ ...req.headers });
        req.resume();
        req.on("end", () => res.end("hello"));
      });
    });
    afterAll(async () => fixture.close());
    beforeEach(() => {
      seenHeaders = [];
      fixture.connects.length = 0;
      for (const k of ENV) delete process.env[k];
    });

    it("cliFetch uses the configured proxy and trusts the CA bundle", async () => {
      const resp = await cliFetch(fixture.url, undefined, {
        proxy: fixture.proxyUrl,
        caBundlePath: fixture.caPath,
        useSystemCa: false,
      });
      expect(await resp.text()).toBe("hello");
      expect(fixture.connects).toHaveLength(1);
    });

    it("cliFetch follows HTTPS_PROXY from the environment", async () => {
      process.env.HTTPS_PROXY = fixture.proxyUrl;
      const resp = await cliFetch(fixture.url, undefined, {
        caBundlePath: fixture.caPath,
        useSystemCa: false,
      });
      expect(await resp.text()).toBe("hello");
      expect(fixture.connects).toHaveLength(1);
    });

    it("rejects an untrusted certificate", async () => {
      await expect(
        cliFetch(fixture.url, undefined, {
          proxy: fixture.proxyUrl,
          useSystemCa: false,
        }),
      ).rejects.toThrow(/certificate/i);
    });

    it("does not send model-only headers to the host", async () => {
      await networkFetch({
        proxy: fixture.proxyUrl,
        caBundlePath: fixture.caPath,
        useSystemCa: false,
        headers: { "X-Gateway": "secret" },
      })(fixture.url);
      expect(seenHeaders[0]["x-gateway"]).toBeUndefined();
    });

    it("the MCP streamable-http transport uses the server's proxy and CA", async () => {
      const transport = constructHttpTransport(
        {
          name: "t",
          type: "streamable-http",
          url: fixture.url,
          requestOptions: {
            proxy: fixture.proxyUrl,
            caBundlePath: fixture.caPath,
            useSystemCa: false,
          },
        } as never,
        "api-key",
      );
      expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
      // The SDK keeps the fetch it was given and sends every request with it.
      const fetchFn = (transport as unknown as { _fetch: typeof fetch })._fetch;
      const resp = await fetchFn(fixture.url, {
        method: "POST",
        body: "{}",
      });
      expect(await resp.text()).toBe("hello");
      expect(fixture.connects).toHaveLength(1);
    });
  },
);
