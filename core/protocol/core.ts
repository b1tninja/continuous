import {
  BlockType,
  ConfigResult,
  DevDataLogEvent,
  ModelRole,
  ToolDialectSetting,
} from "@continuedev/config-yaml";
import { ToolPolicy } from "@continuedev/terminal-security";

import {
  AutocompleteInput,
  RecentlyEditedRange,
} from "../autocomplete/util/types";
import type {
  TerminalEnvironmentMode,
  TerminalEnvironmentStatus,
} from "../util/terminalEnvironment";
import type { CatalogModel } from "../llm/openRouterCatalog";
import type { CommunityPrice } from "../llm/communityCatalog";
import { ProfileDescription } from "../config/ProfileLifecycleManager";
import { SharedConfigSchema } from "../config/sharedConfig";
import type {
  MovePlaintextKeysResult,
  PlaintextKey,
  ProviderInstancesInfo,
  SaveProviderInstanceRequest,
  SaveProviderInstanceResult,
} from "../config/providers/types";
import type { ModeModelsInput } from "../config/yaml/saveModeModels";
import type { SubagentLoadResult } from "../subagents/loadSubagents";
import type { ApplyPatchResult, WorktreeInfo } from "../util/worktree";
import type { DetectedLocalServer } from "../llm/localServers";
import type { RulesByModeInput } from "../config/yaml/saveRulesByMode";
import type {
  ModelBlockInfo,
  ModelEditPreview,
  ModelEditSaveResult,
} from "../config/modelEdit/modelBlockEdit";
import type { ModelPatchOp } from "../config/modelEdit/modelEditFields";
import type {
  AutoReviewReply,
  AutoReviewRequest,
} from "../tools/permissions/auto/handler";
import type {
  McpImportPreview,
  McpImportRequest,
  McpImportResult,
} from "../config/importClineMcp";
import type {
  ProviderSetupInfo,
  SaveProviderModelsRequest,
  SaveProviderModelsResult,
} from "../config/providerSetup";
import type { DecisionSource as ToolDecisionSource } from "../tools/permissions/decide";
import type { AuditListProtocol } from "./audit";
import type { ApprovalSettings } from "../tools/permissions/approval";
import type { RuleEditRequest } from "../tools/permissions/ruleEditorHandlers";
import { GlobalContextModelSelections } from "../util/GlobalContext";

import {
  BaseSessionMetadata,
  BrowserSerializedContinueConfig,
  ChatMessage,
  CompiledMessagesResult,
  CompleteOnboardingPayload,
  ContextItem,
  ContextItemWithId,
  ContextSubmenuItem,
  DiffLine,
  DocsIndexingDetails,
  ExperimentalModelRoles,
  FileSymbolMap,
  IdeSettings,
  LLMFullCompletionOptions,
  McpUiState,
  MessageOption,
  ModelDescription,
  PromptLog,
  RangeInFile,
  RangeInFileWithNextEditInfo,
  SerializedContinueConfig,
  Session,
  SessionDelta,
  SessionSaveResult,
  SiteIndexingConfig,
  SlashCommandDescWithSource,
  StreamDiffLinesPayload,
  ToolCall,
} from "../";
import { AutocompleteCodeSnippet } from "../autocomplete/snippets/types";
import { GetLspDefinitionsFunction } from "../autocomplete/types";
import { ConfigHandler } from "../config/ConfigHandler";
import { ProcessedItem } from "../nextEdit/NextEditPrefetchQueue";
import { NextEditOutcome } from "../nextEdit/types";
import { ContinueErrorReason } from "../util/errors";
import type { ProbeStatus } from "../util/measuredFacts";
import type { RetirementNotice } from "../util/modelRetirement";
import type { OpenAICompatTestResult } from "../util/openaiCompatTest";

export enum OnboardingModes {
  API_KEY = "API Key",
  LOCAL = "Local",
}

export interface ListHistoryOptions {
  offset?: number;
  limit?: number;
  workspaceDirectory?: string;
}

/** Connection settings the add-model form sends to try out Bedrock before saving. */
export interface BedrockConnectionParams {
  /** "mantle" targets the OpenAI-compatible bedrock-mantle endpoint; default is bedrock-runtime. */
  endpoint?: "mantle";
  mantlePathPrefix?: string;
  maxTokensParam?: string;
  region?: string;
  apiKey?: string;
  apiBase?: string;
  profile?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  crossRegionInference?: string;
  serviceTier?: string;
  latency?: string;
  guardrailIdentifier?: string;
  guardrailVersion?: string;
}

