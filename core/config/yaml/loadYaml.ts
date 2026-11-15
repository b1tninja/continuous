import { resolveModeModels } from "./modeModels";
import { validateToolPermissions } from "../../tools/permissions/names";
import {
  AssistantUnrolled,
  AssistantUnrolledNonNullable,
  BLOCK_TYPES,
  ConfigResult,
  ConfigValidationError,
  mergeConfigYamlRequestOptions,
  mergeUnrolledAssistants,
  ModelRole,
  PackageIdentifier,
  RegistryClient,
  unrollAssistant,
  validateConfigYaml,
} from "@continuedev/config-yaml";
import { dirname } from "node:path";

import {
  ContinueConfig,
  IDE,
  IdeInfo,
  IdeSettings,
  ILLM,
  ILLMLogger,
  InternalMcpOptions,
} from "../..";
import { MCPManagerSingleton } from "../../context/mcp/MCPManagerSingleton";
import Bedrock from "../../llm/llms/Bedrock";
import TransformersJsEmbeddingsProvider from "../../llm/llms/TransformersJsEmbeddingsProvider";
import { getAllPromptFiles } from "../../promptFiles/getPromptFiles";
import { GlobalContext } from "../../util/GlobalContext";
import { modifyAnyConfigWithSharedConfig } from "../sharedConfig";

import { convertPromptBlockToSlashCommand } from "../../commands/slash/promptBlockSlashCommand";
import { slashCommandFromPromptFile } from "../../commands/slash/promptFileSlashCommand";
import { loadJsonMcpConfigs } from "../../context/mcp/json/loadJsonMcpConfigs";
import {
  gateWorkspaceMcpServers,
  mcpTrustByDir,
} from "../../context/mcp/workspaceMcpPolicy";
import { getBaseToolDefinitions } from "../../tools";
import { getCleanUriPath } from "../../util/uri";
import { loadConfigContextProviders } from "../loadContextProviders";
import { getAllDotContinueDefinitionFiles } from "../loadLocalAssistants";
import { unrollLocalYamlBlocks } from "./loadLocalYamlBlocks";
import * as YAML from "yaml";
import {
  clearFolderRules,
  recordAssistantAllows,
  recordFolderRules,
} from "../../tools/permissions/folderRules";
import {
  stripUntrustedLoosening,
  untrustedLooseningNotice,
} from "../../tools/permissions/trust";
import { beginTrustCheck, fileIsInsideDir } from "../projectTrust";
import {
  preferUserOwnedBlocks,
  selectWorkspaceBlocks,
  workspaceFileDestinationAllowed,
} from "../workspaceBlocks";

/**
 * A workspace block's YAML with the keys a repository may not set removed,
 * and a notice for each file that had any. Unparseable YAML is returned as
 * it was: the unroller reports it.
 */
function withoutUntrustedLoosening(
  path: string,
  content: string,
  notices: ConfigValidationError[],
): string {
  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch {
    return content;
  }
  recordFolderRules(path, parsed);
  const { config, removed } = stripUntrustedLoosening(parsed);
  if (removed.length === 0) return content;
  notices.push({
    fatal: false,
    uri: path,
    message: untrustedLooseningNotice(getCleanUriPath(path), removed),
  });
  return YAML.stringify(config);
}
import { loadModelCatalog } from "../providers/modelsFile";
import { resolveToolPermissions } from "../../tools/permissions/ruleTrust";
import { resolveTerminalSettings } from "../../util/terminalEnvironment";
import { readUserToolPermissions } from "../../util/userToolPermissions";
import { readUserTerminalSettings } from "../../util/userTerminalSettings";
import { applyWebConfig } from "../../util/webConfig";
import { readUserGuidance, withOwnGuidance } from "../../util/userGuidance";
import { loadProviderInstances } from "../providers/providersFile";
import { LocalPlatformClient } from "./LocalPlatformClient";
import { llmsFromModelConfig } from "./models";
import { unresolvedSecretErrors } from "./unresolvedSecretErrors";
import {
  convertYamlMcpConfigToInternalMcpOptions,
  convertYamlRuleToContinueRule,
} from "./yamlToContinueConfig";

