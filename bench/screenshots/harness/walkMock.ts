// What `npm run walk` needs from the IDE side: a record of every message the
// page sends, of each time a message ends in an editor file, and the answers
// the three journeys wait for. core is not running here, so each answer below
// does what core's handler would have shown the page, and no more.
import { analyzeLaunch } from "core/config/mcpWizard/analyzeLaunch";
import { parseMcpPaste } from "core/config/mcpWizard/parseMcpPaste";
import type { McpCandidate } from "core/config/mcpWizard/types";
import { getFileContent } from "core/config/workspace/workspaceBlocks";
import type { FixtureContext } from "./fixtures";
import { mcpScopes, sendConfig } from "./fixtures";

export interface WalkFile {
  /** The message that led to the file */
  via: string;
  uri: string;
  /** What the file holds when it opens, when that is known here */
  content?: string;
}

export interface WalkLog {
  messages: string[];
  files: WalkFile[];
  /** Requests no answer was defined for: the mock is behind the page */
  unanswered: string[];
}

const WORKSPACE = "file:///Users/user/workspace1";

/**
 * A parsed server as `mcp/parsePaste` gives it to the page. core's
 * candidateForWebview also swaps a credential for a held marker; that file
 * needs node, and the walk's command line has no credential, so a value is
 * passed on as it is or left out.
 */
function candidateForPage(c: McpCandidate) {
  const values = (list: McpCandidate["env"]) =>
    list.map((v) => {
      const plain = v.value !== undefined && !v.reference && !v.placeholder;
      return {
        name: v.name,
        value: plain && !v.secretLooking ? v.value! : "",
        secret: !plain || v.secretLooking,
      };
    });
  return {
    draft: {
      name: c.name,
      transport: c.transport,
      ...(c.command === undefined
        ? {}
        : { command: c.command, args: c.args ?? [] }),
      ...(c.cwd ? { cwd: c.cwd } : {}),
      ...(c.url === undefined ? {} : { url: c.url }),
      env: values(c.env),
      headers: values(c.headers),
    },
    nameGuessed: c.nameGuessed,
    transportGuessed: c.transportGuessed,
    source: c.sourceFormat,
    fields: [],
    warnings: [...c.warnings],
  };
}

/**
 * Messages after which the person is looking at a file in the editor, not at
 * the page. `config/addLocalWorkspaceBlock` is one: core writes the template
 * and calls `ide.openFile` (core/config/workspace/workspaceBlocks.ts). The
 * "Edit the file" links of the MCP dialog and of a server's menu post
 * `openFile`.
 */
const FILE_OPENERS: Record<string, (data: any) => Omit<WalkFile, "via">> = {
  showFile: (d) => ({ uri: String(d?.filepath ?? "") }),
  openFile: (d) => ({ uri: String(d?.path ?? "") }),
  "config/openProfile": (d) => ({
    uri: `config:${d?.profileId ?? "selected"}`,
  }),
  "config/openSecretLocation": () => ({ uri: "secret-location" }),
  "config/newPromptFile": () => ({
    uri: `${WORKSPACE}/.continuous/prompts/new-prompt.md`,
    content: getFileContent("prompts"),
  }),
  "config/addGlobalRule": () => ({
    uri: "file:///Users/user/.continuous/rules/global-rule.md",
    content: getFileContent("rules"),
  }),
  "config/addLocalWorkspaceBlock": (d) => ({
    uri: `${WORKSPACE}/.continuous/${d.blockType}/${d.blockType === "mcpServers" ? "new-mcp-server" : "new-block"}.yaml`,
    // The real template, so its size and placeholders are measured, not copied
    content: getFileContent(d.blockType),
  }),
};

