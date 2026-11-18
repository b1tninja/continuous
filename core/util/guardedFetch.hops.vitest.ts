import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchUrlContentTool } from "../tools/definitions/fetchUrlContent";
import { secretCases } from "./secretScan/fixtures";
import { fetchWithGuardedRedirects, MAX_REDIRECTS } from "./guardedFetch";
import {
  clearPinnedHosts,
  setHostResolver,
  type LookupCallback,
} from "./networkAddress";

/**
 * WB22: every hop re-checked against the special-purpose table, DNS answers
 * pinned (rebinding), credentials scanned in every Location, credential
 * headers kept off other origins, and the proxy case (DC-7). No network:
 * `fetchFn` is a mock and DNS is a table.
 */

const redirect = (location: string, status = 302) => ({
  status,
  headers: { get: (k: string) => (k === "location" ? location : null) },
});
const ok = { status: 200, headers: { get: () => null } };

const PUBLIC = "93.184.215.14";

function table(entries: Record<string, string[] | Error>) {
  setHostResolver(async (host) => {
    const hit = entries[host];
    if (hit instanceof Error) throw hit;
    return hit ?? [PUBLIC];
  });
}

/** What a pinned `lookup` hands the connection. */
function lookupOf(init: { lookup?: unknown }): Promise<{
  err: NodeJS.ErrnoException | null;
  address: unknown;
}> {
  const lookup = init.lookup as (
    host: string,
    options: unknown,
    cb: LookupCallback,
  ) => void;
  return new Promise((resolve) =>
    lookup("ignored", {}, (err, address) => resolve({ err, address })),
  );
}

afterEach(() => setHostResolver());

