import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  getProxyFromEnv,
  patternMatchesHostname,
  resetProxyWarning,
  shouldBypassProxy,
} from "./util.js";

// Each test starts with no proxy variables, whatever the machine running it
// has set (CI behind a proxy, a corporate laptop), and the real environment
// comes back afterwards.
const PROXY_VARS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
];
const originalEnv = process.env;

beforeEach(() => {
  process.env = { ...originalEnv };
  for (const name of PROXY_VARS) delete process.env[name];
});

afterEach(() => {
  vi.resetModules();
  process.env = originalEnv;
});

// Tests for getProxyFromEnv
test("getProxyFromEnv returns undefined when no proxy is set", () => {
  expect(getProxyFromEnv("http:")).toBeUndefined();
  expect(getProxyFromEnv("https:")).toBeUndefined();
});

test("getProxyFromEnv returns HTTP_PROXY for http protocol", () => {
  process.env.HTTP_PROXY = "http://proxy.example.com";
  expect(getProxyFromEnv("http:")).toBe("http://proxy.example.com");
});

test("getProxyFromEnv returns lowercase http_proxy for http protocol", () => {
  process.env.http_proxy = "http://proxy.example.com";
  expect(getProxyFromEnv("http:")).toBe("http://proxy.example.com");
});

test("getProxyFromEnv prefers lower case http_proxy over HTTP_PROXY (as Node and curl do)", () => {
  process.env.HTTP_PROXY = "http://upper.example.com";
  process.env.http_proxy = "http://lower.example.com";
  expect(getProxyFromEnv("http:")).toBe("http://lower.example.com");
});

test("getProxyFromEnv returns HTTPS_PROXY for https protocol", () => {
  process.env.HTTPS_PROXY = "https://secure.example.com";
  expect(getProxyFromEnv("https:")).toBe("https://secure.example.com");
});

test("getProxyFromEnv returns lowercase https_proxy for https protocol", () => {
  process.env.https_proxy = "https://secure.example.com";
  expect(getProxyFromEnv("https:")).toBe("https://secure.example.com");
});

test("getProxyFromEnv does not use HTTP_PROXY for https and warns once", () => {
  resetProxyWarning();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  process.env.HTTP_PROXY = "http://plain.example.com";
  expect(getProxyFromEnv("https:")).toBeUndefined();
  expect(getProxyFromEnv("https:")).toBeUndefined();
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0][0])).toContain("HTTPS_PROXY");
  warn.mockRestore();
});

test("getProxyFromEnv does not use HTTPS_PROXY for http", () => {
  process.env.HTTPS_PROXY = "http://secure.example.com";
  expect(getProxyFromEnv("http:")).toBeUndefined();
});

test("getProxyFromEnv ignores other schemes", () => {
  process.env.HTTP_PROXY = "http://p.example.com";
  process.env.HTTPS_PROXY = "http://p.example.com";
  expect(getProxyFromEnv("ws:")).toBeUndefined();
});

test("NO_PROXY: lower case no_proxy wins over NO_PROXY", () => {
  process.env.NO_PROXY = "a.example.com";
  process.env.no_proxy = "b.example.com";
  expect(shouldBypassProxy("b.example.com", undefined)).toBe(true);
  expect(shouldBypassProxy("a.example.com", undefined)).toBe(false);
});

test("NO_PROXY matching rules: suffix on a dot boundary, wildcard, port, CIDR, star", () => {
  process.env.NO_PROXY =
    "example.com,*.wild.test,host.test:8443,10.0.0.0/8,[::1]";
  const bypass = (h: string) => shouldBypassProxy(h, undefined);
  expect(bypass("example.com")).toBe(true);
  expect(bypass("api.example.com")).toBe(true);
  expect(bypass("notexample.com")).toBe(false);
  expect(bypass("wild.test")).toBe(false);
  expect(bypass("x.wild.test")).toBe(true);
  expect(bypass("host.test")).toBe(false);
  expect(bypass("host.test:8443")).toBe(true);
  expect(bypass("10.1.2.3")).toBe(true);
  expect(bypass("11.1.2.3")).toBe(false);
  process.env.NO_PROXY = "*";
  expect(bypass("anything.test")).toBe(true);
});

test("getProxyFromEnv prefers https_proxy over other env vars for https protocol", () => {
  process.env.https_proxy = "https://preferred.example.com";
  process.env.HTTPS_PROXY = "https://notused1.example.com";
  process.env.HTTP_PROXY = "http://notused2.example.com";
  process.env.http_proxy = "http://notused3.example.com";
  expect(getProxyFromEnv("https:")).toBe("https://preferred.example.com");
});

