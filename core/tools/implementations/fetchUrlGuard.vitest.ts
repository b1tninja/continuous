import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateToolPolicyWithRules } from "../permissions/evaluate";
import { POLICY_PRESETS } from "../permissions/policy";
import { setHostResolver } from "../../util/networkAddress";
import { fetchUrlContentTool } from "../definitions/fetchUrlContent";
import { fetchUrlContentImpl } from "./fetchUrlContent";

afterEach(() => setHostResolver(undefined));

function useTestResolver() {
  setHostResolver(async (host) => {
    if (host === "inside.test") return ["10.0.0.5"];
    if (host === "rebind.test") return ["8.8.8.8"];
    return ["93.184.215.14"];
  });
}

const page = (body = "<html><body><p>hello</p></body></html>") =>
  new Response(body, { status: 200, headers: { "content-type": "text/html" } });
const redirect = (to: string) =>
  new Response(null, { status: 302, headers: { location: to } });

const run = (url: string, fetch: any) =>
  fetchUrlContentImpl({ url }, { fetch } as any);

describe("fetch_url redirect guard", () => {
  it("refuses a redirect from a public host to a non-public one", async () => {
    useTestResolver();
    const fetch = vi.fn(async (u: URL) =>
      u.hostname === "public.test"
        ? redirect("http://169.254.169.254/latest")
        : page(),
    );
    await expect(run("http://public.test/", fetch)).rejects.toThrow(
      /non-public/,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect to a public-looking name that resolves inside", async () => {
    useTestResolver();
    const fetch = vi.fn(async (u: URL) =>
      u.hostname === "public.test" ? redirect("http://inside.test/") : page(),
    );
    await expect(run("http://public.test/", fetch)).rejects.toThrow(
      /non-public/,
    );
  });

  it("connects with the addresses it checked", async () => {
    let calls = 0;
    setHostResolver(async (host) => {
      if (host !== "rebind.test") return ["93.184.215.14"];
      calls += 1;
      return calls === 1 ? ["8.8.8.8"] : ["10.0.0.5"];
    });
    const fetch = vi.fn(async (_url: URL, init: { lookup?: Function }) => {
      const address = await new Promise<string>((resolve, reject) => {
        init.lookup?.("rebind.test", {}, (err: Error | null, found: string) => {
          if (err) reject(err);
          else resolve(found);
        });
      });
      expect(address).toBe("8.8.8.8");
      return page();
    });
    await run("http://rebind.test/", fetch);
    expect(calls).toBe(1);
  });

  it("follows redirects between public hosts", async () => {
    useTestResolver();
    const fetch = vi.fn(async (u: URL) =>
      u.pathname === "/old" ? redirect("/new") : page(),
    );
    const items = await run("http://public.test/old", fetch);
    expect(items[0].content).toContain("hello");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("follows redirects within an approved non-public URL", async () => {
    useTestResolver();
    const fetch = vi.fn(async (u: URL) =>
      u.pathname === "/" ? redirect("http://127.0.0.1:3000/docs") : page(),
    );
    const items = await run("http://localhost:3000/", fetch);
    expect(items[0].content).toContain("hello");
  });
});

describe("fetch_url policy", () => {
  const policy = (url: string, base = "allowedWithoutPermission" as const) =>
    fetchUrlContentTool.evaluateToolCallPolicy!(base, { url });

  it("asks for non-public URLs even when auto-approved", () => {
    expect(policy("http://localhost:8080/")).toBe("allowedWithPermission");
    expect(policy("http://169.254.169.254/")).toBe("allowedWithPermission");
    expect(policy("http://10.0.0.1/")).toBe("allowedWithPermission");
    expect(policy("http://[::ffff:169.254.169.254]/")).toBe(
      "allowedWithPermission",
    );
    expect(policy("http://[64:ff9b::169.254.169.254]/")).toBe(
      "allowedWithPermission",
    );
  });

  it("asks for a name that resolves to a private address", async () => {
    useTestResolver();
    const processed = await fetchUrlContentTool.preprocessArgs!(
      { url: "http://inside.test/" },
      { ide: {} as never },
    );
    expect(processed.nonPublic).toBe(true);
    expect(
      fetchUrlContentTool.evaluateToolCallPolicy!(
        "allowedWithoutPermission",
        { url: "http://inside.test/" },
        processed,
      ),
    ).toBe("allowedWithPermission");
  });

  it("Hands-off still asks for a private or mapped address", () => {
    const decide = (url: string, processedArgs?: Record<string, unknown>) =>
      evaluateToolPolicyWithRules({
        tool: fetchUrlContentTool,
        toolName: "fetch_url_content",
        basePolicy: "allowedWithoutPermission",
        parsedArgs: { url },
        processedArgs,
        permissions: { allow: ["fetchUrl"] },
        approval: { levels: POLICY_PRESETS.handsOff.levels },
      });
    expect(decide("http://10.0.0.1/").policy).toBe("allowedWithPermission");
    expect(
      evaluateToolPolicyWithRules({
        tool: fetchUrlContentTool,
        toolName: "fetch_url_content",
        basePolicy: "allowedWithPermission",
        parsedArgs: { url: "http://10.0.0.1/" },
        permissions: undefined,
        approval: { levels: POLICY_PRESETS.handsOff.levels },
      }).policy,
    ).toBe("allowedWithPermission");
    // The cloud metadata address is not asked: it is refused at every level (WB45)
    expect(decide("http://169.254.169.254/").policy).toBe("disabled");
    expect(decide("http://[::ffff:127.0.0.1]/").policy).toBe(
      "allowedWithPermission",
    );
    expect(decide("https://example.com/").policy).toBe(
      "allowedWithoutPermission",
    );
  });

  it("keeps the user's policy for public URLs, and disabled stays disabled", () => {
    expect(policy("https://example.com/")).toBe("allowedWithoutPermission");
    expect(
      fetchUrlContentTool.evaluateToolCallPolicy!("disabled", {
        url: "http://localhost/",
      }),
    ).toBe("disabled");
  });
});
