import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { chromiumNetworkArgs } from "./chromiumNetworkArgs";

const VARS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
];

describe("chromiumNetworkArgs", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
    for (const k of VARS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const site = new URL("https://docs.example.com/");

  it("adds nothing without settings", () => {
    expect(chromiumNetworkArgs(site, undefined)).toEqual([]);
  });

  it("uses the configured proxy without its credentials", () => {
    expect(
      chromiumNetworkArgs(site, {
        proxy: "http://user:secret@proxy.corp:3128",
      }),
    ).toEqual(["--proxy-server=http://proxy.corp:3128"]);
  });

  it("uses HTTPS_PROXY for an https site and honours noProxy", () => {
    process.env.HTTPS_PROXY = "http://envproxy:8080";
    expect(chromiumNetworkArgs(site, undefined)).toEqual([
      "--proxy-server=http://envproxy:8080",
    ]);
    expect(chromiumNetworkArgs(site, { noProxy: ["example.com"] })).toEqual([]);
  });

  it("passes verifySsl: false", () => {
    expect(chromiumNetworkArgs(site, { verifySsl: false })).toEqual([
      "--ignore-certificate-errors",
    ]);
  });
});
