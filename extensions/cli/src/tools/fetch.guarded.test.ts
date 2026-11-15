import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { url: string; init: any; options: any }[] = [];

// The network layer: record what reaches the HTTP client instead of sending it
vi.mock("@continuedev/fetch", async (importActual) => {
  const actual = await importActual<typeof import("@continuedev/fetch")>();
  return {
    ...actual,
    fetchwithRequestOptions: vi.fn(
      async (url: any, init: any, options: any) => {
        calls.push({ url: String(url), init, options });
        return new Response("page body", {
          headers: { "content-type": "text/plain" },
        });
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
});