async function loadConfigYaml(options: {
  overrideConfigYaml: AssistantUnrolled | undefined;
  ideSettings: IdeSettings;
  ide: IDE;
  packageIdentifier: PackageIdentifier;
}): Promise<
  ConfigResult<AssistantUnrolled> & { heldMcpServers: InternalMcpOptions[] }
> {
  const { overrideConfigYaml, ideSettings, ide, packageIdentifier } = options;

  // Add local .continuous blocks
  // Use "content" field to pass pre-read content directly, avoiding
  // fs.readFileSync which fails for vscode-remote:// URIs in WSL (#6242, #7810)
  // A block that came with the workspace may tighten (deny, ask) but not
  // loosen: its allow rules and reviewer guidance are dropped with a notice
  // (core/tools/permissions/trust.ts; plans/policy-areas.md, "Settings").
  // MCP, model and data blocks from the folder are held until that folder is
  // trusted (core/config/projectTrust.ts). Which of those are enforced is
  // TRUST_GATED_BLOCK_SCOPES.
  beginTrustCheck();
  const workspaceDirs = await ide.getWorkspaceDirs();
  const loadedBlocks = (
    await Promise.all(
      BLOCK_TYPES.map(async (blockType) => {
        const localBlocks = await getAllDotContinueDefinitionFiles(
          ide,
          { includeGlobal: true, includeWorkspace: true, fileExtType: "yaml" },
          blockType,
        );
        return localBlocks.map((b) => ({
          path: b.path,
          content: b.content,
          blockType,
        }));
      }),
    )
  ).flat();
  const {
    kept: keptBlocks,
    heldMcpServers,
    notices: trustNotices,
  } = await selectWorkspaceBlocks(ide, loadedBlocks, workspaceDirs);
  clearFolderRules();

  const localPackageIdentifiers: PackageIdentifier[] = keptBlocks.map((b) => ({
    uriType: "file" as const,
    fileUri: b.path,
    content: workspaceDirs.some((dir) => fileIsInsideDir(b.path, dir))
      ? withoutUntrustedLoosening(b.path, b.content, trustNotices)
      : b.content,
  }));

  // Registry client is only used if local blocks are present, but logic same for hub/local assistants
  const getRegistryClient = async () => {
    const rootPath =
      packageIdentifier.uriType === "file"
        ? dirname(getCleanUriPath(packageIdentifier.fileUri))
        : undefined;
    return new RegistryClient({
      rootPath,
    });
  };

  const errors: ConfigValidationError[] = [...trustNotices];

  // Named provider instances (providers.yaml) that models reach with
  // `connection:`; shared by every config.
  const providerInstances = await loadProviderInstances(ide);
  errors.push(...providerInstances.errors);
  // The model catalog (models.yaml) that config models use with `from:`
  const modelCatalog = await loadModelCatalog(ide);
  errors.push(...modelCatalog.errors);

  let config: AssistantUnrolled | undefined;

  if (overrideConfigYaml) {
    config = overrideConfigYaml;
    if (localPackageIdentifiers.length > 0) {
      const unrolledLocal = await unrollLocalYamlBlocks(
        localPackageIdentifiers,
        ide,
        await getRegistryClient(),
      );
      if (unrolledLocal.errors) {
        errors.push(...unrolledLocal.errors);
      }
      if (unrolledLocal.config) {
        config = mergeUnrolledAssistants(
          config,
          preferUserOwnedBlocks(config, unrolledLocal.config),
        );
      }
    }
  } else {
    // This is how we allow use of blocks locally
    const unrollResult = await unrollAssistant(
      packageIdentifier,
      await getRegistryClient(),
      {
        renderSecrets: true,
        currentUserSlug: "",
        platformClient: new LocalPlatformClient(ide),
        injectBlocks: localPackageIdentifiers,
        providers: providerInstances.providers,
        catalog: modelCatalog.models,
        offerCatalog: true,
      },
    );
    config = unrollResult.config;
    if (unrollResult.errors) {
      errors.push(...unrollResult.errors);
    }
  }

  if (config) {
    errors.push(...validateConfigYaml(nonNullifyConfigYaml(config)));
  }

  if (errors?.some((error) => error.fatal)) {
    return {
      errors,
      config: undefined,
      configLoadInterrupted: true,
      heldMcpServers,
    };
  }

  // Set defaults if undefined (this lets us keep config.json uncluttered for new users)
  return {
    config,
    errors,
    configLoadInterrupted: false,
    heldMcpServers,
  };
}

