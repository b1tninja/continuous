import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resetWebConfigForTests } from "core/util/webConfig.js";
import { WEB_AGENT_INFO_URL } from "core/web/userAgent.js";
import { setWebAgentVersion } from "core/web/webHeaders.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: { url: string; init: any }[] = [];

// The network layer: record what reaches the HTTP client instead of sending it
vi.mock("@continuedev/fetch", async (importActual) => {
  const actual = await importActual<typeof import("@continuedev/fetch")>();
  return {
    ...actual,
    fetchwithRequestOptions: vi.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response("page body", {
        headers: { "content-type": "text/plain" },
      });
    }),
  };
});

vi.mock("../services/index.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/index.js")>();
  return {
    ...actual,
    getServiceSync: vi.fn(() => ({ value: { config: null } })),
  };
});

import { fetchTool } from "./fetch.js";

/** WB17: `cn`'s Fetch sends the same User-Agent as the IDE's fetch tool. */
describe("CLI Fetch User-Agent", () => {
  let dir: string;
  const userConfig = (yaml: string) => {
    const file = path.join(dir, "config.yaml");
    fs.writeFileSync(file, yaml);
    resetWebConfigForTests(file);
  };

  beforeEach(() => {
    calls.length = 0;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-ua-"));
    userConfig("");
    setWebAgentVersion("1.4.7");
  });

  afterEach(() => {
    setWebAgentVersion(undefined);
    resetWebConfigForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("sends Continuous-User with major.minor and the info URL, and nothing identifying", async () => {
    await fetchTool.run({ url: "http://93.184.216.34/page" });
    const headers = calls[0].init.headers;
    expect(headers["User-Agent"]).toBe(
      `Continuous-User/1.4 (+${WEB_AGENT_INFO_URL})`,
    );
    expect(headers.Accept).toMatch(/^text\/markdown,/);
    const names = Object.keys(headers).map((k) => k.toLowerCase());
    for (const name of ["from", "referer", "cookie", "accept-language"]) {
      expect(names).not.toContain(name);
    }
    expect(JSON.stringify(headers)).not.toMatch(
      /1\.4\.7|x-continue-unique-id|win32|darwin|linux/i,
    );
  });

  it("follows web.userAgent in the person's config", async () => {
    userConfig("web:\n  userAgent:\n    preset: generic-agent\n");
    await fetchTool.run({ url: "http://93.184.216.34/page" });
    expect(calls[0].init.headers["User-Agent"]).toBe(
      "Mozilla/5.0 (compatible)",
    );
  });
});
