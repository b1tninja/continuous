import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type {
  McpWizardListing,
  McpWizardScopesResponse,
} from "core/config/mcpWizard/protocolHandlers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { renderWithProviders } from "../../util/test/render";
import { dialogMayClose } from "../dialogs/closeGuard";
import { type McpDialogMode, McpServerDialog } from "./McpServerDialog";

const USER_FILE = "C:\\Users\\dev\\.continuous\\config.yaml";
const FOLDER = "D:\\code\\shop";
const MCP_DIR = "D:\\code\\shop\\.continuous\\mcpServers";

/** Numbers no code has, to show the form reads them from core. */
const scopes = (
  over: Partial<McpWizardScopesResponse> = {},
): McpWizardScopesResponse => ({
  user: { file: USER_FILE, exists: true },
  folders: [{ dir: FOLDER, name: "shop", mcpDir: MCP_DIR, trust: "none" }],
  secretStore: { kind: "secure", envFile: "C:\\Users\\dev\\.continuous\\.env" },
  defaults: {
    connectionTimeoutMs: 45_000,
    probeTimeoutMs: 20_000,
    toolCallTimeoutMs: 90_000,
    inheritedEnv: ["PATH", "HOME"],
    cwd: FOLDER,
  },
  ...over,
});

const listing = (
  name: string,
  scope: "user" | "project",
): McpWizardListing => ({
  name,
  scope,
  file: scope === "user" ? USER_FILE : `${MCP_DIR}\\${name}.yaml`,
  transport: "stdio",
  ...(scope === "project" ? { folder: FOLDER } : {}),
  target: "npx x",
  secrets: [],
  envNames: [],
  headerNames: [],
});

let m: MockIdeMessenger;
let sent: { type: string; data: any }[];
let onDone: ReturnType<typeof vi.fn<(message: string) => void>>;
let onCancel: ReturnType<typeof vi.fn<() => void>>;

function handle(type: string, answer: (data: any) => unknown) {
  (m.responseHandlers as any)[type] = async (data: unknown) => {
    sent.push({ type, data });
    return answer(data);
  };
}

beforeEach(() => {
  m = new MockIdeMessenger();
  sent = [];
  onDone = vi.fn<(message: string) => void>();
  onCancel = vi.fn<() => void>();
  handle("mcp/scopes", () => scopes());
  handle("mcp/list", () => ({ servers: [], problems: [] }));
  handle("mcp/analyzeLaunch", () => ({
    analysis: { findings: [], blocked: false, display: "" },
    expired: false,
  }));
  handle("mcp/save", (d) => ({
    ok: true,
    scope: d.scope,
    file: USER_FILE,
    name: d.draft.name,
    secretsStored: [],
    secretsPending: [],
    warnings: [],
  }));
});

const open = (mode: McpDialogMode = { kind: "add" }) =>
  renderWithProviders(
    <McpServerDialog mode={mode} onDone={onDone} onCancel={onCancel} />,
    { mockIdeMessenger: m },
  );

const of = (type: string) => sent.filter((s) => s.type === type);
const type = (el: Element, value: string) =>
  fireEvent.change(el, { target: { value } });
const field = (name: string | RegExp) => screen.getByLabelText(name);