export function installWalkMock({ messenger }: FixtureContext): void {
  const log: WalkLog = { messages: [], files: [], unanswered: [] };
  const note = (type: string, data: unknown) => {
    log.messages.push(type);
    const opened = FILE_OPENERS[type]?.(data);
    if (opened) log.files.push({ via: type, ...opened });
  };

  const request = messenger.request.bind(messenger);
  messenger.request = (async (type: string, data: unknown) => {
    note(type, data);
    try {
      return await request(type as never, data as never);
    } catch (e) {
      log.unanswered.push(type);
      throw e;
    }
  }) as typeof messenger.request;
  const post = messenger.post.bind(messenger);
  messenger.post = ((type: string, data: unknown, ...rest: unknown[]) => {
    note(type, data);
    return (post as any)(type, data, ...rest);
  }) as typeof messenger.post;

  // A config is selected, as in an editor: without one a role pick does nothing
  const info: any = structuredClone(
    messenger.responses["config/getSerializedProfileInfo"],
  );
  info.profiles = [
    {
      title: "Main Config",
      id: info.profileId,
      errors: [],
      uri: "file:///Users/user/.continuous/config.yaml",
      iconUrl: "",
      fullSlug: { ownerSlug: "", packageSlug: "", versionSlug: "" },
    },
  ];
  messenger.responses["config/getSerializedProfileInfo"] = info;

  const h = messenger.responseHandlers as any;
  // The file is written and opened by core; the page gets no answer to show
  h["config/addLocalWorkspaceBlock"] = async () => undefined;
  h["config/newPromptFile"] = async () => undefined;
  h["config/addGlobalRule"] = async () => undefined;
  h["config/openProfile"] = async () => undefined;

  // "Test connection" with any key: the listing a provider would give
  h["openaiCompat/testConnection"] = async () => ({
    ok: true,
    models: ["claude-sonnet-4-5", "claude-haiku-4-5"],
  });

  // Save: core writes the models and reloads the config, which reaches the
  // page as a configUpdate. The models come from the request, with a key;
  // they get the roles the request names (chat, edit, apply and summarize
  // when it names none), and the first is selected for each role of
  // `selectFor`, as the "Use for" step said it would be.
  h["config/saveProviderModels"] = async (req: any) => {
    const info: any = structuredClone(
      messenger.responses["config/getSerializedProfileInfo"],
    );
    const added = (req.add ?? []).map((m: any) => ({
      title: m.title,
      model: m.model,
      provider: m.provider,
      underlyingProviderName: m.provider,
      contextLength: m.contextLength ?? 200_000,
      configurationStatus: "valid",
    }));
    const config = info.result.config;
    for (const role of req.roles ?? ["chat", "edit", "apply", "summarize"]) {
      (config.modelsByRole[role] ??= []).push(...added);
    }
    for (const role of added.length ? (req.selectFor ?? []) : []) {
      config.selectedModelByRole[role] = added[0];
    }
    messenger.responses["config/getSerializedProfileInfo"] = info;
    const setup: any = structuredClone(
      messenger.responses["config/getProviderSetup"],
    );
    setup.connections.push({
      provider: req.provider,
      connection: req.connection ?? {},
      models: added.map((m: any) => ({ name: m.title, model: m.model })),
      key: { state: "secret", secretName: req.key?.secretName },
    });
    (messenger.responses as any)["config/getProviderSetup"] = setup;
    sendConfig(messenger);
    return { saved: true };
  };

  // The MCP servers tab and its Add dialog. Where things are saved is the
  // answer the dialog's own pictures use (fixtures.ts): one open folder with
  // no MCP files yet, and the person's config.yaml, which holds the server
  // the walk starts with.
  const scopes = mcpScopes("none");
  const r = messenger.responses as any;
  r["mcp/scopes"] = scopes;
  r["mcp/list"] = {
    servers: [
      {
        name: "github",
        scope: "user",
        file: scopes.user.file,
        transport: "stdio",
        target: "github-mcp-server",
        secrets: [],
        envNames: [],
        headerNames: [],
      },
    ],
    problems: [],
  };

  // No other tool's MCP settings on this computer to import
  r["config/previewMcpImport"] = { sources: [] };

  // core's own parser reads the paste; nothing here knows what it will find
  h["mcp/parsePaste"] = async (req: any) => {
    const parsed = parseMcpPaste(String(req?.text ?? ""));
    return {
      candidates: parsed.candidates.map(candidateForPage),
      warnings: parsed.warnings,
    };
  };

  // core's own check of the command, as on the Windows computer the paths
  // above belong to. Whether the program is installed (the runtime line)
  // needs a real PATH and is left out.
  h["mcp/analyzeLaunch"] = async (req: any) => ({
    analysis: analyzeLaunch(req.draft, {
      platform: "win32",
      homeDir: String.raw`C:\Users\dev`,
      workspaceDir: scopes.folders[0].dir,
    }),
    expired: false,
  });

  // Save: core writes the entry, reloads the config and answers with the
  // file. The reload reaches the page as a configUpdate with the server
  // starting, and `mcp/list` has it from then on. What the server offers is
  // not known here: nothing is run.
  h["mcp/save"] = async (req: any) => {
    const draft = req.draft;
    const project = req.scope === "project";
    const folder = scopes.folders[0];
    const file = project
      ? `${folder.mcpDir}\\${draft.name}.yaml`
      : scopes.user.file;
    r["mcp/list"] = {
      servers: [
        ...r["mcp/list"].servers,
        {
          name: draft.name,
          scope: project ? "project" : "user",
          file,
          transport: draft.transport,
          ...(project ? { folder: folder.dir } : {}),
          target:
            draft.command === undefined
              ? (draft.url ?? "")
              : [draft.command, ...(draft.args ?? [])].join(" "),
          secrets: [],
          envNames: (draft.env ?? []).map((v: any) => v.name),
          headerNames: (draft.headers ?? []).map((v: any) => v.name),
        },
      ],
      problems: [],
    };
    const info: any = structuredClone(
      messenger.responses["config/getSerializedProfileInfo"],
    );
    info.result.config.mcpServerStatuses.push({
      id: draft.name,
      name: draft.name,
      ...(draft.command === undefined
        ? { url: draft.url }
        : { type: "stdio", command: draft.command, args: draft.args ?? [] }),
      status: "connecting",
      configSource: project ? "workspace" : "user",
      ...(project ? { sourceFile: file } : {}),
      errors: [],
      infos: [],
      prompts: [],
      resources: [],
      resourceTemplates: [],
      tools: [],
    });
    messenger.responses["config/getSerializedProfileInfo"] = info;
    sendConfig(messenger);
    return {
      ok: true,
      scope: project ? "project" : "user",
      file,
      name: draft.name,
      secretsStored: [],
      secretsPending: [],
      warnings: [],
    };
  };

  (window as any).__walk = {
    log,
    /** A control of the editor itself (the gear in the view title): the message it sends */
    ide: (type: string, data: unknown) =>
      messenger.mockMessageToWebview(type as never, data as never),
  };
}
