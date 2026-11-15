import * as z from "zod";
import { commonModelSlugs } from "./commonSlugs.js";
import { dataSchema } from "./data/index.js";
import { mcpServerSchema, partialMcpServerSchema } from "./mcp/index.js";
import {
  catalogModelRefSchema,
  connectedModelSchema,
  modelSchema,
  partialModelSchema,
  requestOptionsSchema,
} from "./models.js";

export const contextSchema = z.object({
  name: z.string().optional(),
  provider: z.string(),
  params: z.any().optional(),
});

export { MCPServer } from "./mcp/index.js";

const promptSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  prompt: z.string(),
  sourceFile: z.string().optional(),
});

export type Prompt = z.infer<typeof promptSchema>;

const docSchema = z.object({
  name: z.string(),
  startUrl: z.string(),
  rootUrl: z.string().optional(),
  faviconUrl: z.string().optional(),
  useLocalCrawling: z.boolean().optional(),
  sourceFile: z.string().optional(),
});

export type DocsConfig = z.infer<typeof docSchema>;

const ruleObjectSchema = z.object({
  name: z.string(),
  rule: z.string(),
  description: z.string().optional(),
  globs: z.union([z.string(), z.array(z.string())]).optional(),
  regex: z.union([z.string(), z.array(z.string())]).optional(),
  alwaysApply: z.boolean().optional(),
  invokable: z.boolean().optional(),
  sourceFile: z.string().optional(),
});
const ruleSchema = z.union([z.string(), ruleObjectSchema]);

/**
 * A schema for rules.json files
 */
export const rulesJsonSchema = z.object({
  name: z.string(),
  version: z.string(),
  author: z.string().optional(),
  license: z.string().optional(),
  rules: z.record(z.string(), z.string()).optional(),
});

export type Rule = z.infer<typeof ruleSchema>;
export type RuleObject = z.infer<typeof ruleObjectSchema>;
/**
 * A schema for rules.json files
 */
export type RulesJson = z.infer<typeof rulesJsonSchema>;

const defaultUsesSchema = z.string();

export const blockItemWrapperSchema = <T extends z.ZodObject>(
  schema: T,
  usesSchema: z.ZodType<any> = defaultUsesSchema,
) =>
  z.object({
    uses: usesSchema,
    with: z.record(z.string(), z.string()).optional(),
    override: schema.partial().optional(),
  });

export const blockOrSchema = <T extends z.ZodObject>(
  schema: T,
  usesSchema: z.ZodType<any> = defaultUsesSchema,
) => z.union([schema, blockItemWrapperSchema(schema, usesSchema)]);

export const commonMetadataSchema = z.object({
  tags: z.string().optional(),
  sourceCodeUrl: z.string().optional(),
  description: z.string().optional(),
  author: z.string().optional(),
  license: z.string().optional(),
  iconUrl: z.string().optional(),
});

const envRecord = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);

/** Reasoning effort a mode asks for; mapped to a thinking budget by the client. */
export const reasoningEffortSchema = z.enum(["off", "low", "medium", "high"]);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

/**
 * Which system prompt a use gets: `full` or `short` (the two built-in turn
 * texts; by default the model's id decides, short for small models), or the
 * name of a prompt block in `prompts:`, whose text replaces the turn text.
 */
export const promptChoiceSchema = z.string().min(1);

/**
 * The one-line reminder appended to every user message of a request
 * (`modeModels.<use>.tail`): `on` for the built-in line of the use's turn
 * kind, `off`, or a short text of your own. It rides on the user messages,
 * the same line each time, so that the system prompt stays cached and each
 * request extends the one before. Booleans are the same setting as written
 * by a YAML 1.1 parser.
 */
export const turnTailSchema = z.union([z.boolean(), z.string().min(1)]);
export type TurnTail = z.infer<typeof turnTailSchema>;

/**
 * Model (by its `name` in `models:`) to use in a chat mode, plus an optional
 * reasoning effort and system prompt for that mode.
 */