export interface BedrockModelOptionInfo {
  id: string;
  name: string;
  provider: string;
  kind: "on-demand" | "inference-profile" | "application-profile";
  baseModelId?: string;
  legacy?: boolean;
  /** Anthropic model on an account that has not filled out the use-case form. */
  needsAnthropicUseCase?: boolean;
  /**
   * The account's access to the model (GetFoundationModelAvailability):
   * absent when not checked, "needs-access" when the agreement is missing
   * (a legacy model the account has not used lately shows the same), and
   * "pending" while an access request is open.
   */
  access?: "available" | "needs-access" | "pending";
  /**
   * Set when the account's applied tokens- or requests-per-minute quota for
   * this model on its route is 0 (Service Quotas): the warning to show
   * before the first request, with the Service Quotas console link.
   */
  quotaWarning?: string;
}

/** The optional Service Quotas check that runs with Test connection. */
export interface BedrockQuotaCheckInfo {
  /** `ok`: quotas known; `skipped`: not checked (see `note`); `off`: model information updates are off */
  status: "ok" | "skipped" | "off";
  /** One quiet line, e.g. "Quota check skipped: this profile lacks servicequotas:ListServiceQuotas" */
  note?: string;
  docsUrl?: string;
  fetchedAt?: string;
  /** How many listed models have a 0 quota on their route */
  zeroQuotaModels?: number;
}

export type BedrockListModelsResult =
  | {
      ok: true;
      models: BedrockModelOptionInfo[];
      quota?: BedrockQuotaCheckInfo;
    }
  | { ok: false; error: string };

/**
 * Whether the account lists the `global.` inference profile of a configured
 * Bedrock model that uses a regional ID. "unknown" when nothing could be
 * checked (not a Bedrock model, no regional prefix, or the listing failed).
 */
export type BedrockGlobalProfileStatus = "present" | "absent" | "unknown";

export type BedrockTestModelResult =
  | { ok: true; modelId: string; latencyMs: number; reply: string }
  | { ok: false; error: string };

/** The wizard's tool-call probe: what the model did with a made-up tool. */
export type BedrockProbeToolCallsResult =
  | {
      ok: true;
      label: string;
      kind: "native" | "text" | "none" | "unknown";
      /** What the model-family preset says about this model, when it has one. */
      preset?: string;
      /** Provider facts line (information only). */
      facts?: string;
    }
  | { ok: false; error: string };

export type ProfileFileResult =
  { ok: true; profileId?: string } | { ok: false; error: string };

