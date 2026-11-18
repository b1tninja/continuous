import { describe, expect, test } from "vitest";
import { checkAuthorizationIssuer } from "./mcpOauthIssuer";
import {
  DEFAULT_OAUTH_REDIRECT_HOST,
  getOauthCallbackUrl,
  loopbackBindAddresses,
} from "./mcpOauthLoopback";

describe("checkAuthorizationIssuer (RFC 9207 section 2.4)", () => {
  const expectedIssuer = "https://as.example";

  test("a matching iss passes", () => {
    expect(
      checkAuthorizationIssuer({
        iss: expectedIssuer,
        expectedIssuer,
        issParameterSupported: true,
      }),
    ).toEqual({ ok: true });
  });

  test("the comparison is a simple string comparison", () => {
    for (const iss of [
      "https://as.example/",
      "HTTPS://as.example",
      "https://as.example ",
    ]) {
      expect(
        checkAuthorizationIssuer({
          iss,
          expectedIssuer,
          issParameterSupported: false,
        }).ok,
      ).toBe(false);
    }
  });

  test("a mismatch is rejected whether or not support is advertised", () => {
    for (const issParameterSupported of [true, false]) {
      expect(
        checkAuthorizationIssuer({
          iss: "https://evil.example",
          expectedIssuer,
          issParameterSupported,
        }).ok,
      ).toBe(false);
    }
  });

  test("a missing iss is rejected only when the server advertises support", () => {
    expect(
      checkAuthorizationIssuer({
        iss: undefined,
        expectedIssuer,
        issParameterSupported: true,
      }).ok,
    ).toBe(false);
    expect(
      checkAuthorizationIssuer({
        iss: undefined,
        expectedIssuer,
        issParameterSupported: false,
      }).ok,
    ).toBe(true);
  });

  test("an iss with no known expected issuer is rejected", () => {
    expect(
      checkAuthorizationIssuer({
        iss: expectedIssuer,
        expectedIssuer: undefined,
        issParameterSupported: false,
      }).ok,
    ).toBe(false);
  });
});

describe("loopback settings", () => {
  test("the default redirect host stays localhost", () => {
    expect(DEFAULT_OAUTH_REDIRECT_HOST).toBe("localhost");
    expect(getOauthCallbackUrl(3000)).toBe("http://localhost:3000");
    expect(getOauthCallbackUrl(3456, "127.0.0.1")).toBe(
      "http://127.0.0.1:3456",
    );
  });

  test("bind addresses are loopback only, never a wildcard", () => {
    expect(loopbackBindAddresses("localhost")).toEqual(["127.0.0.1", "::1"]);
    expect(loopbackBindAddresses("127.0.0.1")).toEqual(["127.0.0.1"]);
  });
});