export const modeModelSchema = z
  .object({
    /** Default model when switching into the mode (by `name`). */
    model: z.string().optional(),
    /**
     * Models offered while in the mode (by `name`). When `model` is not set the
     * default is the first entry that exists. The default is always offered.
     */
    models: z.array(z.string()).optional(),
    reasoningEffort: reasoningEffortSchema.optional(),
    prompt: promptChoiceSchema.optional(),
    tail: turnTailSchema.optional(),
  })
  .refine(
    (m) =>
      m.model !== undefined ||
      (m.models?.length ?? 0) > 0 ||
      m.prompt !== undefined ||
      m.tail !== undefined,
    {
      message: "Set `model`, a non-empty `models` list, `prompt` or `tail`",
    },
  );
export type ModeModel = z.infer<typeof modeModelSchema>;

/**
 * Model (by its `name` in `models:`) for a use that has no picker of its own:
 * loop items, re-plans, the reviewer, subagents. One model, no list.
 */
export const useModelSchema = z.object({
  model: z.string().min(1),
  reasoningEffort: reasoningEffortSchema.optional(),
});
export type UseModel = z.infer<typeof useModelSchema>;

/**
 * A turn use (Loop items, re-plans): a model and, or, a system prompt and a
 * tail. The model may be left out when only the prompt or the tail differs
 * from the fallback.
 */
export const turnUseModelSchema = z
  .object({
    model: z.string().min(1).optional(),
    reasoningEffort: reasoningEffortSchema.optional(),
    prompt: promptChoiceSchema.optional(),
    tail: turnTailSchema.optional(),
  })
  .refine(
    (m) =>
      m.model !== undefined || m.prompt !== undefined || m.tail !== undefined,
    {
      message: "Set `model`, `prompt`, `tail`, or several of them",
    },
  );
export type TurnUseModel = z.infer<typeof turnUseModelSchema>;

/**
 * Which model does what. Modes without an entry keep the current model;
 * `loop` falls back to `agent`, `replan` to `plan`, `subagent` to the chat
 * model of the turn that started it, and `reviewer` to the model selected
 * for the reviewer role.
 */
export const modeModelsSchema = z.object({
  chat: modeModelSchema.optional(),
  agent: modeModelSchema.optional(),
  plan: modeModelSchema.optional(),
  /** Loop item turns. */
  loop: turnUseModelSchema.optional(),
  /** Loop re-plans, check-ins and repairs. */
  replan: turnUseModelSchema.optional(),
  /** The Auto reviewer. Any model, whatever its roles. */
  reviewer: useModelSchema.optional(),
  /** Subagents whose definition does not name a model. */
  subagent: useModelSchema.optional(),
});
export type ModeModels = z.infer<typeof modeModelsSchema>;

/**
 * Whether rules are sent in each chat mode. A mode left out is enabled, so
 * `rulesByMode: { chat: false }` turns rules off in Chat only.
 */
export const rulesByModeSchema = z.object({
  chat: z.boolean().optional(),
  agent: z.boolean().optional(),
  plan: z.boolean().optional(),
  /** Loop item turns; left out, they follow `agent`. */
  loop: z.boolean().optional(),
  /** Loop re-plans; left out, they follow `plan`. */
  replan: z.boolean().optional(),
});
export type RulesByMode = z.infer<typeof rulesByModeSchema>;

/**
 * Rules for tool calls, written `toolName(pattern)` or a bare `toolName`.
 * Deny always wins over ask, and ask over allow. `auto` only configures the
 * experimental reviewer (Auto mode) and never loosens a rule. See plans/tool-auto-approval.md.
 */