export type ToCoreFromIdeOrWebviewProtocol = AuditListProtocol & {
  // Special
  ping: [string, string];
  abort: [undefined, void];
  cancelApply: [undefined, void];

  // History
  "history/list": [ListHistoryOptions, BaseSessionMetadata[]];
  "history/delete": [{ id: string }, void];
  "history/load": [{ id: string }, Session];
  "history/save": [Session, SessionSaveResult | void];
  "history/saveDelta": [SessionDelta, SessionSaveResult];
  "history/share": [{ id: string; outputDir?: string }, void];
  "history/clear": [undefined, void];
  "devdata/log": [DevDataLogEvent, void];
  "config/addOpenAiKey": [string, void];
  "config/addModel": [
    {
      model: SerializedContinueConfig["models"][number];
      role?: keyof ExperimentalModelRoles;
    },
    void,
  ];
  "config/addLocalWorkspaceBlock": [
    { blockType: BlockType; baseFilename?: string },
    void,
  ];
  "config/addGlobalRule": [undefined | { baseFilename?: string }, void];
  "config/deleteRule": [{ filepath: string }, void];
  "config/newPromptFile": [undefined, void];
  "config/newAssistantFile": [undefined, void];
  /** Create a config (or a copy of `copyFrom`) and select it. */
  "config/createProfile": [
    {
      name: string;
      location: "global" | "workspace";
      copyFrom?: string;
    },
    ProfileFileResult,
  ];
  /** Rename a config; its id changes unless it is the main config. */
  "config/renameProfile": [
    { profileId: string; name: string },
    ProfileFileResult,
  ];
  /** Delete a config file; the main config cannot be deleted. */
  "config/deleteProfile": [{ profileId: string }, ProfileFileResult];
  "config/ideSettingsUpdate": [IdeSettings, void];
  "config/getSerializedProfileInfo": [
    undefined,
    {
      result: ConfigResult<BrowserSerializedContinueConfig>;
      profileId: string | null;
      profiles: ProfileDescription[];
    },
  ];
  "config/deleteModel": [{ title: string }, void];
  /**
   * Write `modeModels` in the global config.yaml (comments kept). Returns
   * whether a config.yaml was edited; false means there was none to edit.
   */
  "config/setModeModels": [ModeModelsInput, { saved: boolean }];
  /**
   * Set `toolDialect` on the model with this title in the local config.yaml
   * (the leak notice's one-click action). `saved` is false when there is no
   * such entry to edit.
   */
  "config/setToolDialect": [
    {
      title: string;
      toolDialect: ToolDialectSetting;
      /**
       * Ask in the IDE's own dialog first (the page cannot answer it). When
       * the answer is no, nothing is written and `declined` is true.
       */
      confirm?: string;
    },
    { saved: boolean; declined?: boolean },
  ];
  /**
   * The config.yaml entry of the model with this title, for the model
   * configuration dialog. Plain credential values are masked; secret
   * references are returned as names.
   */
  "config/getModelBlock": [{ title: string }, ModelBlockInfo];
  /** Check a change to that entry and return the YAML diff it would make. */
  "config/previewModelEdit": [
    { title: string; ops: ModelPatchOp[] },
    ModelEditPreview,
  ];
  /**
   * Write the change, if the file still matches the preview's `baseHash`.
   * Comments, key order and keys the dialog does not manage are kept.
   */
  "config/saveModelEdit": [
    { title: string; ops: ModelPatchOp[]; baseHash: string },
    ModelEditSaveResult,
  ];
  /**
   * The effective policy for the environment commands inherit, where it comes
   * from, and the NAMES (never values) of the variables in this process.
   */
  "config/getTerminalEnvironment": [
    undefined,
    TerminalEnvironmentStatus & {
      hostEnvNames: string[];
      credentialUrlNames: string[];
      /** The host's process.platform; a webview has no `process`. */
      platform?: NodeJS.Platform;
    },
  ];
  /**
   * Write `terminal.environment` / `passEnv` to the user's own config.yaml
   * (comments kept). `null` removes a field.
   */
  "config/setTerminalEnvironment": [
    { environment?: TerminalEnvironmentMode | null; passEnv?: string[] },
    { saved: boolean },
  ];
  /**
   * Switch rules on or off per mode in the global config.yaml (comments kept).
   * `null` removes a mode's entry. Returns false when there is no config.yaml.
   */
  "config/setRulesByMode": [RulesByModeInput, { saved: boolean }];
  /**
   * Change the person's own rules in the global config.yaml (comments kept,
   * only the core dialect written). Every answer is a named result; nothing is
   * written on a dry run, on a broken file, or when the file changed since
   * `baseHash`. `add` is also what "Always allow" sends.
   */
  "config/addToolRule": [
    RuleEditRequest,
    import("../tools/permissions/ruleEditor").ToolRuleEditResponse,
  ];
  "config/updateToolRule": [
    RuleEditRequest,
    import("../tools/permissions/ruleEditor").ToolRuleEditResponse,
  ];
  "config/removeToolRule": [
    RuleEditRequest,
    import("../tools/permissions/ruleEditor").ToolRuleEditResponse,
  ];
  /** Copy a rule from an assistant or workspace file into the person's own */
  "config/adoptToolRule": [
    RuleEditRequest,
    import("../tools/permissions/ruleEditor").ToolRuleEditResponse,
  ];
  /** Put back the file as it was before this session's last rule change, if it is unchanged since */
  "config/undoToolRule": [
    (
      | { source?: import("../tools/permissions/ruleAnalysis").ChangeSource }
      | undefined
    ),
    import("../tools/permissions/ruleEditor").UndoResponse,
  ];
  /**
   * Shadow reviewer (B16) as the Settings page shows it: the saved switch,
   * budget and timeout from the person's own config.yaml, and the spend and
   * review count from the shared spend ledger.
   */
  "audit/shadowSettings": [
    undefined,
    import("../tools/permissions/audit/shadowSettingsHandlers").ShadowSettingsView,
  ];
  /**
   * Change `audit.shadowReviewer` in the person's own config.yaml (comments
   * kept, only those keys written). Turning it on waits for the IDE's own
   * dialog. Budget: more than 0 and at most 100 dollars.
   */
  "audit/setShadowSettings": [
    import("../tools/permissions/audit/shadowConfig").ShadowChange,
    import("../tools/permissions/audit/shadowSettingsHandlers").ShadowSetResponse,
  ];
  /**
   * The narrowest allow rule for a pending tool call, or why there is none.
   * Nothing is written; "Always allow" then sends the rule to config/addToolRule.
   */
  "tools/suggestAllowRule": [
    { toolName: string; parsedArgs: Record<string, unknown> },
    (
      | {
          ok: true;
          rule: string;
          summary: string;
          /** The tool's own safety check would still ask; confirm before saving. */
          loosensCheck?: boolean;
        }
      | { ok: false; reason: string }
    ),
  ];
  "config/refreshProfiles": [
    (
      | undefined
      | {
          reason?: string;
          selectProfileId?: string;
        }
    ),
    void,
  ];
  "config/openProfile": [{ profileId: string | undefined }, void];
  "config/updateSharedConfig": [SharedConfigSchema, SharedConfigSchema];
  "config/updateSelectedModel": [
    {
      profileId: string;
      role: ModelRole;
      title: string | null;
    },
    GlobalContextModelSelections,
  ];
  /**
   * Take the user to where a secret that is missing on this machine must be
   * set: the .env file (created with an empty `NAME=` line), or the line of
   * the config that uses it.
   */
  /** Configured models grouped by provider connection. Never returns a key. */
  "config/getProviderSetup": [undefined, ProviderSetupInfo];
  /**
   * Add and remove models of one provider connection in config.yaml and, when
   * `key` is given, store the key where the user chose. The key value is
   * never written to config.yaml unless storage is "inline".
   */
  "config/saveProviderModels": [
    SaveProviderModelsRequest,
    SaveProviderModelsResult,
  ];
  /**
   * Find Cline and Roo Code MCP settings files and say what importing each
   * server would do. Lists secret names only, never values.
   */
  "config/previewMcpImport": [undefined, McpImportPreview];
  /**
   * Add the chosen servers from a detected Cline / Roo Code settings file to
   * config.yaml. Credentials become ${{ secrets.NAME }} references.
   */
  "config/importMcpServers": [McpImportRequest, McpImportResult];
  /** Store one secret (secure storage or ~/.continuous/.env) and reload. */
  "config/setSecret": [
    { secretName: string; value: string; storage: "secure" | "env" },
    {
      stored: boolean;
      error?: string;
      warning?: string;
      /** The name also has a plaintext copy in ~/.continuous/.env. */
      envShadowed?: boolean;
    },
  ];
  /**
   * Remove a secret's line from ~/.continuous/.env. Only sent after the user
   * agreed, and only honored when the value is in secure storage.
   */
  /**
   * Move a key from ~/.continuous/.env to secure storage, then remove the .env
   * line. The value is handled in core and never returned. config.yaml keeps
   * its `${{ secrets.NAME }}` reference.
   */
  "config/moveKeyToSecureStorage": [
    { secretName: string },
    { moved: boolean; envRemoved?: boolean; error?: string },
  ];
  "config/removeEnvSecret": [
    { secretName: string },
    { removed: boolean; error?: string },
  ];
  /** Provider instances (providers.yaml), with key state but no values. */
  "providers/list": [undefined, ProviderInstancesInfo];
  /** Add or edit an instance in ~/.continuous/providers.yaml. */
  "providers/save": [SaveProviderInstanceRequest, SaveProviderInstanceResult];
  /** Remove an instance from ~/.continuous/providers.yaml (its key is kept). */
  "providers/delete": [{ name: string }, { deleted: boolean; error?: string }];
  /**
   * Turn the selected config's models of one connection set up the old way
   * into a provider account, catalog models (models.yaml) and `from:`
   * entries. `converted` is how many models moved.
   */
  "config/convertConnectionToAccount": [
    {
      provider: string;
      connection: import("../config/providerSetup").ProviderConnectionKey;
      accountName?: string;
    },
    { account?: string; converted: number; error?: string },
  ];
  /** Add a model that uses a provider instance to the selected config. */
  "config/addConnectedModel": [
    { connection: string; model: string; name?: string; roles?: string[] },
    { saved: boolean; error?: string },
  ];
  /** API keys written as plain text in local configs and providers files. */
  "config/findPlaintextKeys": [
    undefined,
    { keys: PlaintextKey[]; secureStorageAvailable: boolean },
  ];
  /**
   * Store the chosen plaintext keys as secrets and replace each with a
   * `${{ secrets.NAME }}` reference. Values never leave core.
   */
  "config/movePlaintextKeys": [
    { ids: string[]; storage: "secure" | "env" },
    MovePlaintextKeysResult,
  ];
  "config/openSecretLocation": [
    { secretName: string; target: "env" | "configLine" },
    void,
  ];
  "context/getContextItems": [
    {
      name: string;
      query: string;
      fullInput: string;
      selectedCode: RangeInFile[];
      isInAgentMode: boolean;
    },
    ContextItemWithId[],
  ];

  "mcp/reloadServer": [
    {
      id: string;
    },
    void,
  ];
  "mcp/setServerEnabled": [{ id: string; enabled: boolean }, void];
  "mcp/getPrompt": [
    {
      serverName: string;
      promptName: string;
      args?: Record<string, string>;
    },
    {
      prompt: string;
      description: string | undefined;
    },
  ];
  "mcp/startAuthentication": [
    {
      serverId: string;
      serverUrl: string;
    },
    void,
  ];
  "mcp/removeAuthentication": [
    {
      serverId: string;
      serverUrl: string;
    },
    void,
  ];
  "context/getSymbolsForFiles": [{ uris: string[] }, FileSymbolMap];
  "context/loadSubmenuItems": [{ title: string }, ContextSubmenuItem[]];
  "autocomplete/complete": [AutocompleteInput, string[]];
  "context/addDocs": [SiteIndexingConfig, void];
  "context/removeDocs": [Pick<SiteIndexingConfig, "startUrl">, void];
  "context/indexDocs": [{ reIndex: boolean }, void];
  "autocomplete/cancel": [undefined, void];
  "autocomplete/accept": [{ completionId: string }, void];
  "nextEdit/predict": [
    {
      input: AutocompleteInput;
      options?: {
        withChain?: boolean;
        usingFullFileDiff?: boolean;
      };
    },
    NextEditOutcome | undefined,
  ];
  "nextEdit/reject": [{ completionId: string }, void];
  "nextEdit/accept": [{ completionId: string }, void];
  "nextEdit/startChain": [undefined, void];
  "nextEdit/deleteChain": [undefined, void];
  "nextEdit/isChainAlive": [undefined, boolean];
  "nextEdit/queue/getProcessedCount": [undefined, number];
  "nextEdit/queue/dequeueProcessed": [undefined, ProcessedItem | null];
  "nextEdit/queue/processOne": [
    {
      ctx: {
        completionId: string;
        manuallyPassFileContents?: string;
        manuallyPassPrefix?: string;
        selectedCompletionInfo?: {
          text: string;
          range: Range;
        };
        isUntitledFile: boolean;
        recentlyVisitedRanges: AutocompleteCodeSnippet[];
        recentlyEditedRanges: RecentlyEditedRange[];
      };
      recentlyVisitedRanges: AutocompleteCodeSnippet[];
      recentlyEditedRanges: RecentlyEditedRange[];
    },
    void,
  ];
  "nextEdit/queue/clear": [undefined, void];
  "nextEdit/queue/abort": [undefined, void];
  "llm/complete": [
    {
      prompt: string;
      completionOptions: LLMFullCompletionOptions;
      title: string;
    },
    string,
  ];
  "llm/listModels": [{ title: string }, string[] | undefined];
  "bedrock/listModels": [BedrockConnectionParams, BedrockListModelsResult];
  "bedrock/globalProfile": [{ title: string }, BedrockGlobalProfileStatus];
  "bedrock/testModel": [
    BedrockConnectionParams & { model: string },
    BedrockTestModelResult,
  ];
  "openaiCompat/testConnection": [
    {
      provider: string;
      apiBase?: string;
      apiKey?: string;
      model?: string;
      /** The configured model id to check with `GET /models/{id}`. */
      checkModel?: string;
    },
    OpenAICompatTestResult,
  ];
  /**
   * The last local Test connection result for a model's endpoint, from the
   * measured-facts file (core/util/measuredFacts.ts). "unknown" when none.
   */
  "openaiCompat/probeStatus": [
    { provider: string; apiBase?: string; model: string },
    ProbeStatus,
  ];
  /**
   * The deprecation or retirement notice for a configured Anthropic model,
   * from the checked-in table and the lifecycle the user's own key last
   * returned (core/util/modelRetirement.ts). No network call.
   */
  "model/retirementNotice": [
    { provider: string; model: string },
    { notice?: RetirementNotice },
  ];
  "model/dismissRetirementNotice": [{ provider: string; model: string }, void];
  "ollama/showHint": [
    { provider?: string; apiBase?: string; model: string },
    { serverParses?: boolean; toolsAdvertised?: boolean },
  ];
  "bedrock/probeToolCalls": [
    BedrockConnectionParams & { model: string },
    BedrockProbeToolCallsResult,
  ];
  "llm/streamChat": [
    {
      messages: ChatMessage[];
      completionOptions: LLMFullCompletionOptions;
      title: string;
      messageOptions?: MessageOption;
      legacySlashCommandData?: {
        command: SlashCommandDescWithSource;
        input: string;
        contextItems: ContextItemWithId[];
        historyIndex: number;
        selectedCode: RangeInFile[];
      };
    },
    AsyncGenerator<ChatMessage, PromptLog>,
  ];
  streamDiffLines: [StreamDiffLinesPayload, AsyncGenerator<DiffLine>];
  getDiffLines: [{ oldContent: string; newContent: string }, DiffLine[]];
  "llm/compileChat": [
    { messages: ChatMessage[]; options: LLMFullCompletionOptions },
    CompiledMessagesResult,
  ];
  "chatDescriber/describe": [
    {
      text: string;
    },
    string | undefined,
  ];
  "conversation/compact": [
    {
      index: number;
      sessionId: string;
      /**
       * The conversation as the chat last sent it, so the summary request can
       * read a warm prompt cache. Sent only when that is worth doing.
       */
      prefix?: {
        messages: ChatMessage[];
        options: LLMFullCompletionOptions;
      };
    },
    string | undefined,
  ];
  "stats/getTokensPerDay": [
    undefined,
    { day: string; promptTokens: number; generatedTokens: number }[],
  ];
  "stats/getTokensPerModel": [
    undefined,
    { model: string; promptTokens: number; generatedTokens: number }[],
  ];
  "tts/kill": [undefined, void];

  // Codebase indexing
  "index/setPaused": [boolean, void];
  "index/forceReIndex": [
    undefined | { dirs?: string[]; shouldClearIndexes?: boolean },
    void,
  ];
  "index/indexingProgressBarInitialized": [undefined, void];
  "onboarding/complete": [CompleteOnboardingPayload, void];

  // File changes
  "files/changed": [{ uris?: string[] }, void];
  "files/opened": [{ uris?: string[] }, void];
  "files/created": [{ uris?: string[] }, void];
  "files/deleted": [{ uris?: string[] }, void];
  "files/closed": [{ uris?: string[] }, void];
  "files/smallEdit": [
    {
      actions: RangeInFileWithNextEditInfo[];
      configHandler: ConfigHandler;
      getDefsFromLspFunction: GetLspDefinitionsFunction;
      recentlyEditedRanges: RecentlyEditedRange[];
      recentlyVisitedRanges: AutocompleteCodeSnippet[];
    },
    void,
  ];

  // Docs etc. Indexing. TODO move codebase to this
  "indexing/reindex": [{ type: string; id: string }, void];
  "indexing/abort": [{ type: string; id: string }, void];
  "indexing/setPaused": [{ type: string; id: string; paused: boolean }, void];
  "docs/getSuggestedDocs": [undefined, void];
  "docs/initStatuses": [undefined, void];
  "docs/getDetails": [{ startUrl: string }, DocsIndexingDetails];
  "docs/getIndexedPages": [{ startUrl: string }, string[]];
  addAutocompleteModel: [{ model: ModelDescription }, void];

  "auth/getAuthUrl": [{ useOnboarding: boolean }, { url: string }];
  /** Subagent definitions, read fresh from the agent folders on each call. */
  "subagents/list": [undefined, SubagentLoadResult];
  "tools/call": [
    {
      toolCall: ToolCall;
      /**
       * Run the call as if these folders (URIs) were the workspace: relative
       * paths resolve against them and a command runs in the first. For a
       * Loop worker's worktree; absolute paths stay as they are.
       */
      workspaceDirs?: string[];
      /**
       * File edits is IDGAF: the file tools may name a path outside
       * the workspace (tools/permissions/outsideEdits.ts). The decision was
       * made by tools/evaluatePolicy; this lets the tool resolve the path.
       */
      allowOutsideWorkspace?: boolean;
    },
    {
      contextItems: ContextItem[];
      errorMessage?: string;
      errorReason?: ContinueErrorReason;
      mcpUiState?: McpUiState;
    },
  ];
  /** The settings file shared with the CLI (plans/policy-areas.md, Settings). */
  "policy/load": [
    undefined,
    {
      settings: import("../tools/permissions/settingsFile").PolicyFileSettings;
      notices: string[];
    },
  ];
  "policy/save": [
    import("../tools/permissions/settingsFile").PolicyFileUpdate,
    void,
  ];
  /**
   * The save, dry-run: the exact permissions.yaml text core's writer would
   * produce, line by line, and what the save's native dialog would ask about.
   * Nothing is written.
   */
  "policy/preview": [
    import("../tools/permissions/settingsFile").PolicyFileUpdate,
    import("../tools/permissions/policySave").PolicySavePreview,
  ];
  /**
   * Every permission rule in effect with its area, source and state, and the
   * levels. Read-only. `levels` are the session's, when the caller has them.
   */
  "policy/rules": [
    { levels?: import("../tools/permissions/policy").PolicyLevels } | undefined,
    import("../tools/permissions/effectiveRules").EffectiveRulesReport,
  ];
  /**
   * The audit figures for the Permissions page, read from the audit index
   * (never the trail): per-rule use, the most-asked list, unused hints.
   * Read-only; masked keys only.
   */
  "audit/overview": [
    (
      | import("../tools/permissions/audit/overviewHandler").AuditOverviewRequest
      | undefined
    ),
    import("../tools/permissions/audit/auditOverview").AuditOverview,
  ];
  /** Run one call through the real evaluator and explain it. Nothing runs. */
  "policy/test": [
    Omit<
      import("../tools/permissions/testToolCall").TestToolCallInput,
      "sources" | "cwd" | "shell"
    >,
    import("../tools/permissions/testToolCall").ToolCallTestResult,
  ];
  "tools/evaluatePolicy": [
    {
      toolName: string;
      basePolicy: ToolPolicy;
      parsedArgs: Record<string, unknown>;
      processedArgs?: Record<string, unknown>;
      /** Approval mode and switches; absent means Manual. */
      approval?: ApprovalSettings;
      /** The call and session, so the decision can be written to the audit trail */
      callId?: string;
      sessionId?: string;
      /** Which agent made the call (main, a subagent or a Loop worker), for the audit */
      agent?: import("../tools/permissions/audit/record").AuditAgent;
      /**
       * The conversation as the reviewer sees it. Offered only for a call that
       * may be shadow-reviewed (off unless the person's config turns it on).
       */
      history?: import("../tools/permissions/auto/prompt").ReviewHistory;
    },
    {
      policy: ToolPolicy;
      displayValue?: string;
      /** Set only when the user has toolPermissions rules. */
      source?: ToolDecisionSource;
      /** A sentence saying why, for the prompt or the refusal. */
      reason?: string;
      /** A command the parser vouched as only reading */
      readOnly?: string;
      /** The rule that decided, as written in config.yaml. */
      rule?: string;
    },
  ];
  /**
   * Auto approval (experimental): decide one call. Core re-runs the rules
   * first; only a call they leave open reaches the reviewer model.
   */
  "tools/autoReview": [AutoReviewRequest, AutoReviewReply];
  /** The person's answer to a call that asked, for the audit trail */
  "audit/answer": [{ callId: string; approved: boolean }, void];
  /** A question answered for the person, where Questions is IDGAF (core/util/autoAnswer.ts) */
  "audit/autoAnswer": [
    { callId: string; question: string; answer: string; source: string },
    void,
  ];
  "tools/preprocessArgs": [
    {
      toolName: string;
      args: Record<string, unknown>;
      /** As for tools/call: resolve paths against these folders */
      workspaceDirs?: string[];
      /** As for tools/call: File edits is IDGAF */
      allowOutsideWorkspace?: boolean;
    },
    {
      preprocessedArgs?: Record<string, unknown>;
      errorReason?: ContinueErrorReason;
      errorMessage?: string;
    },
  ];
  "clipboardCache/add": [{ content: string }, void];
  isItemTooBig: [{ item: ContextItemWithId }, boolean];
  "process/markAsBackgrounded": [{ toolCallId: string }, void];
  "process/isBackgrounded": [{ toolCallId: string }, boolean];
  "process/killTerminalProcess": [{ toolCallId: string }, void];
  "mdm/setLicenseKey": [{ licenseKey: string }, boolean];
  /**
   * The dated local copy of OpenRouter's public model list. `status` and
   * `cached` read the file only; `pull` is a request to openrouter.ai made
   * when the person asks (Pull now, Refresh now), refused when model
   * information updates are `off`. With `automatic` (the default) core also
   * refreshes the copy in the background when it is older than
   * `refreshHours`; `lastAttempt` is that refresher's last request.
   */
  "modelCatalog/status": [
    undefined,
    {
      policy: "automatic" | "ask" | "never" | "off";
      refreshHours: number;
      lastAttempt?: { at: string; error?: string };
      openrouter?: { fetchedAt: string; count: number };
      /** The community catalogue copy (models.dev), when there is one */
      community?: { fetchedAt: string; count: number };
    },
  ];
  "modelCatalog/cached": [
    undefined,
    { fetchedAt: string; models: CatalogModel[] } | null,
  ];
  /**
   * The trimmed community catalogue copy (models.dev prices), the last price
   * source; a file read, null when there is none or updates are `off`.
   */
  "modelCatalog/communityCached": [
    undefined,
    { fetchedAt: string; prices: CommunityPrice[] } | null,
  ];
  "modelCatalog/pull": [
    undefined,
    (
      | { ok: true; fetchedAt: string; models: CatalogModel[] }
      | { ok: false; error: string }
    ),
  ];
  "modelCatalog/setPolicy": [
    {
      policy?: "automatic" | "ask" | "never" | "off";
      refreshHours?: number;
    },
    { saved: boolean },
  ];
  "models/fetch": [
    { provider: string; apiKey?: string; apiBase?: string },
    {
      name: string;
      modelId?: string;
      description?: string;
      icon?: string;
      popular?: boolean;
      contextLength?: number;
      maxTokens?: number;
      supportsTools?: boolean;
      supportsImages?: boolean;
      reasoningEfforts?: string[];
      server?: string;
      createdAt?: string;
      deprecated?: boolean;
    }[],
  ];
  /** OpenAI-compatible servers answering on this machine's common ports. */
  "models/detectLocal": [undefined, DetectedLocalServer[]];
  /** The model catalog (models.yaml): each model and each variant. */
  "models/catalog": [
    undefined,
    import("../config/yaml/saveModelRoles").CatalogListEntry[],
  ];
  /** Set the roles of catalog references and config models in the selected config. */
  "config/setModelRoles": [
    { updates: import("../config/yaml/saveModelRoles").ModelRolesUpdate[] },
    { saved: boolean },
  ];
  /** Requests the server of this chat model serves at once, when it says. */
  "models/serverConcurrency": [{ title: string }, number | undefined];
  /**
   * Loop mode's parallel waves (core/util/worktree.ts): a worktree for one
   * item from the checkout at `repo` (a local path), its patch, the patch
   * applied to the checkout or refused, the worktree removed, and the files
   * uncommitted in the checkout (for `touchedSince`).
   */
  "loop/worktreeCreate": [
    { repo: string; slug: string; itemId: string },
    WorktreeInfo,
  ];
  "loop/worktreePatch": [{ path: string; baseline: string }, string];
  "loop/worktreeApply": [
    { repo: string; patch: string; touchedSince?: string[] },
    ApplyPatchResult,
  ];
  "loop/worktreeRemove": [{ repo: string; path: string; branch: string }, void];
  "loop/dirtyFiles": [{ repo: string }, string[]];
};