// Tests for patternMatchesHostname
test("patternMatchesHostname with exact hostname match", () => {
  expect(patternMatchesHostname("example.com", "example.com")).toBe(true);
  expect(patternMatchesHostname("example.com", "different.com")).toBe(false);
});

test("patternMatchesHostname with wildcard domains", () => {
  expect(patternMatchesHostname("sub.example.com", "*.example.com")).toBe(true);
  expect(patternMatchesHostname("sub.sub.example.com", "*.example.com")).toBe(
    true,
  );
  expect(patternMatchesHostname("example.com", "*.example.com")).toBe(false);
  expect(patternMatchesHostname("sub.different.com", "*.example.com")).toBe(
    false,
  );
});

test("patternMatchesHostname with domain suffix", () => {
  expect(patternMatchesHostname("sub.example.com", ".example.com")).toBe(true);
  expect(patternMatchesHostname("example.com", ".example.com")).toBe(true);
  expect(patternMatchesHostname("different.com", ".example.com")).toBe(false);
});

test("patternMatchesHostname with case insensitivity", () => {
  expect(patternMatchesHostname("EXAMPLE.com", "example.COM")).toBe(true);
  expect(patternMatchesHostname("sub.EXAMPLE.com", "*.example.COM")).toBe(true);
});

// Port handling tests
test("patternMatchesHostname with exact port match", () => {
  expect(patternMatchesHostname("example.com:8080", "example.com:8080")).toBe(
    true,
  );
  expect(patternMatchesHostname("example.com:8080", "example.com:9090")).toBe(
    false,
  );
});

test("patternMatchesHostname with port in pattern but not in hostname", () => {
  expect(patternMatchesHostname("example.com", "example.com:8080")).toBe(false);
});

test("patternMatchesHostname with port in hostname but not in pattern", () => {
  expect(patternMatchesHostname("example.com:8080", "example.com")).toBe(true);
});

test("patternMatchesHostname with wildcard domains and ports", () => {
  expect(
    patternMatchesHostname("sub.example.com:8080", "*.example.com:8080"),
  ).toBe(true);
  expect(
    patternMatchesHostname("sub.example.com:9090", "*.example.com:8080"),
  ).toBe(false);
  expect(patternMatchesHostname("sub.example.com", "*.example.com:8080")).toBe(
    false,
  );
});

test("patternMatchesHostname with domain suffix and ports", () => {
  expect(
    patternMatchesHostname("sub.example.com:8080", ".example.com:8080"),
  ).toBe(true);
  expect(patternMatchesHostname("example.com:8080", ".example.com:8080")).toBe(
    true,
  );
  expect(
    patternMatchesHostname("sub.example.com:9090", ".example.com:8080"),
  ).toBe(false);
});

// Tests for shouldBypassProxy
test("shouldBypassProxy returns false when NO_PROXY is not set", () => {
  expect(shouldBypassProxy("example.com", undefined)).toBe(false);
});

test("shouldBypassProxy returns true for exact hostname match", () => {
  process.env.NO_PROXY = "example.com,another.com";
  expect(shouldBypassProxy("example.com", undefined)).toBe(true);
});

test("shouldBypassProxy returns false when hostname doesn't match any NO_PROXY entry", () => {
  process.env.NO_PROXY = "example.com,another.com";
  expect(shouldBypassProxy("different.com", undefined)).toBe(false);
});

test("shouldBypassProxy handles lowercase no_proxy", () => {
  process.env.no_proxy = "example.com";
  expect(shouldBypassProxy("example.com", undefined)).toBe(true);
});

test("shouldBypassProxy works with wildcard domains", () => {
  process.env.NO_PROXY = "*.example.com";
  expect(shouldBypassProxy("sub.example.com", undefined)).toBe(true);
  expect(shouldBypassProxy("example.com", undefined)).toBe(false);
  expect(shouldBypassProxy("different.com", undefined)).toBe(false);
});

test("shouldBypassProxy works with domain suffix", () => {
  process.env.NO_PROXY = ".example.com";
  expect(shouldBypassProxy("sub.example.com", undefined)).toBe(true);
  expect(shouldBypassProxy("example.com", undefined)).toBe(true);
  expect(shouldBypassProxy("different.com", undefined)).toBe(false);
});