export const toolPermissionsSchema = z.object({
  allow: z.array(z.string()).optional(),
  ask: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
  auto: z
    .object({
      /** Facts the reviewer model is told about, to judge "unknown destination" and "production". */
      environment: z
        .object({
          trustedDomains: z.array(z.string()).optional(),
          productionMarkers: z.array(z.string()).optional(),
          /** Environment variable names that always ask or never ask in a command; only your own config.yaml is read for it. */
          envNames: z
            .object({
              ask: z.array(z.string()).optional(),
              allow: z.array(z.string()).optional(),
            })
            .optional(),
          /** Changed lines above which the built-in large-change check asks (default 300). Read from the personal config only. */
          largeChangeLines: z.number().int().min(1).optional(),
          /** Largest web page, in bytes, the fetch tool and @url read (default 2 MiB). Read from the personal config only. */
          fetchMaxBytes: z.number().int().min(1).optional(),
          /** Seconds a web fetch may take in all, including the body (default 20). Read from the personal config only. */
          fetchTimeoutSeconds: z.number().int().min(1).optional(),
          /** `ask`: after untrusted content enters a session, calls that send data out or change state outside the workspace ask (default `off`). Read from the personal config only. */
          taintedSessionRule: z.enum(["off", "ask"]).optional(),
        })
        .optional(),
      /** Plain-language guidance added to the reviewer's prompt. */
      guidance: z
        .object({
          block: z.array(z.string()).optional(),
          allow: z.array(z.string()).optional(),
        })
        .optional(),
      /** Which reviewer prompt Auto uses: `v3` is the tightened prompt (category check first, stricter authorisation); default is the shipped one. Read from the personal config only. */
      reviewerPrompt: z.enum(["default", "v3"]).optional(),
      /** Stop the agent and ask after this many refusals in a row, or in total. */
      limits: z
        .object({
          consecutiveDenials: z.number().int().min(1).optional(),
          totalDenials: z.number().int().min(1).optional(),
        })
        .optional(),
    })
    .optional(),
});
export type ToolPermissions = z.infer<typeof toolPermissionsSchema>;

/**
 * What a command the agent starts inherits from the host's environment.
 * `scrub` (default) removes names that look like secrets, `inherit` passes
 * everything, `allowlist` passes only the basics and `allow`.
 */
export const terminalSchema = z.object({
  environment: z.enum(["scrub", "inherit", "allowlist"]).optional(),
  /** Exact variable names that always pass through. */
  passEnv: z.array(z.string()).optional(),
  /** Extra names or patterns kept in `allowlist` mode. */
  allow: z.array(z.string()).optional(),
});
export type TerminalConfig = z.infer<typeof terminalSchema>;

export const baseConfigYamlSchema = z.object({
  name: z.string(),
  version: z.string(),
  schema: z.string().optional(),
  metadata: z
    .record(z.string(), z.string())
    .and(commonMetadataSchema.partial())
    .optional(),
  modeModels: modeModelsSchema.optional(),
  rulesByMode: rulesByModeSchema.optional(),
  toolPermissions: toolPermissionsSchema.optional(),
  terminal: terminalSchema.optional(),
  /**
   * Model information updates: OpenRouter's public model list (names, sizes,
   * prices). `automatic` (default) refreshes it in the background when the
   * copy is older than `modelCatalogRefreshHours`; `manual` only when asked
   * (provider setup offers it); `off` never contacts openrouter.ai. `ask` is
   * the old spelling of `manual`; `never` is `manual` without the offer.
   */
  modelCatalog: z
    .enum(["automatic", "manual", "off", "ask", "never"])
    .optional(),
  /** Hours before an automatic refresh replaces the list (default 24). */
  modelCatalogRefreshHours: z.number().positive().optional(),
  env: envRecord.optional(),
  requestOptions: requestOptionsSchema.optional(),
});

const modelsUsesSchema = z
  .string()
  .or(z.enum(commonModelSlugs as [string, ...string[]]));

export const configYamlSchema = baseConfigYamlSchema.extend({
  models: z
    .array(
      z.union([
        modelSchema,
        connectedModelSchema,
        catalogModelRefSchema,
        z.object({
          uses: modelsUsesSchema,
          with: z.record(z.string(), z.string()).optional(),
          override: partialModelSchema.optional(),
        }),
      ]),
    )
    .optional(),
  context: z.array(blockOrSchema(contextSchema)).optional(),
  data: z.array(blockOrSchema(dataSchema)).optional(),
  mcpServers: z
    .array(
      z.union([
        mcpServerSchema,
        z.object({
          uses: defaultUsesSchema,
          with: z.record(z.string(), z.string()).optional(),
          override: partialMcpServerSchema.optional(),
        }),
      ]),
    )
    .optional(),
  rules: z
    .array(
      z.union([
        ruleSchema,
        z.object({
          uses: defaultUsesSchema,
          with: z.record(z.string(), z.string()).optional(),
        }),
      ]),
    )
    .optional(),
  prompts: z.array(blockOrSchema(promptSchema)).optional(),
  docs: z.array(blockOrSchema(docSchema)).optional(),
});

export type ConfigYaml = z.infer<typeof configYamlSchema>;