describe("Add MCP server: quick start", () => {
  it("fills the form from a paste and saves nothing", async () => {
    handle("mcp/parsePaste", () => ({
      candidates: [
        {
          draft: {
            name: "filesystem",
            transport: "stdio",
            command: "npx",
            args: [
              "-y",
              "@modelcontextprotocol/server-filesystem",
              "C:\\My Docs",
            ],
            env: [],
            headers: [],
          },
          nameGuessed: true,
          transportGuessed: false,
          source: "command-line",
          fields: [],
          warnings: [],
        },
      ],
      warnings: [],
    }));
    const { user } = await open();
    type(
      field("Paste a command, a URL, or a JSON snippet"),
      'npx -y @modelcontextprotocol/server-filesystem "C:\\My Docs"',
    );
    await user.click(screen.getByRole("button", { name: "Fill in the form" }));
    await waitFor(() =>
      expect((field("Name") as HTMLInputElement).value).toBe("filesystem"),
    );
    expect((field("Command") as HTMLInputElement).value).toBe("npx");
    // One box per argument: the split is what is shown
    expect((field("Argument 3") as HTMLInputElement).value).toBe("C:\\My Docs");
    const run = within(screen.getByTestId("mcp-will-run"));
    expect(
      [...screen.getByTestId("mcp-will-run").querySelectorAll("code")].map(
        (c) => c.textContent,
      ),
    ).toEqual([
      "npx",
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "C:\\My Docs",
    ]);
    expect(run.getByText("C:\\My Docs")).toBeDefined();
    expect(of("mcp/parsePaste")[0].data.text).toContain("server-filesystem");
    expect(of("mcp/save")).toEqual([]);
    expect(of("mcp/probe")).toEqual([]);
    expect(screen.getByTestId("mcp-paste-note").textContent).toMatch(
      /Nothing is saved until you press Save/,
    );
  });

  it("offers each server of a JSON with several, and stays open for the next after a save", async () => {
    const cand = (name: string) => ({
      draft: {
        name,
        transport: "stdio",
        command: "npx",
        args: [name],
        env: [],
        headers: [],
      },
      nameGuessed: false,
      transportGuessed: false,
      source: "mcpServers-json",
      fields: [],
      warnings: [],
    });
    handle("mcp/parsePaste", () => ({
      candidates: [cand("fs"), cand("git")],
      warnings: [],
    }));
    const { user } = await open();
    type(field("Paste a command, a URL, or a JSON snippet"), "{...}");
    await user.click(screen.getByRole("button", { name: "Fill in the form" }));
    const group = await screen.findByRole("group", {
      name: "Servers in your paste",
    });
    expect(
      within(group)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["fs", "git"]);
    await user.click(screen.getByLabelText(/For this workspace only/));
    await user.click(screen.getByTestId("mcp-save"));
    await waitFor(() => expect(of("mcp/save")).toHaveLength(1));
    // The first is saved; the form now holds the second, in the same place
    await waitFor(() =>
      expect((field("Name") as HTMLInputElement).value).toBe("git"),
    );
    expect(onDone).not.toHaveBeenCalled();
    expect(within(group).getByText("fs (saved)")).toBeDefined();
    await user.click(screen.getByTestId("mcp-save"));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(of("mcp/save").map((s) => s.data.draft.name)).toEqual(["fs", "git"]);
  });

  it("says so when nothing is recognised", async () => {
    handle("mcp/parsePaste", () => ({ candidates: [], warnings: [] }));
    const { user } = await open();
    type(field("Paste a command, a URL, or a JSON snippet"), "hello there");
    await user.click(screen.getByRole("button", { name: "Fill in the form" }));
    expect((await screen.findByTestId("mcp-paste-note")).textContent).toMatch(
      /Nothing recognised/,
    );
  });
});