/**
 * A Bedrock model written as a bare ID that the account's catalog (as cached
 * by the last listing; no call is made here) offers only through an
 * inference profile fails at the first request; say so at config load.
 */
function bedrockInferenceProfileWarnings(
  llms: ILLM[],
): ConfigValidationError[] {
  const warnings: ConfigValidationError[] = [];
  for (const llm of llms) {
    if (!(llm instanceof Bedrock)) continue;
    const warning = llm.inferenceProfileWarning();
    if (warning) warnings.push({ fatal: false, message: warning });
  }
  return warnings;
}

function nonNullifyConfigYaml(
  unrolledAssistant: AssistantUnrolled,
): AssistantUnrolledNonNullable {
  return {
    ...unrolledAssistant,
    data: unrolledAssistant.data?.filter((k) => !!k),
    context: unrolledAssistant.context?.filter((k) => !!k),
    docs: unrolledAssistant.docs?.filter((k) => !!k),
    mcpServers: unrolledAssistant.mcpServers?.filter((k) => !!k),
    models: unrolledAssistant.models?.filter((k) => !!k),
    prompts: unrolledAssistant.prompts?.filter((k) => !!k),
    rules: unrolledAssistant.rules?.filter((k) => !!k).map((k) => k!),
  };
}

export async function configYamlToContinueConfig(options: {
  unrolledAssistant: AssistantUnrolled;
  ide: IDE;
  ideInfo: IdeInfo;
  uniqueId: string;
  llmLogger: ILLMLogger;
  /** Workspace MCP servers held back before secret rendering. */
  heldMcpServers?: InternalMcpOptions[];
}): Promise<{ config: ContinueConfig; errors: ConfigValidationError[] }> {
  let { unrolledAssistant, ide, ideInfo, uniqueId, llmLogger } = options;

  const localErrors: ConfigValidationError[] = [];

  const continueConfig: ContinueConfig = {
    slashCommands: [],
    tools: getBaseToolDefinitions(),
    mcpServerStatuses: [],
    contextProviders: [],
    modelsByRole: {
      chat: [],
      edit: [],
      apply: [],
      embed: [],
      autocomplete: [],
      rerank: [],
      summarize: [],
      subagent: [],
      reviewer: [],
    },
    selectedModelByRole: {
      chat: null,
      edit: null, // not currently used
      apply: null,
      embed: null,
      autocomplete: null,
      rerank: null,
      summarize: null,
      subagent: null,
      reviewer: null,
    },
    rules: [],
    requestOptions: { ...unrolledAssistant.requestOptions },
  };

  const config = nonNullifyConfigYaml(unrolledAssistant);

  for (const rule of config.rules ?? []) {
    const convertedRule = convertYamlRuleToContinueRule(rule);
    continueConfig.rules.push(convertedRule);
  }

  const workspaceDirsForData = await ide.getWorkspaceDirs();
  continueConfig.data = config.data?.flatMap((d) => {
    const sourceFile = (d as { sourceFile?: string }).sourceFile;
    if (
      !workspaceFileDestinationAllowed(
        d.destination,
        sourceFile,
        workspaceDirsForData,
      )
    ) {
      localErrors.push({
        fatal: false,
        message: `The data destination "${d.name}" from this folder was not used because its file location is outside your Continuous folder.`,
      });
      return [];
    }
    return [
      {
        ...d,
        requestOptions: mergeConfigYamlRequestOptions(
          d.requestOptions,
          continueConfig.requestOptions,
        ),
      },
    ];
  });
  continueConfig.docs = config.docs?.map((doc) => ({
    title: doc.name,
    startUrl: doc.startUrl,
    rootUrl: doc.rootUrl,
    faviconUrl: doc.faviconUrl,
    useLocalCrawling: doc.useLocalCrawling,
    sourceFile: doc.sourceFile,
  }));

  // Prompt files -
  try {
    const promptFiles = await getAllPromptFiles(ide, undefined, true);

    promptFiles.forEach((file) => {
      try {
        const slashCommand = slashCommandFromPromptFile(
          file.path,
          file.content,
        );
        if (slashCommand) {
          continueConfig.slashCommands?.push(slashCommand);
        }
      } catch (e) {
        // If the file is in a rules directory, we can provide a more helpful error message
        // because we know it's likely a rule definition
        const isRuleFile =
          file.path.toLowerCase().includes("/rules/") ||
          file.path.toLowerCase().includes("\\rules\\");

        let message = `Failed to convert prompt file ${file.path} to slash command: ${e instanceof Error ? e.message : e}`;

        if (isRuleFile) {
          const isYamlError =
            e instanceof Error &&
            (e.name?.includes("YAML") || e.message.includes("flow sequence"));

          const prefix = isYamlError
            ? "Failed to parse rule definition"
            : "Failed to process rule definition";

          const errorDetails = e instanceof Error ? e.message : String(e);
          message = `${prefix} ${file.path}: ${errorDetails}`;
        }

        localErrors.push({
          fatal: false,
          message,
        });
      }
    });
  } catch (e) {
    localErrors.push({
      fatal: false,
      message: `Error loading local prompt files: ${e instanceof Error ? e.message : e}`,
    });
  }

  config.prompts?.forEach((prompt) => {
    try {
      const slashCommand = convertPromptBlockToSlashCommand(prompt);
      continueConfig.slashCommands?.push(slashCommand);
    } catch (e) {
      localErrors.push({
        message: `Error loading prompt ${prompt.name}: ${e instanceof Error ? e.message : e}`,
        fatal: false,
      });
    }
  });

  // Models
  const defaultModelRoles: ModelRole[] = ["chat", "summarize", "apply", "edit"];
  for (const model of config.models ?? []) {
    model.roles = model.roles ?? defaultModelRoles; // Default to all 4 chat-esque roles if not specified

    try {
      const llms = await llmsFromModelConfig({
        model,
        uniqueId,
        llmLogger,
        config: continueConfig,
      });

      // No role: a catalog model offered to VS Code only (offerCatalog)
      if (model.roles.length === 0) {
        (continueConfig.offeredModels ??= []).push(...llms);
      }
      if (model.roles?.includes("chat")) {
        continueConfig.modelsByRole.chat.push(...llms);
      }

      if (model.roles?.includes("summarize")) {
        continueConfig.modelsByRole.summarize.push(...llms);
      }

      if (model.roles?.includes("apply")) {
        continueConfig.modelsByRole.apply.push(...llms);
      }

      if (model.roles?.includes("edit")) {
        continueConfig.modelsByRole.edit.push(...llms);
      }

      if (model.roles?.includes("autocomplete")) {
        continueConfig.modelsByRole.autocomplete.push(...llms);
      }

      if (model.roles?.includes("embed")) {
        const { provider } = model;
        if (provider === "transformers.js") {
          if (ideInfo.ideType === "vscode") {
            continueConfig.modelsByRole.embed.push(
              new TransformersJsEmbeddingsProvider(),
            );
          } else {
            localErrors.push({
              fatal: false,
              message: `Transformers.js embeddings provider not supported in this IDE.`,
            });
          }
        } else {
          continueConfig.modelsByRole.embed.push(...llms);
        }
      }

      if (model.roles?.includes("rerank")) {
        continueConfig.modelsByRole.rerank.push(...llms);
      }

      if (model.roles?.includes("subagent")) {
        continueConfig.modelsByRole.subagent.push(...llms);
      }

      // Only a model that lists `reviewer` itself; it is not in the default
      // roles, so no model becomes a reviewer by accident.
      if (model.roles?.includes("reviewer")) {
        continueConfig.modelsByRole.reviewer.push(...llms);
      }
    } catch (e) {
      localErrors.push({
        fatal: false,
        message: `Failed to load model:\nName: ${model.name}\nModel: ${model.model}\nProvider: ${model.provider}\n${e instanceof Error ? e.message : e}`,
      });
    }
  }

  // Every loaded model once, whatever its roles: the reviewer may be any of them
  const allLlms = Array.from(
    new Set(Object.values(continueConfig.modelsByRole).flat()),
  );

  localErrors.push(...bedrockInferenceProfileWarnings(allLlms));
  const modeModelsResult = resolveModeModels(
    config.modeModels,
    continueConfig.modelsByRole.chat,
    allLlms,
    (config.prompts ?? []).filter((p): p is NonNullable<typeof p> => !!p),
  );
  continueConfig.modeModels = modeModelsResult.modeModels;
  localErrors.push(...modeModelsResult.errors);
  // `modeModels.reviewer` is the reviewer: it joins the role's list if it is
  // not there and is selected (a Settings pick holds until reload, as a
  // manual pick does for a mode; see rectifySelectedModelsFromGlobalContext).
  const reviewerTitle = modeModelsResult.modeModels?.reviewer?.title;
  if (reviewerTitle) {
    const reviewer = allLlms.find((m) => m.title === reviewerTitle);
    if (reviewer) {
      if (!continueConfig.modelsByRole.reviewer.includes(reviewer)) {
        continueConfig.modelsByRole.reviewer.unshift(reviewer);
      }
      continueConfig.selectedModelByRole.reviewer = reviewer;
    }
  }
  continueConfig.rulesByMode = config.rulesByMode;

  // Tool rules. Kept even when some entries are unreadable: those are skipped
  // and reported, rather than failing the config.
  // Only the person's own config.yaml may add allow rules; deny and ask from
  // any source are kept (core/tools/permissions/ruleTrust.ts). Reviewer
  // guidance is the person's own, never the assistant's or a folder's.
  const ruleTrust = resolveToolPermissions(
    readUserToolPermissions(),
    config.toolPermissions,
  );
  // Remember what was dropped so the Permissions page can offer to adopt it
  const keptAllow = new Set(
    (ruleTrust.permissions?.allow ?? []).map((r) => r.trim()),
  );
  recordAssistantAllows(
    (config.toolPermissions?.allow ?? []).filter(
      (r): r is string => typeof r === "string" && !keptAllow.has(r.trim()),
    ),
  );
  const own = withOwnGuidance(ruleTrust.permissions, readUserGuidance());
  continueConfig.toolPermissions = own.permissions;
  localErrors.push(
    ...ruleTrust.notices.map((message) => ({ fatal: false, message })),
    ...own.notices.map((message) => ({ fatal: false, message })),
  );
  // Only the person's own config.yaml may loosen what commands inherit; what
  // the assistant or a folder sets is held to the default or tighter.
  localErrors.push(
    ...resolveTerminalSettings(
      readUserTerminalSettings(),
      config.terminal,
    ).notices.map((message) => ({ fatal: false, message })),
  );
  // Only the person's own config.yaml may loosen the web settings or set what
  // is sent to sites; other sources may only tighten (core/util/webConfig.ts).
  // Old spellings are announced once per process.
  const web = applyWebConfig(config.web);
  localErrors.push(
    ...[...web.notices, ...web.deprecations].map((message) => ({
      fatal: false,
      message,
    })),
  );
  localErrors.push(...validateToolPermissions(config.toolPermissions));

  // Secrets that no .env file or environment variable provided are still
  // `${{ secrets.NAME }}` here. Say so, instead of letting the literal text be
  // sent to the provider as an API key.
  localErrors.push(
    ...unresolvedSecretErrors(
      (config.models ?? []).map((m) => ({
        name: m.name,
        provider: m.provider,
        apiKey: m.apiKey,
        env: m.env,
        requestOptions: m.requestOptions,
      })),
    ),
  );

  // Add transformers js to the embed models in vs code if not already added
  if (
    ideInfo.ideType === "vscode" &&
    !continueConfig.modelsByRole.embed.find(
      (m) => m.providerName === "transformers.js",
    )
  ) {
    continueConfig.modelsByRole.embed.push(
      new TransformersJsEmbeddingsProvider(),
    );
  }

  const { providers, errors: contextErrors } = loadConfigContextProviders(
    config.context,
    !!config.docs?.length,
    ideInfo.ideType,
  );

  continueConfig.contextProviders = providers;
  localErrors.push(...contextErrors);

  // Trigger MCP server refreshes (Config is reloaded again once connected!)
  const mcpManager = MCPManagerSingleton.getInstance();

  const mcpOptions: InternalMcpOptions[] = (config.mcpServers ?? []).map(
    (server) =>
      convertYamlMcpConfigToInternalMcpOptions(server, config.requestOptions),
  );
  const { errors: jsonMcpErrors, mcpServers } = await loadJsonMcpConfigs(
    ide,
    true,
    config.requestOptions,
  );
  localErrors.push(...jsonMcpErrors);
  mcpOptions.push(...mcpServers);
  if (options.heldMcpServers?.length) {
    mcpOptions.push(...options.heldMcpServers);
  }
  const workspaceDirs = await ide.getWorkspaceDirs();
  const isTrusted = await mcpTrustByDir(ide, workspaceDirs, mcpOptions);
  const gated = gateWorkspaceMcpServers(mcpOptions, workspaceDirs, isTrusted);
  localErrors.push(...gated.notices);
  mcpManager.setConnections(gated.servers, false, { ide });

  return { config: continueConfig, errors: localErrors };
}