test("shouldBypassProxy handles multiple entries with different patterns", () => {
  process.env.NO_PROXY = "internal.local,*.example.com,.test.com";
  expect(shouldBypassProxy("internal.local", undefined)).toBe(true);
  expect(shouldBypassProxy("sub.example.com", undefined)).toBe(true);
  expect(shouldBypassProxy("sub.test.com", undefined)).toBe(true);
  expect(shouldBypassProxy("test.com", undefined)).toBe(true);
  expect(shouldBypassProxy("example.org", undefined)).toBe(false);
});

test("shouldBypassProxy ignores whitespace in NO_PROXY", () => {
  process.env.NO_PROXY = " example.com , *.test.org ";
  expect(shouldBypassProxy("example.com", undefined)).toBe(true);
  expect(shouldBypassProxy("subdomain.test.org", undefined)).toBe(true);
});

test("shouldBypassProxy with ports in NO_PROXY", () => {
  process.env.NO_PROXY = "example.com:8080,*.test.org:443,.internal.net:8443";
  expect(shouldBypassProxy("example.com:8080", undefined)).toBe(true);
  expect(shouldBypassProxy("example.com:9090", undefined)).toBe(false);
  expect(shouldBypassProxy("sub.test.org:443", undefined)).toBe(true);
  expect(shouldBypassProxy("sub.internal.net:8443", undefined)).toBe(true);
  expect(shouldBypassProxy("internal.net:8443", undefined)).toBe(true);
});

test("shouldBypassProxy accepts options with noProxy patterns", () => {
  const options = { noProxy: ["example.com:8080", "*.internal.net"] };
  expect(shouldBypassProxy("example.com:8080", options)).toBe(true);
  expect(shouldBypassProxy("example.com", options)).toBe(false);
  expect(shouldBypassProxy("server.internal.net", options)).toBe(true);
});

test("shouldBypassProxy combines environment and options noProxy patterns", () => {
  process.env.NO_PROXY = "example.org,*.test.com";
  const options = { noProxy: ["example.com:8080", "*.internal.net"] };
  expect(shouldBypassProxy("example.org", options)).toBe(true);
  expect(shouldBypassProxy("sub.test.com", options)).toBe(true);
  expect(shouldBypassProxy("example.com:8080", options)).toBe(true);
  expect(shouldBypassProxy("server.internal.net", options)).toBe(true);
  expect(shouldBypassProxy("other.domain", options)).toBe(false);
});

test("shouldBypassProxy handles empty noProxy array in options", () => {
  process.env.NO_PROXY = "example.org";
  const options = { noProxy: [] };
  expect(shouldBypassProxy("example.org", options)).toBe(true);
  expect(shouldBypassProxy("different.com", options)).toBe(false);
});

test("shouldBypassProxy handles undefined options", () => {
  process.env.NO_PROXY = "example.org";
  expect(shouldBypassProxy("example.org", undefined)).toBe(true);
});

test("shouldBypassProxy handles non-string NO_PROXY value", () => {
  // In some environments, env values may not be strings
  (process.env as any).NO_PROXY = 1234;
  expect(shouldBypassProxy("example.com", undefined)).toBe(false);
});

test("a leading-dot suffix does not match a different label", () => {
  expect(
    patternMatchesHostname("evilcorp.example.com", ".corp.example.com"),
  ).toBe(false);
  expect(patternMatchesHostname("notexample.com", ".example.com")).toBe(false);
  expect(
    patternMatchesHostname("foo.corp.example.com", ".corp.example.com"),
  ).toBe(true);
  expect(patternMatchesHostname("corp.example.com", ".corp.example.com")).toBe(
    true,
  );
});

test("a bare domain matches that host and its subdomains", () => {
  expect(patternMatchesHostname("example.com", "example.com")).toBe(true);
  expect(patternMatchesHostname("sub.example.com", "example.com")).toBe(true);
  expect(patternMatchesHostname("notexample.com", "example.com")).toBe(false);
});

test("NO_PROXY=* matches every host", () => {
  expect(patternMatchesHostname("example.com", "*")).toBe(true);
  expect(patternMatchesHostname("10.1.2.3", "*")).toBe(true);
});

test("CIDR entries match addresses inside the prefix", () => {
  expect(patternMatchesHostname("10.1.2.3", "10.0.0.0/8")).toBe(true);
  expect(patternMatchesHostname("11.0.0.1", "10.0.0.0/8")).toBe(false);
  expect(patternMatchesHostname("192.168.1.9", "192.168.0.0/16")).toBe(true);
  expect(patternMatchesHostname("fe80::1", "fe80::/10")).toBe(true);
  expect(patternMatchesHostname("2001:db8::1", "fe80::/10")).toBe(false);
});
