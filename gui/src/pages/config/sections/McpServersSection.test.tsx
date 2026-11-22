import { act, screen, waitFor, within } from "@testing-library/react";
import type { MCPServerStatus } from "core";
import type {
  McpWizardListing,
  McpWizardScopesResponse,
} from "core/config/mcpWizard/protocolHandlers";
import { beforeEach, describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../../context/MockIdeMessenger";
import { useAppSelector } from "../../../redux/hooks";
import { updateConfig } from "../../../redux/slices/configSlice";
import { CONFIG_ROUTES } from "../../../util/navigation";
import { renderWithProviders } from "../../../util/test/render";
import { topTabSections } from "../configTabs";
import { McpServersSection, savedFor } from "./McpServersSection";

const USER_FILE = "C:\\Users\\dev\\.continuous\\config.yaml";
const FOLDER = "D:\\code\\shop";
const MCP_DIR = `${FOLDER}\\.continuous\\mcpServers`;

const status = (over: Partial<MCPServerStatus> & { name: string }) =>
  ({
    id: over.name,
    type: "stdio",
    command: "npx",
    args: ["-y", over.name],
    status: "connected",
    errors: [],
    infos: [],
    prompts: [],
    resources: [],
    resourceTemplates: [],
    tools: [],
    isProtectedResource: false,
    ...over,
  }) as MCPServerStatus;

const listing = (
  name: string,
  scope: "user" | "project",
): McpWizardListing => ({
  name,
  scope,
  file: scope === "user" ? USER_FILE : `${MCP_DIR}\\${name}.yaml`,
  transport: "stdio",
  ...(scope === "project" ? { folder: FOLDER } : {}),
  target: `npx -y ${name}`,
  secrets: [],
  envNames: [],
  headerNames: [],
});

const scopes = (
  trust: "trusted" | "untrusted" | "none" = "trusted",
): McpWizardScopesResponse => ({
  user: { file: USER_FILE, exists: true },
  folders: [{ dir: FOLDER, name: "shop", mcpDir: MCP_DIR, trust }],
  secretStore: { kind: "secure", envFile: "C:\\Users\\dev\\.continuous\\.env" },
  defaults: {
    connectionTimeoutMs: 20_000,
    probeTimeoutMs: 20_000,
    toolCallTimeoutMs: 60_000,
    inheritedEnv: ["PATH"],
    cwd: FOLDER,
  },
});

const SERVERS = [
  status({ name: "github", configSource: "user" }),
  status({
    name: "shop-db",
    configSource: "workspace",
    sourceFile: `${MCP_DIR}\\shop-db.yaml`,
  }),
  status({
    name: "sentry",
    configSource: "user",
    sourceFile: "C:\\Users\\dev\\.continuous\\mcpServers\\claude.json",
  }),
];

let m: MockIdeMessenger;
let sent: { type: string; data: any }[];

function handle(type: string, answer: (data: any) => unknown) {
  (m.responseHandlers as any)[type] = async (data: unknown) => {
    sent.push({ type, data });
    return answer(data);
  };
}
const of = (type: string) => sent.filter((s) => s.type === type);

/** The app dialog, as Layout shows it. */
function DialogHost() {
  const message = useAppSelector((s) => s.ui.dialogMessage);
  const show = useAppSelector((s) => s.ui.showDialog);
  return show ? <div data-testid="app-dialog">{message}</div> : null;
}

beforeEach(() => {
  m = new MockIdeMessenger();
  sent = [];
  handle("mcp/list", () => ({
    servers: [listing("github", "user"), listing("shop-db", "project")],
    problems: [],
  }));
  handle("mcp/scopes", () => scopes());
  handle("config/previewMcpImport", () => ({ sources: [] }));
});

async function open(servers: MCPServerStatus[] = SERVERS) {
  const r = await renderWithProviders(
    <>
      <McpServersSection />
      <DialogHost />
    </>,
    { mockIdeMessenger: m },
  );
  await act(async () => {
    r.store.dispatch(
      updateConfig({
        ...r.store.getState().config.config,
        mcpServerStatuses: servers,
      }),
    );
  });
  await waitFor(() => expect(of("mcp/scopes").length).toBeGreaterThan(0));
  return r;
}

const card = (name: string) => within(screen.getByTestId(`mcp-server-${name}`));
const menu = async (user: any, name: string) => {
  await user.click(screen.getByRole("button", { name: `Actions for ${name}` }));
  return (await screen.findAllByRole("option")).map((o) =>
    o.textContent?.trim(),
  );
};

describe("the MCP servers tab", () => {
  it("has its own tab, second, directly after Models", () => {
    const tabs = topTabSections.flatMap((s) => s.tabs).filter((t) => !t.action);
    expect(tabs.map((t) => t.id).slice(0, 3)).toEqual([
      "models",
      "mcp",
      "tools",
    ]);
    // The name a screen reader hears; below 330 px only the icon shows
    expect(tabs[1].label).toBe("MCP servers");
    expect(CONFIG_ROUTES.MCP).toBe("/config?tab=mcp");
  });

  it("says on each server where it is saved, with the file", async () => {
    await open();
    await waitFor(() =>
      expect(card("github").getByTestId("mcp-scope-label").textContent).toBe(
        "All projects",
      ),
    );
    expect(
      card("github").getByTestId("mcp-scope-label").getAttribute("aria-label"),
    ).toBe(`All projects, saved in ${USER_FILE}`);
    const db = card("shop-db").getByTestId("mcp-scope-label");
    expect(db.textContent).toBe("This workspace");
    expect(db.getAttribute("aria-label")).toBe(
      `This workspace, saved in ${MCP_DIR}\\shop-db.yaml`,
    );
    expect(card("github").queryByTestId("mcp-read-only")).toBeNull();
  });

  it("offers Edit, Move to the other place, Duplicate and Remove for a server it can write", async () => {
    const { user } = await open();
    await waitFor(() =>
      expect(card("github").getByTestId("mcp-scope-label")).toBeDefined(),
    );
    expect(await menu(user, "github")).toEqual([
      "Edit…",
      "Edit the file",
      "Move to this workspace",
      "Duplicate to…",
      "Remove",
      "Disconnect",
      "Reload",
    ]);
  });

  it("offers the move back for a workspace server", async () => {
    const { user } = await open();
    await waitFor(() =>
      expect(card("shop-db").getByTestId("mcp-scope-label").textContent).toBe(
        "This workspace",
      ),
    );
    const items = await menu(user, "shop-db");
    expect(items).toContain("Move to all my projects");
    expect(items).not.toContain("Move to this workspace");
  });

  it("shows a server it cannot write as read-only, with Copy to in place of Move", async () => {
    const { user } = await open();
    const badge = await waitFor(() =>
      card("sentry").getByTestId("mcp-read-only"),
    );
    expect(badge.getAttribute("aria-label")).toMatch(
      /^Read-only\. It is defined in a JSON file in another tool's format/,
    );
    const items = await menu(user, "sentry");
    expect(items).toEqual([
      "Edit the file",
      "Copy to…",
      "Disconnect",
      "Reload",
    ]);
  });

  it("opens the dialog filled in from Edit", async () => {
    handle("mcp/getDraft", () => ({
      ok: true,
      listing: listing("github", "user"),
      draft: {
        name: "github",
        transport: "stdio",
        command: "npx",
        args: ["-y", "github"],
        env: [],
      },
      keptKeys: [],
    }));
    const { user } = await open();
    await menu(user, "github");
    await user.click(screen.getByRole("option", { name: "Edit…" }));
    const dialog = within(await screen.findByTestId("app-dialog"));
    expect(
      await dialog.findByRole("dialog", { name: "Edit MCP server" }),
    ).toBeDefined();
    await waitFor(() =>
      expect((dialog.getByLabelText("Name") as HTMLInputElement).value).toBe(
        "github",
      ),
    );
    expect(of("mcp/getDraft")[0].data).toEqual({
      name: "github",
      scope: "user",
      folder: undefined,
    });
  });

  it("opens the Add dialog from the + button", async () => {
    const { user } = await open();
    await user.click(screen.getByRole("button", { name: "Add MCP server" }));
    expect(
      await within(await screen.findByTestId("app-dialog")).findByRole(
        "dialog",
        { name: "Add MCP server" },
      ),
    ).toBeDefined();
    // No template file is created any more
    expect(of("config/addLocalWorkspaceBlock")).toEqual([]);
  });

  it("opens Duplicate as a new server under a free name, read through core", async () => {
    handle("mcp/getDraft", () => ({
      ok: true,
      listing: listing("github", "user"),
      draft: {
        name: "github",
        transport: "stdio",
        command: "npx",
        args: [],
        env: [],
      },
      keptKeys: [],
    }));
    const { user } = await open();
    await menu(user, "github");
    await user.click(screen.getByRole("option", { name: "Duplicate to…" }));
    const dialog = within(await screen.findByTestId("app-dialog"));
    await dialog.findByRole("dialog", { name: "Add MCP server" });
    await waitFor(() =>
      expect((dialog.getByLabelText("Name") as HTMLInputElement).value).toBe(
        "github-2",
      ),
    );
    // The place is the person's to choose
    expect(
      (dialog.getByLabelText(/For all my projects/) as HTMLInputElement)
        .checked,
    ).toBe(false);
  });
});

describe("moving a server", () => {
  it("confirms a move to the workspace in plain words, then sends it", async () => {
    handle("mcp/move", (d) => ({
      ok: true,
      scope: "project",
      name: d.target.name,
      from: USER_FILE,
      to: `${MCP_DIR}\\github.yaml`,
      removedFromSource: true,
      sourceFileDeleted: false,
      secretsStored: [],
      warnings: [],
    }));
    const { user } = await open();
    await menu(user, "github");
    await user.click(
      screen.getByRole("option", { name: "Move to this workspace" }),
    );
    const dialog = within(await screen.findByTestId("app-dialog"));
    const text = screen.getByTestId("app-dialog").textContent ?? "";
    expect(text).toContain(
      `github will be added under ${MCP_DIR} and removed from ${USER_FILE}.`,
    );
    expect(text).toContain("all its tools will ask first");
    expect(text).toContain("the file only refers to them");
    expect(of("mcp/move")).toEqual([]);
    await user.click(dialog.getByRole("button", { name: "Move" }));
    await waitFor(() => expect(of("mcp/move")).toHaveLength(1));
    // A tightening: no go-ahead beyond the confirmation is sent
    expect(of("mcp/move")[0].data).toEqual({
      target: { name: "github", scope: "user", folder: undefined },
      to: { scope: "project", folder: FOLDER },
    });
    expect((await screen.findByTestId("mcp-status")).textContent).toBe(
      `Moved github to ${MCP_DIR}\\github.yaml.`,
    );
  });

  it("says a move to all projects loosens the server, shows what runs, and sends the yes", async () => {
    handle("mcp/move", (d) => ({
      ok: true,
      scope: "user",
      name: d.target.name,
      from: `${MCP_DIR}\\shop-db.yaml`,
      to: USER_FILE,
      removedFromSource: true,
      sourceFileDeleted: true,
      secretsStored: [],
      warnings: [],
    }));
    const { user } = await open();
    await menu(user, "shop-db");
    await user.click(
      screen.getByRole("option", { name: "Move to all my projects" }),
    );
    const dialog = within(await screen.findByTestId("app-dialog"));
    const text = screen.getByTestId("app-dialog").textContent ?? "";
    expect(text).toContain("This loosens it.");
    expect(text).toContain("without this folder being trusted");
    expect(text).toContain("can then run without asking");
    expect(text).toContain("Its tools wait for your approval again.");
    expect(text).toContain("It runs: npx -y shop-db");
    await user.click(dialog.getByRole("button", { name: "Cancel" }));
    expect(of("mcp/move")).toEqual([]);

    await menu(user, "shop-db");
    await user.click(
      screen.getByRole("option", { name: "Move to all my projects" }),
    );
    await user.click(
      within(await screen.findByTestId("app-dialog")).getByRole("button", {
        name: "Move",
      }),
    );
    await waitFor(() => expect(of("mcp/move")).toHaveLength(1));
    expect(of("mcp/move")[0].data).toEqual({
      target: { name: "shop-db", scope: "project", folder: FOLDER },
      to: { scope: "user" },
      consent: true,
    });
  });

  it("refuses, with the reason, when the other place has a server of that name", async () => {
    handle("mcp/list", () => ({
      servers: [listing("github", "user"), listing("github", "project")],
      problems: [],
    }));
    const { user } = await open([
      status({ name: "github", configSource: "user" }),
    ]);
    await waitFor(() =>
      expect(card("github").getByTestId("mcp-scope-label")).toBeDefined(),
    );
    await menu(user, "github");
    await user.click(
      screen.getByRole("option", { name: "Move to this workspace" }),
    );
    const note = await screen.findByTestId("mcp-status");
    expect(note.getAttribute("role")).toBe("alert");
    expect(note.textContent).toBe(
      `Not moved: a server called github is already saved in ${MCP_DIR}\\github.yaml. Rename one of them first.`,
    );
    expect(screen.queryByTestId("app-dialog")).toBeNull();
    expect(of("mcp/move")).toEqual([]);
  });

  it("confirms a removal with the file that changes", async () => {
    handle("mcp/remove", () => ({
      ok: true,
      file: USER_FILE,
      scope: "user",
      fileDeleted: false,
      secrets: [],
    }));
    const { user } = await open();
    await menu(user, "github");
    await user.click(screen.getByRole("option", { name: "Remove" }));
    const dialog = within(await screen.findByTestId("app-dialog"));
    expect(screen.getByTestId("app-dialog").textContent).toContain(
      `github will be removed from ${USER_FILE}. Secrets it used are kept.`,
    );
    await user.click(dialog.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(of("mcp/remove")).toHaveLength(1));
    expect(of("mcp/remove")[0].data).toMatchObject({
      name: "github",
      scope: "user",
    });
    expect((await screen.findByTestId("mcp-status")).textContent).toBe(
      `Removed github from ${USER_FILE}.`,
    );
  });
});

describe("empty and error states", () => {
  it("says what an MCP server is and offers one button when there is none", async () => {
    handle("mcp/list", () => ({ servers: [], problems: [] }));
    const { user } = await open([]);
    const empty = within(screen.getByTestId("mcp-empty"));
    expect(
      empty.getByText(/An MCP server is a program on this computer/),
    ).toBeDefined();
    expect(empty.getAllByRole("button")).toHaveLength(1);
    await user.click(empty.getByRole("button", { name: "Add a server" }));
    expect(await screen.findByTestId("app-dialog")).toBeDefined();
  });

  it("shows a failed start in plain words with Edit and Try again", async () => {
    handle("mcp/reloadServer", () => undefined);
    const { user } = await open([
      status({
        name: "github",
        configSource: "user",
        status: "error",
        errors: [
          'Failed to connect to "github"\nError: command "npx" not found',
        ],
      }),
    ]);
    const failed = within(await screen.findByTestId("mcp-failed-start"));
    expect(failed.getByText(/This server did not start/)).toBeDefined();
    await waitFor(() =>
      expect(failed.getByRole("button", { name: "Edit…" })).toBeDefined(),
    );
    await user.click(failed.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(of("mcp/reloadServer")).toHaveLength(1));
    expect(of("mcp/reloadServer")[0].data).toEqual({ id: "github" });
  });

  it("says what to do about a folder that is not trusted, and lets the editor ask", async () => {
    handle("mcp/scopes", () => scopes("untrusted"));
    handle("projectTrust/ask", () => ({ shown: "config" }));
    const { user } = await open();
    const notice = within(await screen.findByTestId("mcp-untrusted"));
    expect(
      notice.getByText(
        /The MCP servers of this folder \(shop\) are not trusted, so they were not started\./,
      ),
    ).toBeDefined();
    await user.click(
      notice.getByRole("button", { name: "Trust this folder…" }),
    );
    await waitFor(() => expect(of("projectTrust/ask")).toHaveLength(1));
  });

  it("names a saved server the config in use does not load", async () => {
    await open([status({ name: "github", configSource: "user" })]);
    const list = await screen.findByTestId("mcp-not-loaded");
    expect(list.textContent).toContain("shop-db, workspace");
  });
});

describe("savedFor", () => {
  const saved = [listing("github", "user"), listing("github", "project")];
  it("matches by name and place", () => {
    expect(
      savedFor(status({ name: "github", configSource: "workspace" }), saved)
        ?.scope,
    ).toBe("project");
    expect(savedFor(status({ name: "github" }), saved)?.scope).toBe("user");
    expect(savedFor(status({ name: "other" }), saved)).toBeUndefined();
  });
  it("never matches a server defined in a JSON file", () => {
    expect(
      savedFor(
        status({ name: "github", sourceFile: "/h/mcpServers/x.json" }),
        saved,
      ),
    ).toBeUndefined();
  });
});