export const assistantUnrolledSchema = baseConfigYamlSchema.extend({
  models: z.array(modelSchema.nullable()).optional(),
  context: z.array(contextSchema.nullable()).optional(),
  data: z.array(dataSchema.nullable()).optional(),
  mcpServers: z.array(mcpServerSchema.nullable()).optional(),
  rules: z.array(ruleSchema.nullable()).optional(),
  prompts: z.array(promptSchema.nullable()).optional(),
  docs: z.array(docSchema.nullable()).optional(),
});

export type AssistantUnrolled = z.infer<typeof assistantUnrolledSchema>;

export const assistantUnrolledSchemaNonNullable = baseConfigYamlSchema.extend({
  models: z.array(modelSchema).optional(),
  context: z.array(contextSchema).optional(),
  data: z.array(dataSchema).optional(),
  mcpServers: z.array(mcpServerSchema).optional(),
  rules: z.array(ruleSchema).optional(),
  prompts: z.array(promptSchema).optional(),
  docs: z.array(docSchema).optional(),
});

export type AssistantUnrolledNonNullable = z.infer<
  typeof assistantUnrolledSchemaNonNullable
>;

export const isAssistantUnrolledNonNullable = (
  a: AssistantUnrolled,
): a is AssistantUnrolledNonNullable =>
  (!a.models || a.models.every((m) => m !== null)) &&
  (!a.context || a.context.every((c) => c !== null)) &&
  (!a.data || a.data.every((d) => d !== null)) &&
  (!a.mcpServers || a.mcpServers.every((s) => s !== null)) &&
  (!a.rules || a.rules.every((r) => r !== null)) &&
  (!a.prompts || a.prompts.every((p) => p !== null)) &&
  (!a.docs || a.docs.every((d) => d !== null));

export const blockSchema = baseConfigYamlSchema.and(
  z.union([
    z.object({
      models: z.array(z.union([modelSchema, connectedModelSchema])).length(1),
    }),
    z.object({ context: z.array(contextSchema).length(1) }),
    z.object({ data: z.array(dataSchema).length(1) }),
    z.object({ mcpServers: z.array(mcpServerSchema).length(1) }),
    z.object({
      rules: z.array(ruleSchema).length(1),
    }),
    z.object({ prompts: z.array(promptSchema).length(1) }),
    z.object({ docs: z.array(docSchema).length(1) }),
  ]),
);

export type Block = z.infer<typeof blockSchema>;

export const continueCommandSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  prompt: z.string(),
  placeholders: z.array(z.string()).optional(),
  context: z.string().optional(),
  contextWindowSize: z.number().optional(),
  model: z.string().optional(),
  systemMessage: z.string().optional(),
  slashCommand: z.string().optional(),
  hideFromCommandPalette: z.boolean().optional(),
  hideFromSlashCommands: z.boolean().optional(),
  mode: z.enum(["insert", "replace", "diff"]).optional(),
  addEnhancedContext: z.boolean().optional(),
});

export const languageMarkerSchema = z.object({
  language: z.string(),
  markers: z.array(z.string()),
});

export const sidebarSchema = z.object({
  enabled: z.boolean().optional(),
  defaultOpen: z.boolean().optional(),
  defaultWidth: z.number().optional(),
  showButtonsThreshold: z.number().optional(),
});

const toolSchema = z.object({
  name: z.string(),
  description: z.string(),
  defaultIcon: z.string().optional(),
});

export const autoindentExtensionsSchema = z.array(z.string());

export const configSchema = z.object({
  models: z.array(modelSchema).optional(),
  defaultModel: z.string().optional(),
  defaultRecentMessages: z.number().optional(),
  commands: z.array(continueCommandSchema).optional(),
  tools: z.array(toolSchema).optional(),
  contextProviders: z.array(z.any()).optional(),
  langMarkers: z.array(languageMarkerSchema).optional(),
  sidebar: sidebarSchema.optional(),
  tabAutocompleteModel: z.string().optional(),
  rules: z.array(ruleObjectSchema).optional(),
  doneWithBannerForever: z.boolean().optional(),
  autoindentExtensions: autoindentExtensionsSchema.optional(),
  proxy: z.string().optional(),
  api_base: z.string().optional(),
  api_key: z.string().optional(),
  env: envRecord.optional(),
  requestOptions: requestOptionsSchema.optional(),
});

export type Config = z.infer<typeof configSchema>;
