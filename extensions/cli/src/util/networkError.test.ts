import { describe, expect, it } from "vitest";

import { describeNetworkFailure } from "./networkError.js";

function fetchError(causeCode: string, hostname?: string) {
  const cause = Object.assign(new Error("getaddrinfo failed"), {
    code: causeCode,
    hostname,
  });
  const undici = new TypeError("fetch failed", { cause });
  const err = new Error(
    "The request failed and the interceptors did not return an alternative response",
  );
  err.name = "FetchError";
  (err as any).cause = undici;
  return err;
}

describe("describeNetworkFailure", () => {
  it("names the host and the fix for a DNS failure", () => {
    const d = describeNetworkFailure(
      fetchError("ENOTFOUND", "api.example.com"),
    );
    expect(d).toMatchObject({
      code: "network_unreachable",
      reason: "dns",
      host: "api.example.com",
    });
    expect(d?.message).toContain("Cannot reach api.example.com");
    expect(d?.message).toContain("--config");
    expect(d?.message).toContain("HTTPS_PROXY");
    expect(d?.message).not.toContain("interceptors");
  });

  it.each([
    ["ECONNREFUSED", "connect"],
    ["ETIMEDOUT", "timeout"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "tls"],
    ["SELF_SIGNED_CERT_IN_CHAIN", "tls"],
  ])("classifies %s as %s", (code, reason) => {
    expect(describeNetworkFailure(fetchError(code))?.reason).toBe(reason);
  });

  it("treats the bare generic FetchError as an unknown network failure", () => {
    const err = new Error("x");
    err.name = "FetchError";
    expect(describeNetworkFailure(err)).toMatchObject({ reason: "unknown" });
  });

  it("ignores other errors", () => {
    expect(describeNetworkFailure(new Error("Invalid YAML"))).toBeUndefined();
    expect(describeNetworkFailure("boom")).toBeUndefined();
  });

  it("never echoes a URL or credentials", () => {
    const err = fetchError("ENOTFOUND", "https://user:secret@host/x?key=abc");
    const d = describeNetworkFailure(err);
    expect(JSON.stringify(d)).not.toMatch(/secret|key=abc|https:/);
  });
});