describe("a redirect to a non-public address is refused at every hop", () => {
  it.each([1, 2, 3, 4, 5])(
    "after %i public redirect(s)",
    async (publicHops) => {
      table({});
      const fetchFn = vi.fn();
      for (let i = 1; i < publicHops; i++) {
        fetchFn.mockResolvedValueOnce(redirect(`https://hop${i}.example/`));
      }
      fetchFn.mockResolvedValueOnce(
        redirect("http://169.254.169.254/latest/meta-data/"),
      );
      await expect(
        fetchWithGuardedRedirects(new URL("https://start.example/"), fetchFn),
      ).rejects.toThrow(/non-public address \(169\.254\.169\.254: Link Local/);
      // the metadata address itself is never requested
      expect(fetchFn).toHaveBeenCalledTimes(publicHops);
      for (const [url] of fetchFn.mock.calls) {
        expect(String(url)).not.toContain("169.254");
      }
    },
  );

  it.each([
    "http://192.0.2.1/",
    "http://198.18.0.1/",
    "http://100.64.0.1/",
    "http://192.0.0.170/",
    "http://[fd00::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:a9fe:a9fe]/",
    "http://[64:ff9b::a9fe:a9fe]/",
    "http://[2001:db8::1]/",
    "http://0.0.0.0/",
    "http://localhost:8080/",
    "http://printer.local/",
  ])("refuses a public start redirected to %s", async (target) => {
    table({});
    const fetchFn = vi.fn().mockResolvedValueOnce(redirect(target));
    await expect(
      fetchWithGuardedRedirects(new URL("https://docs.example.com/"), fetchFn),
    ).rejects.toThrow(/non-public/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect to the metadata address even from a non-public start", async () => {
    table({ "wiki.corp.example": ["10.1.1.1"] });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(redirect("http://169.254.169.254/"));
    await expect(
      fetchWithGuardedRedirects(new URL("https://wiki.corp.example/"), fetchFn),
    ).rejects.toThrow(/Link Local/);
  });

  it("stops at the hop limit, and a lower limit is honoured", async () => {
    table({});
    let n = 0;
    const fetchFn = vi.fn(async () => redirect(`https://a.example/${++n}`));
    await expect(
      fetchWithGuardedRedirects(new URL("https://a.example/"), fetchFn, {
        maxRedirects: 2,
      }),
    ).rejects.toThrow(/Too many redirects .*more than 2/);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    // a caller cannot raise it above the ceiling
    n = 0;
    fetchFn.mockClear();
    await expect(
      fetchWithGuardedRedirects(new URL("https://a.example/"), fetchFn, {
        maxRedirects: 50,
      }),
    ).rejects.toThrow(/Too many/);
    expect(fetchFn).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
  });

  it("refuses a redirect loop", async () => {
    table({});
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(redirect("https://b.example/"))
      .mockResolvedValueOnce(redirect("https://a.example/"));
    await expect(
      fetchWithGuardedRedirects(new URL("https://a.example/"), fetchFn),
    ).rejects.toThrow(/redirect loop/);
  });
});

describe("DNS rebinding: the checked answer is the one connected to", () => {
  beforeEach(() => clearPinnedHosts());

  it("pins the connection to the first answer even when DNS changes its mind", async () => {
    let answers = 0;
    setHostResolver(async () => (answers++ === 0 ? [PUBLIC] : ["127.0.0.1"]));
    const fetchFn = vi.fn().mockResolvedValue(ok);
    await fetchWithGuardedRedirects(
      new URL("https://rebind.example/"),
      fetchFn,
    );
    const { err, address } = await lookupOf(fetchFn.mock.calls[0][1]);
    expect(err).toBeNull();
    expect(address).toBe(PUBLIC);
    // and the second (private) answer was never asked for
    expect(answers).toBe(1);
  });

  it("refuses a hop whose name resolves to a private address", async () => {
    table({ "innocent.example": ["10.0.0.7"] });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(redirect("https://innocent.example/admin"));
    await expect(
      fetchWithGuardedRedirects(new URL("https://start.example/"), fetchFn),
    ).rejects.toThrow(/innocent\.example: Private-Use/);
  });

  it("refuses a name with any private answer among public ones", async () => {
    table({ "mixed.example": [PUBLIC, "192.168.0.10"] });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(redirect("https://mixed.example/"));
    await expect(
      fetchWithGuardedRedirects(new URL("https://start.example/"), fetchFn),
    ).rejects.toThrow(/non-public/);
  });

  it("a name that resolved to nothing is pinned to nothing, so a direct connection cannot ask DNS again", async () => {
    table({ "gone.example": new Error("ENOTFOUND") });
    const fetchFn = vi.fn().mockResolvedValue(ok);
    await fetchWithGuardedRedirects(new URL("https://gone.example/"), fetchFn);
    const { err } = await lookupOf(fetchFn.mock.calls[0][1]);
    expect(err?.code).toBe("ENOTFOUND");
  });

  it("re-resolves and pins every hop separately", async () => {
    table({ "b.example": ["93.184.215.20"] });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(redirect("https://b.example/"))
      .mockResolvedValueOnce(ok);
    await fetchWithGuardedRedirects(new URL("https://a.example/"), fetchFn);
    expect((await lookupOf(fetchFn.mock.calls[0][1])).address).toBe(PUBLIC);
    expect((await lookupOf(fetchFn.mock.calls[1][1])).address).toBe(
      "93.184.215.20",
    );
  });
});

describe("credentials in a redirect", () => {
  it("refuses a Location that carries a secret, without printing it", async () => {
    table({});
    const value = secretCases().find((c) => c.ruleId === "github-pat")!.value;
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        redirect(`https://collect.example/?token=${value}`),
      );
    const err = await fetchWithGuardedRedirects(
      new URL("https://start.example/"),
      fetchFn,
    ).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/credential/);
    expect((err as Error).message).not.toContain(value);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("refuses a Location with userinfo", async () => {
    table({});
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(redirect("https://u:p@other.example/"));
    await expect(
      fetchWithGuardedRedirects(new URL("https://start.example/"), fetchFn),
    ).rejects.toThrow(/user name or password/);
  });

  it("drops Authorization, Cookie and named headers on a cross-origin hop, keeps them on the same origin", async () => {
    table({});
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(redirect("https://api.example/v2"))
      .mockResolvedValueOnce(redirect("https://elsewhere.example/"))
      .mockResolvedValueOnce(ok);
    await fetchWithGuardedRedirects(
      new URL("https://api.example/v1"),
      fetchFn,
      { originHeaders: ["X-API-Key"] },
      {
        headers: {
          Authorization: "Bearer k",
          Cookie: "s=1",
          "X-API-Key": "k2",
          Accept: "application/json",
        },
      },
    );
    const headersAt = (i: number) =>
      Object.keys(fetchFn.mock.calls[i][1].headers).sort();
    expect(headersAt(1)).toEqual([
      "Accept",
      "Authorization",
      "Cookie",
      "X-API-Key",
    ]);
    expect(headersAt(2)).toEqual(["Accept"]);
  });

  it("turns a POST into a GET without a body on 303", async () => {
    table({});
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(redirect("https://a.example/result", 303))
      .mockResolvedValueOnce(ok);
    await fetchWithGuardedRedirects(
      new URL("https://a.example/form"),
      fetchFn,
      {},
      {
        method: "POST",
        body: "q=1",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      },
    );
    const second = fetchFn.mock.calls[1][1];
    expect(second.method).toBe("GET");
    expect(second.body).toBeUndefined();
    expect(second.headers).toEqual({});
  });
});

describe("behind a proxy (DC-7): resolve locally anyway", () => {
  it("refuses a redirect to a no-TLD name that does not resolve here", async () => {
    // with DNS only through the proxy, `nas.lan` may be an internal host
    table({ "nas.lan": new Error("ENOTFOUND") });
    const fetchFn = vi.fn().mockResolvedValueOnce(redirect("http://nas.lan/"));
    await expect(
      fetchWithGuardedRedirects(new URL("https://start.example/"), fetchFn),
    ).rejects.toThrow(/non-public/);
  });

  it("follows a public name that does not resolve here (the proxy will)", async () => {
    table({ "docs.example.com": new Error("ENOTFOUND") });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(redirect("https://docs.example.com/"))
      .mockResolvedValueOnce(ok);
    await expect(
      fetchWithGuardedRedirects(new URL("https://start.example/"), fetchFn),
    ).resolves.toBe(ok);
  });

  it("the fetch tool asks when the local answer is private, auto-approve or not", async () => {
    table({ "docs.example.com": ["10.0.0.5"] });
    clearPinnedHosts();
    const args = { url: "https://docs.example.com/page" };
    const processed = await fetchUrlContentTool.preprocessArgs!(args, {
      ide: {} as never,
    });
    expect(processed?.nonPublic).toBe(true);
    expect(
      fetchUrlContentTool.evaluateToolCallPolicy!(
        "allowedWithoutPermission",
        args,
        processed,
      ),
    ).toBe("allowedWithPermission");
  });

  it("the fetch tool asks for an unresolvable no-TLD name", async () => {
    table({ intranet: new Error("ENOTFOUND") });
    clearPinnedHosts();
    const args = { url: "http://intranet/wiki" };
    const processed = await fetchUrlContentTool.preprocessArgs!(args, {
      ide: {} as never,
    });
    expect(
      fetchUrlContentTool.evaluateToolCallPolicy!(
        "allowedWithoutPermission",
        args,
        processed,
      ),
    ).toBe("allowedWithPermission");
  });
});
