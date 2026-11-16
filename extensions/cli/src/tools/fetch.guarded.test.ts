import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { url: string; init: any; options: any }[] = [];
let reply: (url: string) => Response = () =>
  new Response("page body", { headers: { "content-type": "text/plain" } });

// The network layer: record what reaches the HTTP client instead of sending it
vi.mock("@continuedev/fetch", async (importActual) => {
  const actual = await importActual<typeof import("@continuedev/fetch")>();
  return {
    ...actual,
    fetchwithRequestOptions: vi.fn(
      async (url: any, init: any, options: any) => {
        calls.push({ url: String(url), init, options });
        return reply(String(url));
      },
    ),
  };
});

let config: any = null;
vi.mock("../services/index.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/index.js")>();
  return {
    ...actual,
    getServiceSync: vi.fn(() => ({ value: { config } })),
  };
});

import { fetchTool } from "./fetch.js";

describe("CLI Fetch uses the hardened fetch", () => {
  beforeEach(() => {
    calls.length = 0;
    reply = () =>
      new Response("page body", { headers: { "content-type": "text/plain" } });
    config = {
      requestOptions: {
        proxy: "http://proxy.corp:3128",
        caBundlePath: "/etc/corp-ca.pem",
        verifySsl: false,
        headers: { "X-Gateway-Token": "secret" },
      },
      models: [{ apiBase: "https://gateway.corp/v1" }],
    };
  });

  it("pins the connection to the checked address", async () => {
    const out = await fetchTool.run({ url: "http://93.184.216.34/page" });
    expect(out).toContain("page body");
    expect(calls).toHaveLength(1);
    expect(typeof calls[0].init.lookup).toBe("function");
  });

  it("passes proxy, CA and TLS settings but not the gateway headers", async () => {
    await fetchTool.run({ url: "http://93.184.216.34/page" });
    expect(calls[0].options).toMatchObject({
      proxy: "http://proxy.corp:3128",
      caBundlePath: "/etc/corp-ca.pem",
      verifySsl: false,
    });
    expect(calls[0].options.headers).toBeUndefined();
  });

  it("still pins when no config is loaded", async () => {
    config = null;
    await fetchTool.run({ url: "http://93.184.216.34/page" });
    expect(typeof calls[0].init.lookup).toBe("function");
  });

  it("starts the output with the core provenance line", async () => {
    const out = await fetchTool.run({ url: "http://93.184.216.34/page" });
    expect(out).toMatch(
      /^\[fetched http:\/\/93\.184\.216\.34\/page · 200 text\/plain · 9 B · .* · sha256:[0-9a-f]{12} · robots: not checked · rule: builtin:public · unencrypted\]\n\npage body/,
    );
  });

  it("refuses a redirect to the metadata address, as the IDE tool does", async () => {
    reply = (url) =>
      url.includes("169.254")
        ? new Response("metadata", { status: 200 })
        : new Response(null, {
            status: 302,
            headers: { location: "http://169.254.169.254/latest/meta-data/" },
          });
    // A typed result the model reads, not a thrown error (WB41)
    const out = await fetchTool.run({ url: "http://93.184.216.34/page" });
    expect(out).toMatch(
      /non-public address \(169\.254\.169\.254.*Do not retry it unchanged\.$/s,
    );
    expect(calls.map((c) => c.url)).toEqual(["http://93.184.216.34/page"]);
  });
});
