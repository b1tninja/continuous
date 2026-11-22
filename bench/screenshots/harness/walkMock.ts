// What `npm run walk` needs from the IDE side: a record of every message the
// page sends, of each time a message ends in an editor file, and the answers
// the three journeys wait for. core is not running here, so each answer below
// does what core's handler would have shown the page, and no more.
import { getFileContent } from "core/config/workspace/workspaceBlocks";
import type { FixtureContext } from "./fixtures";
import { sendConfig } from "./fixtures";

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
 * Messages after which the person is looking at a file in the editor, not at
 * the page. `config/addLocalWorkspaceBlock` is one: core writes the template
 * and calls `ide.openFile` (core/config/workspace/workspaceBlocks.ts).
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
  // page as a configUpdate. The models come from the request, with a key.
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
    info.result.config.modelsByRole.chat.push(...added);
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

  (window as any).__walk = {
    log,
    /** A control of the editor itself (the gear in the view title): the message it sends */
    ide: (type: string, data: unknown) =>
      messenger.mockMessageToWebview(type as never, data as never),
  };
}
