import { describe, expect, it } from "vitest";
import { originsOf, requestOptionsForUrl } from "./scopeHeaders.js";

const options = {
  headers: { "X-Gateway-Token": "tok" },
  extraBodyProperties: { user: "u" },
  proxy: "http://proxy.corp:8080",
  verifySsl: false,
};
const allowed = originsOf(["https://gateway.corp/v1", undefined, "not a url"]);

describe("requestOptionsForUrl", () => {
  it("keeps the headers for a configured model endpoint", () => {
    expect(
      requestOptionsForUrl(options, "https://gateway.corp/v1/chat", allowed),
    ).toBe(options);
  });

  it("drops headers and body properties for any other host", () => {
    const scoped = requestOptionsForUrl(
      options,
      new URL("https://evil.example/collect"),
      allowed,
    );
    expect(scoped).toEqual({
      proxy: "http://proxy.corp:8080",
      verifySsl: false,
    });
    // the input is not modified
    expect(options.headers).toBeDefined();
  });

  it("matches scheme and port, not only the host name", () => {
    for (const url of [
      "http://gateway.corp/",
      "https://gateway.corp:8443/",
      "https://gateway.corp.evil.example/",
    ]) {
      expect(requestOptionsForUrl(options, url, allowed)?.headers).toBe(
        undefined,
      );
    }
  });

  it("drops them when no origin is configured or the URL does not parse", () => {
    expect(
      requestOptionsForUrl(options, "https://gateway.corp/", new Set())
        ?.headers,
    ).toBeUndefined();
    expect(
      requestOptionsForUrl(options, "::::", allowed)?.headers,
    ).toBeUndefined();
  });

  it("passes options without headers through unchanged", () => {
    const plain = { proxy: "http://p:1" };
    expect(requestOptionsForUrl(plain, "https://x.test/", allowed)).toBe(plain);
    expect(requestOptionsForUrl(undefined, "https://x.test/", allowed)).toBe(
      undefined,
    );
  });
});