describe("Add MCP server: where to save it", () => {
  it("shows both places with their real paths and makes the choice required", async () => {
    const { user } = await open();
    const where = within(await screen.findByTestId("mcp-scope"));
    await waitFor(() => expect(where.getByText(USER_FILE)).toBeDefined());
    type(field("Name"), "GitHub Tools");
    type(field("Command"), "npx");
    // The file a workspace save would write, named after the server
    expect(where.getByText(`${MCP_DIR}\\github-tools.yaml`)).toBeDefined();
    expect(
      (where.getByLabelText(/For all my projects/) as HTMLInputElement).checked,
    ).toBe(false);
    expect(
      (where.getByLabelText(/For this workspace only/) as HTMLInputElement)
        .checked,
    ).toBe(false);
    expect(where.getByText(/secrets are never\s+written to it/)).toBeDefined();
    expect(where.getByText(/all\s+its tools ask first/)).toBeDefined();

    await user.click(screen.getByTestId("mcp-save"));
    expect(where.getByRole("alert").textContent).toBe(
      "Choose where to save it.",
    );
    expect(of("mcp/save")).toEqual([]);
  });

  it("turns the workspace choice off, with the reason, when no folder is open", async () => {
    handle("mcp/scopes", () => {
      const s = scopes({ folders: [] });
      delete s.defaults.cwd;
      return s;
    });
    await open();
    const where = within(await screen.findByTestId("mcp-scope"));
    await waitFor(() =>
      expect(
        where.getByText("Not available: no folder is open."),
      ).toBeDefined(),
    );
    expect(
      (where.getByLabelText(/For this workspace only/) as HTMLInputElement)
        .disabled,
    ).toBe(true);
  });

  it("asks which folder when several are open, and sends the chosen one", async () => {
    handle("mcp/scopes", () =>
      scopes({
        folders: [
          { dir: FOLDER, name: "shop", mcpDir: MCP_DIR, trust: "none" },
          {
            dir: "D:\\code\\api",
            name: "api",
            mcpDir: "D:\\code\\api\\.continuous\\mcpServers",
            trust: "none",
          },
        ],
      }),
    );
    const { user } = await open();
    type(field("Name"), "db");
    type(field("Command"), "uvx");
    await waitFor(() => expect(of("mcp/scopes").length).toBeGreaterThan(0));
    await user.click(await screen.findByLabelText(/For this workspace only/));
    type(await screen.findByLabelText("Folder"), "D:\\code\\api");
    await user.click(screen.getByTestId("mcp-save"));
    await waitFor(() => expect(of("mcp/save")).toHaveLength(1));
    expect(of("mcp/save")[0].data).toMatchObject({
      scope: "project",
      folder: "D:\\code\\api",
    });
  });

  it("says inline when the name collides, and with what", async () => {
    handle("mcp/list", () => ({
      servers: [listing("github", "user")],
      problems: [],
    }));
    const { user } = await open();
    type(field("Name"), "GitHub");
    type(field("Command"), "npx");
    await user.click(await screen.findByLabelText(/For all my projects/));
    expect((await screen.findByRole("alert")).textContent).toBe(
      `A server called github is already saved for all your projects, in ${USER_FILE}.`,
    );
    await user.click(screen.getByTestId("mcp-save"));
    expect(of("mcp/save")).toEqual([]);

    // Yours wins over the workspace's, so that name is refused there too
    await user.click(screen.getByLabelText(/For this workspace only/));
    expect(screen.getByRole("alert").textContent).toMatch(
      /A workspace server cannot share its name: yours would be used instead\./,
    );
  });
});