export async function loadContinueConfigFromYaml(options: {
  ide: IDE;
  ideSettings: IdeSettings;
  ideInfo: IdeInfo;
  uniqueId: string;
  llmLogger: ILLMLogger;
  overrideConfigYaml: AssistantUnrolled | undefined;
  packageIdentifier: PackageIdentifier;
}): Promise<ConfigResult<ContinueConfig>> {
  const {
    ide,
    ideSettings,
    ideInfo,
    uniqueId,
    llmLogger,
    overrideConfigYaml,
    packageIdentifier,
  } = options;

  const configYamlResult = await loadConfigYaml({
    overrideConfigYaml,
    ideSettings,
    ide,
    packageIdentifier,
  });

  if (!configYamlResult.config || configYamlResult.configLoadInterrupted) {
    return {
      errors: configYamlResult.errors,
      config: undefined,
      configLoadInterrupted: true,
      configName: configYamlResult.configName,
    };
  }

  const { config: continueConfig, errors: localErrors } =
    await configYamlToContinueConfig({
      unrolledAssistant: configYamlResult.config,
      ide,
      ideInfo,
      uniqueId,
      llmLogger,
      heldMcpServers: configYamlResult.heldMcpServers,
    });

  // Apply shared config
  // TODO: override several of these values with user/org shared config
  // Don't try catch this - has security implications and failure should be fatal
  const sharedConfig = new GlobalContext().getSharedConfig();
  const withShared = modifyAnyConfigWithSharedConfig(
    continueConfig,
    sharedConfig,
  );
  if (withShared.allowAnonymousTelemetry === undefined) {
    withShared.allowAnonymousTelemetry = true;
  }

  return {
    config: withShared,
    errors: [...(configYamlResult.errors ?? []), ...localErrors],
    configLoadInterrupted: false,
    configName: configYamlResult.configName,
  };
}
