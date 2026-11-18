import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchWithGuardedRedirects } from "./guardedFetch";
import { setHostResolver } from "./networkAddress";

const redirect = (location: string) => ({
  status: 302,
  headers: { get: (k: string) => (k === "location" ? location : null) },
});
const ok = { status: 200, headers: { get: () => null } };

describe("fetchWithGuardedRedirects", () => {
  afterEach(() => setHostResolver());

  const resolve = (table: Record<string, string>) =>
    setHostResolver(async (host) => [table[host] ?? "93.184.216.34"]);

  it("refuses a redirect from a public host to the metadata address", async () => {
    resolve({});
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        redirect("http://169.254.169.254/latest/meta-data/"),
      );
    await expect(
      fetchWithGuardedRedirects(new URL("https://docs.example.com/"), fetchFn),
    ).rejects.toThrow(/non-public/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect to a name that resolves to a private address", async () => {
    resolve({ "internal.example.com": "10.0.0.7" });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(redirect("https://internal.example.com/"));
    await expect(
      fetchWithGuardedRedirects(new URL("https://docs.example.com/"), fetchFn),
    ).rejects.toThrow(/non-public/);
  });

  it("follows a public redirect, with the connection pinned and redirects manual", async () => {
    resolve({});
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(redirect("https://www.example.com/docs"))
      .mockResolvedValueOnce(ok);
    const resp = await fetchWithGuardedRedirects(
      new URL("https://example.com/docs"),
      fetchFn,
    );
    expect(resp).toBe(ok);
    expect(String(fetchFn.mock.calls[1][0])).toBe(
      "https://www.example.com/docs",
    );
    expect(fetchFn.mock.calls[1][1].redirect).toBe("manual");
    expect(typeof fetchFn.mock.calls[1][1].lookup).toBe("function");
  });

  it("lets a non-public start stay on its own host only when asked", async () => {
    resolve({ "wiki.corp": "10.1.1.1", "other.corp": "10.1.1.2" });
    const start = new URL("https://wiki.corp/docs");
    const go = () =>
      vi
        .fn()
        .mockResolvedValueOnce(redirect("https://other.corp/"))
        .mockResolvedValueOnce(ok);
    await expect(
      fetchWithGuardedRedirects(start, go(), { stayOnStartHost: true }),
    ).rejects.toThrow(/non-public/);
    await expect(fetchWithGuardedRedirects(start, go())).resolves.toBe(ok);
  });

  it("refuses a non-public start that came from page content", async () => {
    resolve({ "wiki.corp": "10.1.1.1" });
    const fetchFn = vi.fn();
    await expect(
      fetchWithGuardedRedirects(new URL("https://wiki.corp/i.ico"), fetchFn, {
        refuseNonPublicStart: true,
      }),
    ).rejects.toThrow(/non-public/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("stops after too many redirects", async () => {
    resolve({});
    let n = 0;
    const fetchFn = vi.fn(async () => redirect(`https://a.example.com/${++n}`));
    await expect(
      fetchWithGuardedRedirects(new URL("https://a.example.com/"), fetchFn),
    ).rejects.toThrow(/Too many/);
    // the start and five redirects
    expect(fetchFn).toHaveBeenCalledTimes(6);
  });
});