describe("Add MCP server: values and secrets", () => {
  it("stores a value as a secret when its name looks like a credential, and says where it goes", async () => {
    const { user } = await open();
    await user.click(screen.getByRole("button", { name: "Add a variable" }));
    type(screen.getByLabelText("Name of variable"), "GITHUB_TOKEN");
    const row = within(screen.getByTestId("mcp-variable-row"));
    expect(
      (row.getByLabelText("Store as a secret") as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (row.getByLabelText("Value of GITHUB_TOKEN") as HTMLInputElement).type,
    ).toBe("password");
    await waitFor(() =>
      expect(
        row.getByText(
          "Kept in the editor's secure storage. The file only gets a reference to it.",
        ),
      ).toBeDefined(),
    );

    type(screen.getByLabelText("Name of variable"), "LOG_LEVEL");
    expect(
      (row.getByLabelText("Store as a secret") as HTMLInputElement).checked,
    ).toBe(false);
    expect(row.getByText("Written to the file as typed.")).toBeDefined();
  });

  it("says what a server gets when no variable is set, from core's list", async () => {
    await open();
    expect(
      await screen.findByText(
        "None: of the editor's own environment the server gets only PATH, HOME.",
      ),
    ).toBeDefined();
  });
});

describe("Add MCP server: Advanced", () => {
  it("is folded, and each setting says what happens while it is not set, with core's numbers", async () => {
    const { user } = await open();
    expect(screen.queryByTestId("mcp-advanced")).toBeNull();
    const toggle = screen.getByRole("button", { name: "Advanced" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => expect(of("mcp/scopes").length).toBeGreaterThan(0));
    await user.click(toggle);
    const adv = within(await screen.findByTestId("mcp-advanced"));
    await waitFor(() =>
      expect(
        adv.getByText(
          `Not set: the server starts in the open folder, ${FOLDER}.`,
        ),
      ).toBeDefined(),
    );
    expect(
      adv.getByText(
        "Not set: the editor waits 45 seconds for the server to connect.",
      ),
    ).toBeDefined();
    expect(
      (adv.getByLabelText("Connection timeout (seconds)") as HTMLInputElement)
        .placeholder,
    ).toBe("45");
    // Neither timeout set: the built-in limit, from core
    expect(adv.getByTestId("mcp-tool-timeout").textContent).toBe(
      "Not set: each tool call may take 90 seconds.",
    );
    expect(
      (adv.getByLabelText("Tool call timeout (seconds)") as HTMLInputElement)
        .placeholder,
    ).toBe("90");
    expect(adv.getByTestId("mcp-tool-default").textContent).toMatch(
      /each tool is\s+set to Ask First/,
    );
    expect(adv.getByText(/runs as a local process \(stdio\)/)).toBeDefined();
    // Never the bare word
    expect(screen.getByTestId("mcp-advanced").textContent).not.toMatch(
      /\bdefault\b/i,
    );
  });

  it("shows 'Set by you' with a Reset once a setting has a value", async () => {
    const { user } = await open();
    await user.click(screen.getByRole("button", { name: "Advanced" }));
    const timeout = screen.getByLabelText("Connection timeout (seconds)");
    expect(screen.queryByRole("button", { name: /^Reset/ })).toBeNull();
    type(timeout, "30");
    expect(
      screen.getByText(
        "Set by you: the editor waits 30 seconds for the server to connect.",
      ),
    ).toBeDefined();
    // Only the connection timeout set: tool calls still follow it, and the form says so
    expect(screen.getByTestId("mcp-tool-timeout").textContent).toBe(
      "Not set: follows your connection timeout, 30 seconds. Set it separately",
    );
    const tool = screen.getByLabelText("Tool call timeout (seconds)");
    await user.click(screen.getByRole("button", { name: "Set it separately" }));
    expect((tool as HTMLInputElement).value).toBe("30");
    type(tool, "120");
    expect(
      screen.getByText(
        "Set by you: each tool call may take 120 seconds, whatever the connection timeout is.",
      ),
    ).toBeDefined();
    await user.click(
      screen.getByRole("button", {
        name: "Reset Tool call timeout (seconds) to not set",
      }),
    );
    expect((tool as HTMLInputElement).value).toBe("");
    await user.click(
      screen.getByRole("button", {
        name: "Reset Connection timeout (seconds) to not set",
      }),
    );
    // The same box, still on the page: typing did not replace it
    expect(timeout.isConnected).toBe(true);
    expect((timeout as HTMLInputElement).value).toBe("");
    expect(
      screen.getByText(
        "Not set: the editor waits 45 seconds for the server to connect.",
      ),
    ).toBeDefined();
  });

  it("says for a URL that an unset transport tries streamable HTTP, then SSE", async () => {
    const { user } = await open();
    await user.click(screen.getByLabelText("Remote server (URL)"));
    await user.click(screen.getByRole("button", { name: "Advanced" }));
    const transport = screen.getByLabelText(/^Transport/) as HTMLSelectElement;
    expect(transport.value).toBe("");
    expect(transport.selectedOptions[0].textContent).toBe(
      "Not set: tries streamable HTTP, then SSE",
    );
    expect(screen.getByText("None: no extra headers are sent.")).toBeDefined();
  });
});

describe("Add MCP server: Save", () => {
  it("sends the definition and the place, and leaves unset settings out", async () => {
    const { user } = await open();
    type(field("Name"), " docs ");
    await user.click(screen.getByLabelText("Remote server (URL)"));
    type(field("URL"), "https://docs.example.com/mcp");
    await user.click(screen.getByRole("button", { name: "Add a header" }));
    type(screen.getByLabelText("Name of header"), "Authorization");
    type(screen.getByLabelText("Value of Authorization"), "Bearer abc");
    await user.click(await screen.findByLabelText(/For this workspace only/));
    await user.click(screen.getByTestId("mcp-save"));
    await waitFor(() => expect(of("mcp/save")).toHaveLength(1));
    expect(of("mcp/save")[0].data).toEqual({
      draft: {
        name: "docs",
        transport: "http",
        autoTransport: true,
        url: "https://docs.example.com/mcp",
        headers: [{ name: "Authorization", value: "Bearer abc", secret: true }],
      },
      scope: "project",
      folder: FOLDER,
    });
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(onDone.mock.calls[0][0]).toMatch(/^Saved docs to /);
  });

  it("shows exactly what will run before a save that starts a command, and saves only on yes", async () => {
    const { user } = await open();
    type(field("Name"), "git");
    type(field("Command"), "uvx");
    await user.click(screen.getByRole("button", { name: "Add an argument" }));
    type(screen.getByLabelText("Argument 1"), "mcp-server-git");
    await user.click(await screen.findByLabelText(/For all my projects/));
    await user.click(screen.getByTestId("mcp-save"));
    const ask = within(await screen.findByTestId("mcp-confirm-run"));
    expect(ask.getByText(/Saving starts this on your computer/)).toBeDefined();
    expect(
      [...screen.getByTestId("mcp-confirm-run").querySelectorAll("code")].map(
        (c) => c.textContent,
      ),
    ).toEqual(["uvx", "mcp-server-git"]);
    expect(of("mcp/save")).toEqual([]);
    await user.click(ask.getByRole("button", { name: "Save and start" }));
    await waitFor(() => expect(of("mcp/save")).toHaveLength(1));
    expect(of("mcp/save")[0].data).toEqual({
      draft: {
        name: "git",
        transport: "stdio",
        command: "uvx",
        args: ["mcp-server-git"],
        env: [],
      },
      scope: "user",
    });
  });

  it("shows why a save was refused and offers the free name", async () => {
    handle("mcp/save", () => ({
      ok: false,
      reason: "duplicate",
      error: "A server called docs already exists.",
      suggestion: "docs-2",
    }));
    const { user } = await open();
    type(field("Name"), "docs");
    await user.click(screen.getByLabelText("Remote server (URL)"));
    type(field("URL"), "https://docs.example.com/mcp");
    await user.click(await screen.findByLabelText(/For all my projects/));
    await user.click(screen.getByTestId("mcp-save"));
    const error = await screen.findByTestId("mcp-save-error");
    expect(error.textContent).toContain("A server called docs already exists.");
    await user.click(within(error).getByRole("button", { name: "Use docs-2" }));
    expect((field("Name") as HTMLInputElement).value).toBe("docs-2");
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe("Add MCP server: Test", () => {
  const fill = async (user: any) => {
    type(field("Name"), "fs");
    type(field("Command"), "npx");
    await user.click(await screen.findByLabelText(/For all my projects/));
  };

  it("runs nothing before the person has seen the command and said yes", async () => {
    handle("mcp/probe", () => ({
      ran: true,
      result: {
        ok: true,
        status: "connected",
        durationMs: 800,
        timeoutMs: 20_000,
        transport: "stdio",
        tools: [
          {
            name: "read_file",
            description: "",
            truncated: false,
            instructionLike: [],
          },
        ],
        resources: [],
        prompts: [],
        errors: [],
        infos: [],
        stderr: { lines: [], truncated: false },
        hints: [],
        needsSignIn: false,
        notice: "",
        server: { name: "secure-filesystem-server", version: "0.2.0" },
      },
    }));
    const { user } = await open();
    await fill(user);
    await user.click(screen.getByTestId("mcp-test"));
    await screen.findByTestId("mcp-confirm-run");
    expect(of("mcp/probe")).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(of("mcp/probe")).toEqual([]);

    await user.click(screen.getByTestId("mcp-test"));
    await user.click(await screen.findByTestId("mcp-confirm-run-yes"));
    const result = await screen.findByTestId("mcp-test-result");
    expect(of("mcp/probe")[0].data).toMatchObject({
      consent: true,
      scope: "user",
      draft: { name: "fs", command: "npx" },
    });
    expect(result.textContent).toContain("Connected in 0.8 seconds.");
    expect(result.textContent).toContain(
      "The server calls itself secure-filesystem-server 0.2.0.",
    );
    expect(result.textContent).toContain("1 tool, 0 prompts, 0 resources.");
    expect(result.textContent).toContain("Tools: read_file");
    // Nothing was saved by the test
    expect(of("mcp/save")).toEqual([]);

    // The same command was agreed to: Save does not ask again
    await user.click(screen.getByTestId("mcp-save"));
    await waitFor(() => expect(of("mcp/save")).toHaveLength(1));
  });

  it("says in plain words why a test failed", async () => {
    handle("mcp/probe", () => ({
      ran: true,
      result: {
        ok: false,
        status: "error",
        durationMs: 100,
        timeoutMs: 20_000,
        transport: "stdio",
        tools: [],
        resources: [],
        prompts: [],
        errors: ["spawn npx ENOENT"],
        infos: [],
        stderr: { lines: [], truncated: false },
        hints: [
          {
            code: "install-node",
            text: "`npx` was not found. Install Node.js.",
          },
        ],
        needsSignIn: false,
        notice: "",
        pathSearched: ["C:\\Windows"],
      },
    }));
    const { user } = await open();
    await fill(user);
    await user.click(screen.getByTestId("mcp-test"));
    await user.click(await screen.findByTestId("mcp-confirm-run-yes"));
    const result = await screen.findByTestId("mcp-test-result");
    expect(result.getAttribute("role")).toBe("alert");
    expect(result.textContent).toContain("Command not found: npx");
    expect(result.textContent).toContain(
      "Looked in the 1 folder of the PATH the editor has: C:\\Windows",
    );
  });

  it("does not test a workspace server in a folder that is not trusted, and says why", async () => {
    handle("mcp/scopes", () =>
      scopes({
        folders: [
          { dir: FOLDER, name: "shop", mcpDir: MCP_DIR, trust: "untrusted" },
        ],
      }),
    );
    const { user } = await open();
    type(field("Name"), "fs");
    type(field("Command"), "npx");
    await waitFor(() => expect(of("mcp/scopes").length).toBeGreaterThan(0));
    await user.click(await screen.findByLabelText(/For this workspace only/));
    expect(
      await screen.findByText(/This folder's MCP servers are not trusted yet/),
    ).toBeDefined();
    expect((screen.getByTestId("mcp-test") as HTMLButtonElement).disabled).toBe(
      true,
    );
    // Saving writes the file; the loader keeps it off until the folder is trusted
    expect((screen.getByTestId("mcp-save") as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

describe("Edit MCP server", () => {
  const target = { name: "github", scope: "user" as const };
  beforeEach(() => {
    handle("mcp/list", () => ({
      servers: [listing("github", "user"), listing("docs", "user")],
      problems: [],
    }));
    handle("mcp/getDraft", () => ({
      ok: true,
      listing: listing("github", "user"),
      draft: {
        name: "github",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: [
          {
            name: "GITHUB_TOKEN",
            value: "${{ secrets.GITHUB_TOKEN }}",
            secret: true,
          },
          {
            name: "OLD_KEY",
            value: "${{ held.123e4567-e89b-42d3-a456-426614174000 }}",
            secret: true,
          },
        ],
        connectionTimeoutMs: 30_000,
      },
      keptKeys: ["faviconUrl"],
    }));
    handle("mcp/update", (d) => ({
      ok: true,
      scope: "user",
      file: USER_FILE,
      name: d.draft.name,
      secretsStored: [],
      secretsPending: [],
      warnings: [],
    }));
  });

  it("opens filled in, with secrets as names and never as values", async () => {
    await open({ kind: "edit", target });
    expect(
      await screen.findByRole("dialog", { name: "Edit MCP server" }),
    ).toBeDefined();
    await waitFor(() =>
      expect((field("Name") as HTMLInputElement).value).toBe("github"),
    );
    expect(of("mcp/getDraft")[0].data).toEqual(target);
    expect((field("Command") as HTMLInputElement).value).toBe("npx");
    expect((field("Argument 2") as HTMLInputElement).value).toBe(
      "@modelcontextprotocol/server-github",
    );
    expect(
      screen.getByText(
        "Uses the stored secret GITHUB_TOKEN. The value is not shown.",
      ),
    ).toBeDefined();
    expect(screen.getByText(/^A hidden value\./)).toBeDefined();
    // The marker's id is core's business, not the page's
    expect(document.body.textContent).not.toContain("123e4567");
    // Where it is saved is stated, not asked again
    const where = within(screen.getByTestId("mcp-scope"));
    expect(where.queryByRole("radio")).toBeNull();
    expect(where.getByText(USER_FILE)).toBeDefined();
    // It does not collide with itself
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("sends the edit for that server, with its references untouched", async () => {
    const { user } = await open({ kind: "edit", target });
    await waitFor(() =>
      expect((field("Name") as HTMLInputElement).value).toBe("github"),
    );
    type(field("Argument 2"), "@modelcontextprotocol/server-github@2025.4.8");
    await user.click(screen.getByTestId("mcp-save"));
    // A command for all projects: shown first
    await user.click(await screen.findByTestId("mcp-confirm-run-yes"));
    await waitFor(() => expect(of("mcp/update")).toHaveLength(1));
    expect(of("mcp/update")[0].data).toEqual({
      target,
      draft: {
        name: "github",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github@2025.4.8"],
        env: [
          {
            name: "GITHUB_TOKEN",
            value: "${{ secrets.GITHUB_TOKEN }}",
            secret: true,
          },
          {
            name: "OLD_KEY",
            value: "${{ held.123e4567-e89b-42d3-a456-426614174000 }}",
            secret: true,
          },
        ],
        connectionTimeoutMs: 30_000,
      },
    });
    expect(of("mcp/save")).toEqual([]);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("names the settings it keeps without showing, and links to the file", async () => {
    const { user } = await open({ kind: "edit", target });
    await waitFor(() =>
      expect((field("Name") as HTMLInputElement).value).toBe("github"),
    );
    await user.click(screen.getByRole("button", { name: "Advanced" }));
    expect(
      screen.getByText(/settings this form does not show:\s+faviconUrl/),
    ).toBeDefined();
    expect(
      screen.getByText(
        "Set by you: the editor waits 30 seconds for the server to connect.",
      ),
    ).toBeDefined();
    const post = vi.spyOn(m, "post");
    await user.click(screen.getByTestId("mcp-edit-file"));
    expect(post).toHaveBeenCalledWith("openFile", { path: USER_FILE });
  });

  it("says so when the server is no longer in its file", async () => {
    handle("mcp/getDraft", () => ({
      ok: false,
      error: "There is no saved server called github.",
    }));
    await open({ kind: "edit", target });
    expect((await screen.findByRole("alert")).textContent).toBe(
      "There is no saved server called github.",
    );
    expect((screen.getByTestId("mcp-save") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe("closing the dialog", () => {
  it("closes at once when nothing was typed", async () => {
    const { user } = await open();
    expect(dialogMayClose()).toBe(true);
    expect(onCancel).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("mcp-confirm-discard")).toBeNull();
  });

  it("asks before it discards what was typed, on Escape as on Cancel", async () => {
    const { user } = await open();
    type(field("Name"), "half typed");
    // Escape, the X and the backdrop all ask the open dialog first
    expect(dialogMayClose()).toBe(false);
    const ask = within(await screen.findByTestId("mcp-confirm-discard"));
    expect(ask.getByText("Discard what you typed?")).toBeDefined();
    expect(onCancel).not.toHaveBeenCalled();
    await user.click(ask.getByRole("button", { name: "Keep editing" }));
    expect((field("Name") as HTMLInputElement).value).toBe("half typed");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(
      within(await screen.findByTestId("mcp-confirm-discard")).getByRole(
        "button",
        { name: "Discard" },
      ),
    );
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("no longer answers for the container once it is gone", async () => {
    const { unmount } = await open();
    type(field("Name"), "x");
    unmount();
    expect(dialogMayClose()).toBe(true);
  });
});

describe("keyboard", () => {
  it("follows the visual order: quick start, name, kind, command, place, Advanced, then the buttons", async () => {
    await open();
    await screen.findByTestId("mcp-scope");
    const order = [
      ...screen
        .getByTestId("mcp-server-dialog")
        .querySelectorAll<HTMLElement>(
          "input:not([disabled]), textarea, select, button:not([disabled])",
        ),
    ].map(
      (el) =>
        el.getAttribute("aria-label") ??
        el.closest("label")?.textContent?.trim().slice(0, 24) ??
        (el.id
          ? document.querySelector(`label[for="${el.id}"]`)?.textContent
          : undefined) ??
        el.textContent?.trim(),
    );
    const at = (label: string) => {
      const i = order.findIndex((o) => (o ?? "").startsWith(label));
      expect(i, label).toBeGreaterThanOrEqual(0);
      return i;
    };
    const sequence = [
      "Paste a command",
      "Name",
      "Runs on this computer",
      "Command",
      "Add an argument",
      "Add a variable",
      "For all my projects",
      "For this workspace only",
      "Advanced",
      "Cancel",
      "Test",
      "Save",
    ].map(at);
    expect(sequence).toEqual([...sequence].sort((a, b) => a - b));
    // No control is taken out of the Tab order or moved within it
    expect(
      screen
        .getByTestId("mcp-server-dialog")
        .querySelector("[tabindex]:not([tabindex='-1']):not([tabindex='0'])"),
    ).toBeNull();
  });
});
