import {
  DataDestination,
  ModelRole,
  PromptTemplates,
  ToolDialectSetting,
  ToolOverrideConfig,
  ToolPermissions,
} from "@continuedev/config-yaml";
import { ToolPolicy } from "@continuedev/terminal-security";
import { McpUiResourceMeta } from "@modelcontextprotocol/ext-apps";
import { TextResourceContents } from "@modelcontextprotocol/sdk/types.js";
import Parser from "web-tree-sitter";
import { CodebaseIndexer } from "./indexing/CodebaseIndexer";
import { LLMConfigurationStatuses } from "./llm/constants";
import type { PriceSource } from "./llm/utils/calculateRequestCost";
import type {
  SubagentRunStatus,
  SubagentToolCallSummary,
} from "./subagents/result";

declare global {
  interface Window {
    ide?: "vscode";
    windowId: string;
    serverUrl: string;
    vscMachineId: string;
    vscMediaUrl: string;
    fullColorTheme?: {
      rules?: {
        token?: string;
        foreground?: string;
      }[];
    };
    colorThemeName?: string;
    workspacePaths?: string[];
    postIntellijMessage?: (
      messageType: string,
      data: any,
      messageIde: string,
    ) => void;
  }
}

export interface ChunkWithoutID {
  content: string;
  startLine: number;
  endLine: number;
  signature?: string;
  otherMetadata?: { [key: string]: any };
}

export interface Chunk extends ChunkWithoutID {
  digest: string;
  filepath: string;
  index: number; // Index of the chunk in the document at filepath
}

export interface IndexingProgressUpdate {
  progress: number;
  desc: string;
  shouldClearIndexes?: boolean;
  status:
    | "loading"
    | "waiting"
    | "indexing"
    | "done"
    | "failed"
    | "paused"
    | "disabled"
    | "cancelled";
  debugInfo?: string;
  warnings?: string[];
}

// This is more or less a V2 of IndexingProgressUpdate for docs etc.
export interface IndexingStatus {
  id: string;
  type: "docs";
  progress: number;
  description: string;
  status: "indexing" | "complete" | "paused" | "failed" | "aborted" | "pending";
  embeddingsProviderId?: string;
  isReindexing?: boolean;
  debugInfo?: string;
  title: string;
  icon?: string;
  url?: string;
}

export type PromptTemplateFunction = (
  history: ChatMessage[],
  otherData: Record<string, string>,
) => string | ChatMessage[];

export type PromptTemplate = string | PromptTemplateFunction;

type RequiredLLMOptions =
  | "uniqueId"
  | "contextLength"
  | "embeddingId"
  | "maxEmbeddingChunkSize"
  | "maxEmbeddingBatchSize"
  | "completionOptions";

export interface ILLM
  extends
    Omit<LLMOptions, RequiredLLMOptions>,
    Required<Pick<LLMOptions, RequiredLLMOptions>> {
  get providerName(): string;
  get underlyingProviderName(): string;

  /**
   * The accounts this model is served through, in the order they are tried,
   * when it has routes (models.yaml). The first is the model's own.
   */
  readonly routeNames?: string[];

  autocompleteOptions?: Partial<TabAutocompleteOptions>;

  /**
   * Autocomplete defaults that suit this provider, applied below the user's
   * `tabAutocompleteOptions` and the model's own `autocompleteOptions`, so
   * either can still override them.
   */
  providerAutocompleteDefaults?: Partial<TabAutocompleteOptions>;

  lastRequestId?: string;

  complete(
    prompt: string,
    signal: AbortSignal,
    options?: LLMFullCompletionOptions,
  ): Promise<string>;

  streamComplete(
    prompt: string,
    signal: AbortSignal,
    options?: LLMFullCompletionOptions,
  ): AsyncGenerator<string, PromptLog>;

  streamFim(
    prefix: string,
    suffix: string,
    signal: AbortSignal,
    options?: LLMFullCompletionOptions,
  ): AsyncGenerator<string, PromptLog>;

  streamChat(
    messages: ChatMessage[],
    signal: AbortSignal,
    options?: LLMFullCompletionOptions,
    messageOptions?: MessageOption,
  ): AsyncGenerator<ChatMessage, PromptLog>;

  chat(
    messages: ChatMessage[],
    signal: AbortSignal,
    options?: LLMFullCompletionOptions,
  ): Promise<ChatMessage>;

  compileChatMessages(
    messages: ChatMessage[],
    options: LLMFullCompletionOpeions,
  ): CompiledChatMessagesReport;

  embed(chunks: string[]): Promise<number[][]>;

  rerank(query: string, chunks: Chunk[]): Promise<number[]>;

  countTokens(text: string): number;

  supportsImages(): boolean;

  supportsCompletions(): boolean;

  supportsPrefill(): boolean;

  supportsFim(): boolean;

  listModels(): Promise<string[]>;

  renderPromptTemplate(
    template: PromptTemplate,
    history: ChatMessage[],
    otherData: Record<string, string>,
    canPutWordsInModelsMouth?: boolean,
  ): string | ChatMessage[];

  getConfigurationStatus(): LLMConfigurationStatuses;
}

export interface ModelInstaller {
  installModel(
    modelName: string,
    signal: AbortSignal,
    progressReporter?: (task: string, increment: number, total: number) => void,
  ): Promise<any>;

  isInstallingModel(modelName: string): Promise<boolean>;
}

export type ContextProviderType = "normal" | "query" | "submenu";
export type ContextIndexingType =
  "chunk" | "embeddings" | "fullTextSearch" | "codeSnippets";

export interface ContextProviderDescription {
  title: ContextProviderName;
  displayTitle: string;
  description: string;
  renderInlineAs?: string;
  type: ContextProviderType;
  dependsOnIndexing?: ContextIndexingType[];
}

export type FetchFunction = (url: string | URL, init?: any) => Promise<any>;

export interface ContextProviderExtras {
  config: ContinueConfig;
  fullInput: string;
  embeddingsProvider: ILLM | null;
  reranker: ILLM | null;
  llm: ILLM;
  ide: IDE;
  selectedCode: RangeInFile[];
  fetch: FetchFunction;
  isInAgentMode: boolean;
}

export interface LoadSubmenuItemsArgs {
  config: ContinueConfig;
  ide: IDE;
  fetch: FetchFunction;
}

export interface CustomContextProvider {
  title: string;
  displayTitle?: string;
  description?: string;
  renderInlineAs?: string;
  type?: ContextProviderType;
  loadSubmenuItems?: (
    args: LoadSubmenuItemsArgs,
  ) => Promise<ContextSubmenuItem[]>;

  getContextItems(
    query: string,
    extras: ContextProviderExtras,
  ): Promise<ContextItem[]>;
}

export interface ContextSubmenuItem {
  id: string;
  title: string;
  description: string;
  icon?: string;
  metadata?: any;
}

export interface ContextSubmenuItemWithProvider extends ContextSubmenuItem {
  providerTitle: string;
}

export interface SiteIndexingConfig {
  title: string;
  startUrl: string;
  maxDepth?: number;
  faviconUrl?: string;
  useLocalCrawling?: boolean;
  sourceFile?: string;
}

export interface DocsIndexingDetails {
  startUrl: string;
  config: SiteIndexingConfig;
  indexingStatus: IndexingStatus | undefined;
  chunks: Chunk[];
}

export interface IContextProvider {
  get description(): ContextProviderDescription;

  getContextItems(
    query: string,
    extras: ContextProviderExtras,
  ): Promise<ContextItem[]>;

  loadSubmenuItems(args: LoadSubmenuItemsArgs): Promise<ContextSubmenuItem[]>;

  get deprecationMessage(): string | null;
}

/** Token and cost totals for one model within a session. */
export interface ModelUsage {
  provider: string;
  model: string;
  /** Requests that reported usage. */
  requests: number;
  /** Input tokens that were neither read from nor written to the cache. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Estimated cost in USD of the requests that could be priced. */
  cost: number;
  /** How many of `requests` could be priced. Fewer than `requests` means `cost` is partial. */
  pricedRequests: number;
  /**
   * Set when some of `cost` came from a downloaded price list: where it came
   * from and the date of the oldest list used. The figure is an estimate.
   */
  priceEstimate?: { source: string; fetchedAt: string };
  /**
   * Where the latest priced request's prices came from and as of when, for
   * the "price source and date" line next to the cost.
   */
  priceSource?: PriceSource;
  /**
   * The latest non-standard service tier a provider reported serving
   * (`flex`, `priority`, ...). The cost is then the standard-tier price.
   */
  servedTier?: string;
}

export interface SessionUsage extends Usage {
  /**
   * Total estimated cost in USD of the requests that could be priced. Requests
   * to models without a known price add nothing (see `ModelUsage.pricedRequests`).
   */
  totalCost: number;
  /**
   * True when part of `totalCost` was priced at a fallback rate because the
   * model has no entry in the price tables, so the figure is an estimate and
   * is shown as one.
   */
  costEstimated?: boolean;
  /** Totals per model, keyed `provider/model`. */
  byModel?: Record<string, ModelUsage>;
  /** The latest request, for the context-window display. */
  lastRequest?: {
    provider: string;
    model: string;
    /** All input tokens of that request as the API counted them. */
    inputTokens: number;
    outputTokens: number;
  };
}

/** What the prompt cache held when a session was last used. */
export interface SessionPromptCache {
  /** When the last request started (ms since epoch). */
  lastRequestAt?: number;
  /** Input tokens of that request, as the API counted them. */
  lastInputTokens?: number;
  /** Lifetime that request wrote its cache entry with. */
  lastTtl?: "5m" | "1h";
  /** Requests the conversation has sent with caching on (Auto counts them). */
  requests?: number;
  /** Auto moved the conversation to the 1-hour lifetime. */
  escalated?: boolean;
  escalatedBy?: "gap" | "requests";
}

/**
 * What the webview sends instead of the whole session (`history/saveDelta`,
 * STOR6): the history items and session fields changed since its last save.
 */
export interface SessionDelta {
  sessionId: string;
  /** The revision the webview's last save was answered with. */
  baseRev: string;
  /** The history's length now; shorter than before means items were cut. */
  length: number;
  /** New or changed items. Every index from the old length on must be here. */
  items: { index: number; item: ChatHistoryItem }[];
  /** Changed session fields; title and workspace are always sent. */
  meta: Partial<Omit<Session, "history" | "sessionId">>;
  /** Session fields that were removed. */
  unset?: string[];
}

/**
 * A save's answer. `rev` is what the next delta is sent against; null when
 * deltas cannot be used (the session log is off). `needFull` asks for the
 * whole session (`history/save`).
 */
export type SessionSaveResult =
  { rev: string | null; needFull?: false } | { rev: null; needFull: true };

export interface Session {
  sessionId: string;
  title: string;
  workspaceDirectory: string;
  history: ChatHistoryItem[];
  /** Optional: per-session UI mode (chat/agent/plan/background) */
  mode?: MessageModes;
  /** Optional: title of the selected chat model for this session */
  chatModelTitle?: string | null;
  /** Optional: cumulative usage and cost for all LLM API calls in this session */
  usage?: SessionUsage;
  /**
   * Optional: lets a resumed session tell that its prompt cache has expired
   * and what re-reading the conversation will cost.
   */
  promptCache?: SessionPromptCache;
  /** Optional: file snapshots taken before agent edits, used by "Restore to here" */
  checkpoints?: TurnCheckpoint[];
  /**
   * Optional: the agent's task list. Kept outside the history so compaction and
   * pruning cannot lose it; sent at the tail of each request. See
   * core/util/taskPlan.ts.
   */
  taskPlan?: TaskPlan;
  /**
   * Optional: URI of the plan file this session is working from
   * (`.continuous/plans/<slug>.md`), written by the plan tool in Plan mode. See
   * core/util/planFile.ts.
   */
  planFile?: string;
  /**
   * Optional: messages typed while the agent was working and not yet sent.
   * Saved as soon as they change, so a reload or crash does not lose them.
   */
  queuedMessages?: SessionQueuedMessage[];
  /**
   * Optional: Loop mode's state, when the session builds a plan in a loop:
   * each item's run status, the questions held for the person and their
   * answers. See core/util/loopMode.ts.
   */
  loop?: LoopState;
  /**
   * Optional: the person chose Loop in the mode picker. Not a mode: the turns
   * stay Plan and Agent; a plan presented while it is set starts the loop.
   */
  loopRequested?: boolean;
  /**
   * Optional: the session this one was forked from, and the last history item
   * the fork kept (absent when it kept all of them). See core/util/forkSession.ts.
   */
  forkedFrom?: { sessionId: string; index?: number };
}

/** Where one plan item is in Loop mode. The task list shows it too. */
/**
 * checking: the item reported done and has a check (TaskItem.check) that
 * has not passed yet; the loop runs it next (decideNext's "check" action).
 */
export type LoopItemStatus =
  "pending" | "running" | "checking" | "done" | "waiting" | "redo" | "failed";

/**
 * One item of a parallel wave (L4): a run with a fresh context in its own
 * worktree, beside the other items of the wave and apart from `current`.
 */
export interface LoopParallelRun {
  itemId: string;
  /** The worktree the run works in, once the harness has made it */
  worktree?: string;
  startedAt: string;
}

/** The model a run of an item that names one (TaskItem.model) went to. */
export interface LoopItemModel {
  /** The title of the chat model the run went to */
  title: string;
  /** Set when the item's model is not configured and the loop model ran instead */
  fallbackReason?: string;
}

/** The last time an item's check (TaskItem.check) ran, or why it did not. */
export interface LoopCheckResult {
  /**
   * passed: exit 0. failed: another exit code (the item runs again).
   * refused: a rule refused the command, or the person did not allow it, or
   * a headless run could not ask. The check did not run, so the item is not
   * done.
   */
  status: "passed" | "failed" | "refused";
  command: string;
  exitCode?: number | null;
  /** The tail of what it printed, at most LOOP_LIMITS.maxCheckOutput */
  output?: string;
  at: string;
}

export interface LoopItemState {
  /** The task list item's id */
  id: string;
  status: LoopItemStatus;
  /** Runs started for this item, reset when an answer requeues it */
  attempts: number;
  /** Times a run set this item aside (finish_item outcome "later") */
  deferrals?: number;
  /** Set aside and not run since: it goes behind the other runnable items */
  setAside?: boolean;
  /** What the run said it did (finish_item), or why it stopped */
  summary?: string;
  /** Why a stuck run could not finish it, as the run reported (finish_item) */
  blocker?: LoopBlocker;
  /** Blocker dependency: what must be done before this item */
  needs?: string[];
  /**
   * Unattended: questions that got no answer in time, so the item went on
   * with its best default. The questions stay open in the inbox.
   */
  unanswered?: string[];
  /**
   * The person skipped the item (skipItem). Its status is done, so the loop
   * goes past it, but the task list shows it cancelled and it does not count
   * toward doneThisRound. Its open questions stay open. Cleared by
   * runItemAgain.
   */
  skipped?: boolean;
  /**
   * The person asked for the item to run again (runItemAgain): its next
   * run's prompt says so, and to check what is already done first. Cleared
   * when that run ends.
   */
  again?: boolean;
  /** The last run of the item's check (TaskItem.check) */
  check?: LoopCheckResult;
  /**
   * What the item's runs have used, all of them: tokens (output and input
   * the provider did not cache, as the loop's budget counts) and wall time
   */
  usage?: {
    tokens: number;
    ms: number;
    /**
     * USD over the runs that were measured (core/util/loopCost.ts), or
     * "unknown" when a run's model has no price. Missing: no run measured.
     */
    cost?: number | "unknown";
  };
  /**
   * The item's last run ended over its own budget (TaskItem.budget): which
   * limit, and the figures. Its status is failed, but it does not count
   * toward the loop's consecutive failures, and its work is kept. Cleared
   * when the item runs again.
   */
  overBudget?: {
    which: "turns" | "tokens" | "minutes" | "usd";
    used: number;
    limit: number;
  };
  /** Times the item's budget was extended from the reserve (core/util/itemBudgetPolicy.ts) */
  extensions?: number;
  /**
   * The model the item's last run went to, when the item names one
   * (TaskItem.model): its title, and why the item's own model was not used.
   */
  model?: LoopItemModel;
  /**
   * Its last parallel run's changes could not be merged: it runs inline on
   * the merged tree next, never in another wave. Cleared when that run ends.
   */
  runInline?: boolean;
  /** Why that merge failed, for its next prompt */
  mergeFailed?: string;
  /**
   * Fix forward: re-plans scoped to this item after it failed (at most
   * LOOP_MAX_REPAIRS_PER_ITEM). To-dos a repair splits it into inherit it.
   */
  repairs?: number;
  /**
   * The round whose accepted re-plan added this to-do, for the R chip in the
   * plan tree. Missing on the to-dos the loop started with and on loops saved
   * before this field: they show no chip.
   */
  addedInRound?: number;
}

/** A to-do an accepted re-plan took out of the plan (LoopState.replacedItems) */
export interface LoopReplacedItem {
  /** The id the to-do had */
  id: string;
  /** Its text, when the loop could tell which plan text it had */
  text?: string;
  /** The round of the re-plan that took it out */
  round: number;
  /** The to-do that took its place; only for a repair that left exactly one */
  replacedBy?: string;
}

/**
 * - blocking: the item cannot go on without the answer; it waits.
 * - assumption: the item goes on with `assumption`; the person may overrule it.
 * - approval: a tool call that would have asked; held instead of stalling the loop.
 */
export type LoopQuestionKind = "blocking" | "assumption" | "approval";

/**
 * What a wrong answer to a question would cost, as the agent labels it
 * (plans/policy-areas.md, "Questions are about who decides"). Recorded with
 * the question; the Questions level will route on it, with checks. The list
 * is QUESTION_TYPES in core/util/loopMode.ts.
 */
export type QuestionType =
  | "access"
  | "irreversible"
  | "security"
  | "cost"
  | "scope"
  | "design"
  | "detail";

/**
 * Something the loop decided for the person under the policy they set (a
 * re-plan it accepted, a question it answered). Always by `system`; `source`
 * names the setting ("Plan edits: IDGAF", "Questions: Permissive").
 */
export interface LoopAutoDecision {
  kind: "plan" | "question";
  by: "system";
  source: string;
  text: string;
  at: string;
}

export interface LoopQuestion {
  /** IDGAF: the agent decided this itself; it never reached the inbox */
  decidedAlone?: boolean;
  /** Questions is permissive: the answer the system chose, and under which setting */
  autoAnswer?: { text: string; by: "system"; source: string };
  id: string;
  /** The item it is about; none for a question about the whole plan */
  itemId?: string;
  question: string;
  kind: LoopQuestionKind;
  /** The agent's label for what a wrong answer would cost */
  type?: QuestionType;
  /** The default the item continued with (kind assumption) */
  assumption?: string;
  /** Two to four choices the agent offered, its default first */
  options?: string[];
  /** The held tool call (kind approval) */
  approval?: { toolName: string; summary: string; grantKey: string };
  /** The item ran out of its own budget (limit policy Suggest): which limit, and the figures */
  overBudget?: {
    which: "turns" | "tokens" | "minutes" | "usd";
    used: number;
    limit: number;
  };
  askedAt: string;
  /** Set once answered */
  answerId?: string;
}

/** How an answer was routed, from the item's state when it was given. */
export type LoopAnswerRoute =
  | "requeue" // the item was waiting: it runs again with the answer
  | "next-run" // the item had not run yet: the answer goes with its run
  | "steer" // the item was running: steered in at its next tool boundary
  | "redo" // the item was done on an overruled assumption: it runs again
  | "confirmed" // the assumption stands: nothing to do
  | "replan" // about the plan as a whole: read at the next re-plan
  | "standing"; // an instruction for every item from now on (a "sign")

export interface LoopAnswer {
  id: string;
  questionId?: string;
  itemId?: string;
  text: string;
  /** For a plan-wide answer: re-plan as soon as the running item ends */
  replanNow?: boolean;
  /** For an approval question: the person allowed the call */
  approve?: boolean;
  route: LoopAnswerRoute;
  givenAt: string;
  /** Sent to the model (in a run's prompt, by steering or in a re-plan) */
  delivered?: boolean;
}

export type LoopStatus =
  | "running"
  /** A read-only Plan-mode turn is proposing the next round's plan */
  | "replanning"
  /** The re-plan's card is waiting for the person to accept it */
  | "awaiting_plan"
  /** Every open item waits on the person; an answer resumes the loop */
  | "waiting"
  | "stopped";

export type LoopStopReason =
  | "done"
  | "rounds"
  | "tokens"
  | "time"
  | "no_progress"
  | "failures"
  | "error"
  | "stopped"
  /** The person switched to Chat, Plan or Agent: a pause, resumable */
  | "left_loop"
  | "replan_failed";

/**
 * The loop's limits. The person can change most of them while the loop runs,
 * within LOOP_BUDGET_BOUNDS (setLoopBudget in core/util/loopMode.ts);
 * changing the autonomy level resets them to the level's.
 */
export interface LoopBudget {
  /**
   * Rounds before the loop stops: the first pass over the plan is round 1,
   * so 1 means never re-plan and N + 1 allows N re-plans
   */
  maxRounds: number;
  /** Prompt plus completion tokens the loop may use (0: no limit) */
  maxTokens: number;
  /** Wall time in milliseconds (0: no limit) */
  maxWallMs: number;
  /** Runs of one item without finishing before it is marked failed */
  maxAttempts: number;
  /** Rounds in a row that finish no item before the loop stops */
  maxNoProgressRounds: number;
  /** Items in a row that fail before the loop stops */
  maxConsecutiveFailures: number;
  /** Model requests one run of an item may make before it must report */
  maxItemTurns: number;
}

/**
 * How much the loop does without the person. It follows the approval mode
 * the person picked when the loop starts (Manual: supervised; Auto-approve
 * and Auto: auto; IDGAF: unattended) and can be changed while it runs. See
 * LOOP_AUTONOMY in core/util/loopMode.ts.
 */
export type LoopAutonomy = "supervised" | "auto" | "unattended" | "idgaf";

/**
 * Why an item is stuck, as the run reports it (finish_item `blocker`), so the
 * re-plan starts from the cause and not from a sentence:
 * - answer: it needs something only the person can say or supply;
 * - observe: it cannot see what it needs (a result, a log, a running system);
 * - plan: the item is wrong: too big, too vague, or not what the goal needs;
 * - environment: a tool, credential, network or the machine is in the way;
 * - dependency: other work must be done first (`needs` names it).
 */
export type LoopBlocker =
  "answer" | "observe" | "plan" | "environment" | "dependency";

/**
 * The two policy areas a loop reads while it runs (plans/policy-areas.md):
 * what happens to a plan or re-plan (Plan edits) and who answers a question
 * (Questions). A loop started from the IDE or the CLI carries the levels the
 * person chose and follows them when they change. A loop saved before
 * policy areas has none and keeps using its autonomy level.
 */
export interface LoopPolicy {
  plan: import("./tools/permissions/policy").PolicyLevel;
  questions: import("./tools/permissions/policy").PolicyLevel;
  /** Permissive on Plan edits: new to-dos a re-plan may add by itself */
  maxNewPlanItems?: number;
  /** Question types the person always decides */
  youDecide?: import("./tools/permissions/policy").QuestionType[];
  /** Question types the agent may decide */
  agentDecides?: import("./tools/permissions/policy").QuestionType[];
}

/**
 * How the loop moves through the plan, next to the autonomy level (how much
 * it does without the person). See LOOP_STRATEGIES in core/util/loopMode.ts.
 * - finish: plan order; re-plan only when nothing can run;
 * - check-in: also re-plan every few finished items, and at once when an
 *   assumption is overruled or an item fails;
 * - fix-forward: a failed item gets a re-plan of just that item.
 */
export type LoopStrategy = "finish" | "check-in" | "fix-forward";

export type LoopReminderWhen = "item" | "next_items" | "retry" | "replan";

/** A file a reminder refers to, and its content when the reminder was saved. */
export interface LoopReminderFile {
  path: string;
  /** core/util/loopReminders.ts reminderFileStamp */
  stamp: string;
}

/** What a run saved for one later run (remind_me). */
export interface LoopReminder {
  id: string;
  note: string;
  when: LoopReminderWhen;
  /** The item saving it */
  fromItemId: string;
  /** The item it is for, with when "item" */
  itemId?: string;
  files?: LoopReminderFile[];
  savedAt: string;
  /** Set when a run's opening prompt carried it; it is delivered once */
  deliveredAt?: string;
}

/**
 * A snapshot of the session's usage by model and kind (from
 * `SessionUsage.byModel`), taken when a loop or a run starts; the difference
 * to a later snapshot is what the loop used (core/util/loopCost.ts).
 */
export type LoopCostMark = Record<
  string,
  {
    provider: string;
    model: string;
    requests: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  }
>;

export interface LoopState {
  status: LoopStatus;
  /** 1 for the plan the loop started with, +1 at each accepted re-plan */
  round: number;
  startedAt: string;
  /** Session tokens when the loop started, so the budget counts only its own */
  tokensAtStart: number;
  /** The session's per-model totals when the loop started, to price its own use */
  costAtStart?: LoopCostMark;
  budget: LoopBudget;
  /** Missing on loops saved before autonomy levels: treated as "auto" */
  autonomy?: LoopAutonomy;
  /** The Plan edits and Questions levels in force; see LoopPolicy */
  policy?: LoopPolicy;
  /**
   * What happens when an item runs out of its own budget: ask, stop, or have
   * it reviewed. Missing: the autonomy level's default (defaultLimitPolicy)
   */
  limitPolicy?: "suggest" | "force" | "review";
  /**
   * What is left of the part of the loop's budget held back for extensions
   * (core/util/loopBudgetSplit.ts); an extension draws it down
   */
  reserve?: { tokens?: number; minutes?: number };
  /**
   * A command the harness runs after an item reports done when the item has
   * no `check:` of its own (the project's test or build command). Exit 0
   * confirms it, as for a check of its own. Missing: such an item is done on
   * its own report.
   */
  fallbackCheck?: string;
  /** The plan's title, to name the loop in its panel */
  title?: string;
  /** Missing on loops saved before strategies: treated as "finish" */
  strategy?: LoopStrategy;
  /**
   * The person picked the strategy; otherwise changing the level changes it
   * to the new level's default.
   */
  strategyPicked?: boolean;
  items: LoopItemState[];
  /**
   * What is running: one item, the re-plan turn, or an item's check (a
   * command the harness runs, not a model turn)
   */
  current?: {
    kind: "item" | "replan" | "check";
    /** The item that runs; for a repair re-plan, the failed item it is about */
    itemId?: string;
    /** History length when it started; its messages come after */
    historyIndex: number;
    startedAt: string;
    /** Session tokens when an item's run started, to count the run's own */
    tokensAtStart?: number;
    /** The session's per-model totals when an item's run started */
    costAtStart?: LoopCostMark;
    /**
     * The run went over the item's own budget (itemBudgetStatus): the host
     * sets this with the report that ends it, and finishItemRun records it
     */
    overBudget?: {
      which: "turns" | "tokens" | "minutes" | "usd";
      used: number;
      limit: number;
    };
    /** What finish_item reported during this run */
    report?: {
      outcome: "done" | "stuck" | "waiting" | "later";
      summary?: string;
      /** Outcome stuck: what is in the way (finish_item blocker) */
      blocker?: LoopBlocker;
      /** Blocker dependency: the work that must come first */
      needs?: string[];
      /** What a later item should know (finish_item notes) */
      notes?: string;
    };
    /** A re-plan: the to-dos it started from, to tell whether it adds scope */
    planTexts?: string[];
    /**
     * A re-plan: the check of each to-do it started from, by item id, so a
     * re-plan that changes the check of an item that ended stuck (its check
     * never ran) is held like one that changes a failed check
     */
    planChecks?: Record<string, string>;
    /** A check-in re-plan (check-in strategy): why it was due */
    checkIn?: string;
    /** A repair re-plan (fix forward): the failed item's text */
    itemText?: string;
    /**
     * The run ended once without its report (finish_item, or a re-plan's
     * present_plan) and was told to call it; a second such end counts
     * (core/util/turnEnd.ts)
     */
    nudged?: boolean;
    /** Item budgets the run was already told it passed 80% of (core/util/itemBudget.ts) */
    budgetWarned?: Array<"turns" | "tokens" | "minutes" | "usd">;
  };
  /**
   * The re-plan whose plan waits to be accepted: what it was for, so
   * acceptReplan can tell a check-in or a repair from a round's re-plan.
   * For a repair (fix forward), itemId is the failed item.
   */
  replanned?: {
    planTexts: string[];
    checkIn?: string;
    itemId?: string;
    itemText?: string;
  };
  /** Check in: items done since the start or the last accepted re-plan */
  doneSinceReplan?: number;
  /** Check in: an event (a redo, a failed item) asks for a check-in now */
  checkInDue?: string;
  /** Fix forward: the failed item waiting for its scoped re-plan */
  repairItemId?: string;
  /**
   * The chat model an item's own model (TaskItem.model) switched away from
   * when `modeModels` names none for the loop: the next turn without an own
   * model, and the loop's end, come back to it, so the other items run on
   * the model the person had selected.
   */
  modelBefore?: string;
  /**
   * The items of the wave that runs now, each in its own worktree (L4),
   * beside `current`, which stays the inline run, the re-plan or the check.
   * Nothing else starts while a wave runs; its items finish one at a time
   * (finishParallelRun). Absent or empty when no wave runs.
   */
  parallel?: LoopParallelRun[];
  /**
   * The person turned parallel waves on: items with disjoint `files` run at
   * the same time at the levels that do not ask (auto and above). Off by
   * default.
   */
  parallelOn?: boolean;
  questions: LoopQuestion[];
  answers: LoopAnswer[];
  /** Items finished in this round, for the no-progress check */
  doneThisRound: number;
  noProgressRounds: number;
  /** Items in a row that ended failed; reset by one that is done */
  consecutiveFailures?: number;
  /**
   * When the loop started waiting on the person: every open item waits
   * (status waiting) or a re-plan's card does (status awaiting_plan)
   */
  waitingSince?: string;
  /**
   * Milliseconds the loop spent waiting on the person since `startedAt`,
   * without the wait in progress. The time budget does not count them
   * (loopElapsedMs). Absent in loops saved before it existed: 0.
   */
  waitedMs?: number;
  /** Why the last re-plan did or did not start the next round by itself */
  replanReason?: string;
  /**
   * To-dos accepted re-plans took out of the plan, oldest first, the last 20.
   * Missing on loops saved before this field: the plan tree shows none.
   */
  replacedItems?: LoopReplacedItem[];
  /** What the loop decided for the person by their policy, oldest first (capped) */
  autoDecisions?: LoopAutoDecision[];
  /** Tool calls the person allowed from an approval question (grantKey) */
  grants: string[];
  /** A plan-wide answer asked to re-plan now */
  replanRequested?: boolean;
  /**
   * Each item and re-plan is sent without the turns before it: the plan
   * file, the notes and the answers carry what it needs. On unless false.
   */
  freshContext?: boolean;
  /**
   * What runs learned that later items should know (finish_item notes),
   * newest last, capped; sent with every item prompt.
   */
  notes?: string[];
  /** What runs saved for later runs with remind_me; they end with the loop */
  reminders?: LoopReminder[];
  /** The person asked to stop once the running item or re-plan ends */
  stopRequested?: boolean;
  /** The stop asked for is a pause: the person left Loop (pauseLoop) */
  leaveRequested?: boolean;
  /**
   * The person worked outside the loop while it was paused: the next item's
   * prompt says so once (resumeLoop with workedOutside)
   */
  workedOutside?: boolean;
  stopReason?: LoopStopReason;
  /** One line for the person: what stopped it */
  stopDetail?: string;
  /** Set beside stopDetail when a budget stopped the loop: which, and how much */
  stopBudget?: LoopStopBudget;
}

/** Which loop budget stopped it. Tokens are counted, time is milliseconds. */
export interface LoopStopBudget {
  kind: "tokens" | "time";
  used: number;
  max: number;
}

/** A message queued in the chat input; `editorState` is the editor's JSON. */
export interface SessionQueuedMessage {
  id: string;
  editorState: any;
  modifiers: InputModifiers;
}

export type TaskStatus =
  "pending" | "in_progress" | "completed" | "cancelled" | "blocked";

export interface TaskItem {
  /** Stable across updates, so a person's edit and a model update meet */
  id: string;
  text: string;
  status: TaskStatus;
  /** Why the item is blocked or cancelled */
  note?: string;
  /** Present-tense label shown while the item is in progress ("Running migrations") */
  activeForm?: string;
  /**
   * Ids of the items this one comes after: Loop mode does not run it before
   * they are done. The plan file writes them as `after: 1, 2` (positions)
   * under the to-do.
   */
  after?: string[];
  /**
   * A shell command that confirms the item is done (exit 0). Loop mode runs
   * it after the item reports done, under the same rules as any terminal
   * command. The plan file writes it as `check: <command>` under the to-do.
   */
  check?: string;
  /**
   * The `name` of the chat model this item's Loop run goes to instead of
   * `modeModels.loop`; the prompt and reasoning effort still come from the
   * loop entry. The plan file writes it as `model: <name>` under the to-do.
   * A name that is not configured falls back to the loop model, with the
   * reason on the item's run (LoopItemState.model).
   */
  model?: string;
  /**
   * The files the item changes, as paths or globs relative to the workspace.
   * The plan file writes them as `files: src/a.ts, src/b/**` under the to-do.
   * Loop mode runs items whose files do not overlap at the same time when
   * parallel waves are on (LoopState.parallelOn); an item without them runs
   * inline, one at a time, as before.
   */
  files?: string[];
  /**
   * What the item may use: turns in a run, tokens and minutes over all its
   * runs; a dollar amount is carried and not enforced. The plan file writes
   * it as `budget: 25 turns, 200K tokens, 20 min` under the to-do.
   */
  budget?: { turns?: number; tokens?: number; minutes?: number; usd?: number };
}

export interface TaskPlan {
  items: TaskItem[];
  /** ISO timestamp of the last change */
  updatedAt: string;
  /** Who made the last change; "user" tells the model to keep the person's edits */
  updatedBy?: "model" | "user";
}

/**
 * Prior state of one file, captured before an agent tool call changed it.
 * See core/util/checkpoints.ts.
 */
export interface FileCheckpoint {
  /** File URI, as used by the IDE interface */
  uri: string;
  /** False when the agent created the file, so restoring means deleting it */
  existed: boolean;
  /** Prior contents. Absent when `existed` is false or the file was skipped */
  content?: string;
  /** Why the contents were not stored, so this file cannot be restored */
  skipped?: "too_large" | "unreadable" | "evicted" | "secret";
}

/** All files first touched during one turn (one user message and its replies). */
export interface TurnCheckpoint {
  /** `message.id` of the user message that started the turn */
  turnId: string;
  createdAt: number;
  files: FileCheckpoint[];
}

export interface BaseSessionMetadata {
  sessionId: string;
  title: string;
  dateCreated: string;
  workspaceDirectory: string;
  messageCount?: number;
  /** Bytes of the session file when it was last saved (STOR8). */
  fileBytes?: number;
}

export interface RangeInFile {
  filepath: string;
  range: Range;
}

export interface Location {
  filepath: string;
  position: Position;
}

export interface FileWithContents {
  filepath: string;
  contents: string;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Position {
  line: number;
  character: number;
}

export interface FileEdit {
  filepath: string;
  range: Range;
  replacement: string;
}

export interface CompletionOptions extends BaseCompletionOptions {
  model: string;
}

export type ChatMessageRole =
  "user" | "assistant" | "thinking" | "system" | "tool";

export type TextMessagePart = {
  type: "text";
  text: string;
};

export type ImageMessagePart = {
  type: "imageUrl";
  imageUrl: { url: string };
};

export type MessagePart = TextMessagePart | ImageMessagePart;

export type MessageContent = string | MessagePart[];

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolCallDelta {
  id?: string;
  type?: "function";
  /**
   * OpenAI stream `tool_calls[].index`. Argument fragments of parallel calls
   * omit `id` after the first chunk and are matched on this instead.
   */
  index?: number;
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface ToolResultChatMessage {
  role: "tool";
  content: string;
  toolCallId: string;
  /** Arbitrary per-message metadata (IDs, provider-specific info, etc.) */
  metadata?: Record<string, unknown>;
}

export interface UserChatMessage {
  role: "user";
  content: MessageContent;
  /** Arbitrary per-message metadata (IDs, provider-specific info, etc.) */
  metadata?: Record<string, unknown>;
}

export interface ThinkingChatMessage {
  role: "thinking";
  content: MessageContent;
  signature?: string;
  redactedThinking?: string;
  toolCalls?: ToolCallDelta[];
  reasoning_details?: {
    signature?: string;
    [key: string]: any;
  }[];
  /** Arbitrary per-message metadata (IDs, provider-specific info, etc.) */
  metadata?: Record<string, unknown>;
}

/**
 * This is meant to be equivalent to the OpenAI [usage object](https://platform.openai.com/docs/api-reference/chat/object#chat/object-usage)
 * but potentially with additional information that is needed for other providers.
 */
export interface Usage {
  completionTokens: number;
  promptTokens: number;
  /**
   * How fast the server read the part of the prompt it did not have cached,
   * in tokens per second (llama.cpp's and Strata's `timings.prompt_per_second`).
   */
  promptTokensPerSecond?: number;
  /**
   * What the provider said about the response itself, apart from token counts.
   * Each field is set only when the provider sends it.
   */
  response?: {
    /** Why generation stopped: `tool_use`, `end_turn`, `max_tokens`, ... */
    stopReason?: string;
    /** The provider's own timing for the request (Bedrock `metrics.latencyMs`). */
    latencyMs?: number;
    /** An ID that identifies this call in the provider's logs and billing. */
    requestId?: string;
    /**
     * The service tier that served the request, as the provider names it
     * (Bedrock `serviceTier.type`: `default`, `priority`, `flex`,
     * `reserved`). Prices in the tables are standard-tier prices.
     */
    serviceTier?: string;
  };
  promptTokensDetails?: {
    cachedTokens?: number;
    /** This an Anthropic-specific property */
    cacheWriteTokens?: number;
    /**
     * Part of `cacheWriteTokens` written with the 5-minute lifetime. Only set
     * when the provider reports the split (Anthropic `cache_creation`, Bedrock
     * `cacheDetails`); when absent, treat all writes as 5-minute.
     */
    cacheWriteTokens5m?: number;
    /** Part of `cacheWriteTokens` written with the 1-hour lifetime. */
    cacheWriteTokens1h?: number;
    audioTokens?: number;
  };
  completionTokensDetails?: {
    acceptedPredictionTokens?: number;
    reasoningTokens?: number;
    rejectedPredictionTokens?: number;
    audioTokens?: number;
  };
}

/**
 * How far a server is in reading the prompt (llama.cpp's `prompt_progress`,
 * also sent by Strata): `processed` of `total` tokens, of which `cache` came
 * from its cache, after `timeMs` of reading.
 */
export interface PromptProgress {
  total: number;
  cache: number;
  processed: number;
  timeMs: number;
}

export interface AssistantChatMessage {
  role: "assistant";
  content: MessageContent;
  toolCalls?: ToolCallDelta[];
  usage?: Usage;
  /**
   * Set only on the progress updates a local server sends while it reads a
   * long prompt; such a message has no content and is not part of the reply.
   */
  promptProgress?: PromptProgress;
  /**
   * Set only on the signal a stream sends when it holds back the model's text
   * to look for a tool call the model wrote as text (text tool call
   * recovery): `start` when it begins to hold, `end` when it has decided what
   * the held text was. Such a message has no content and is not part of the
   * reply. Never sent when recovery is off.
   */
  recoveryHold?: "start" | "end";
  /**
   * The account that answered, for a model with routes (models.yaml). Set
   * on the message that carries the usage.
   */
  route?: string;
  /** That account's provider and its id for the model, for pricing. */
  routeProvider?: string;
  routeModel?: string;
  /** Arbitrary per-message metadata (IDs, provider-specific info, etc.) */
  metadata?: Record<string, unknown>;
}

export interface SystemChatMessage {
  role: "system";
  content: string;
  /** Arbitrary per-message metadata (IDs, provider-specific info, etc.) */
  metadata?: Record<string, unknown>;
}

export type ChatMessage =
  | UserChatMessage
  | AssistantChatMessage
  | ThinkingChatMessage
  | SystemChatMessage
  | ToolResultChatMessage;

export interface ContextItemId {
  providerTitle: string;
  itemId: string;
}

export type ContextItemUriTypes = "file" | "url";

export interface ContextItemUri {
  type: ContextItemUriTypes;
  value: string;
}

export interface ContextItem {
  content: string;
  name: string;
  description: string;
  editing?: boolean;
  editable?: boolean;
  icon?: string;
  uri?: ContextItemUri;
  hidden?: boolean;
  status?: string;
}

export interface ContextItemWithId extends ContextItem {
  id: ContextItemId;
}

export interface InputModifiers {
  useCodebase: boolean;
  noContext: boolean;
}

export interface SymbolWithRange extends RangeInFile {
  name: string;
  type: Parser.SyntaxNode["type"];
  content: string;
}

export type FileSymbolMap = Record<string, SymbolWithRange[]>;

export interface PromptLog {
  modelTitle: string;
  modelProvider: string;
  /** The account that answered, for a model with routes. */
  route?: string;
  prompt: string;
  completion: string;
}

export type MessageModes = "chat" | "agent" | "plan" | "background";

export type ToolStatus =
  | "generating" // Tool call arguments are being streamed from the LLM
  | "generated" // Tool call is complete and ready for execution (awaiting approval)
  | "calling" // Tool is actively being executed
  | "errored" // Tool execution failed with an error
  | "done" // Tool execution completed successfully
  | "canceled"; // Tool call was canceled by user or system

interface McpUiResourceContents extends TextResourceContents {
  _meta?: {
    ui?: McpUiResourceMeta;
  };
}

interface McpUiState {
  content: McpUiResourceContents;
}

interface ToolCallDecision {
  outcome: "allowed" | "blocked";
  /** A rule, the safety check, a switch, IDGAF, the Auto reviewer, or the user ("once"). */
  source: string;
  /** One line saying why. */
  reason?: string;
  /** The rule as written in config.yaml, when one decided. */
  rule?: string;
  /** The reviewer's category, for Auto. */
  category?: string;
}

// Will exist only on "assistant" messages with tool calls
interface ToolCallState {
  toolCallId: string;
  toolCall: ToolCall;
  status: ToolStatus;
  /**
   * OpenAI stream index of this call, while arguments are still arriving.
   * Not sent back to the API.
   */
  index?: number;
  parsedArgs: any;
  processedArgs?: Record<string, any>; // Added in preprocesing step
  /** Why this call is waiting for approval, when a rule or protected path says so. */
  policyNote?: string;
  /** The rule (as written in config.yaml) and the kind of check that made the call wait. */
  policyRule?: string;
  policySource?: string;
  /** Why the call ran or was refused, for the decision chip. Set by the policy check. */
  decision?: ToolCallDecision;
  output?: ContextItem[];
  tool?: Tool;
  mcpUiState?: McpUiState;
  /** Progress and outcome of a subagent this call started (the subagent tool). */
  subagent?: SubagentRunState;
}

/**
 * A subagent run, kept on the parent's tool call so it is saved with the
 * session. Holds what the card shows: never the subagent's tool output.
 */
export interface SubagentRunState {
  agent: string;
  /** Title of the model it runs on. */
  model?: string;
  /** Short label the parent gave the task. */
  description?: string;
  prompt: string;
  status: SubagentRunStatus;
  toolCalls: SubagentToolCallSummary[];
  /** The final answer, or what it has written so far. */
  text: string;
  error?: string;
  /** Notes for the person (a model fallback, a tool it could not have). */
  notices?: string[];
  /**
   * Messages to the run: the person's, sent from its record in the agents
   * panel, and another subagent's (send_message), named by `from`. Delivered
   * into its conversation, or not (the run ended first).
   */
  messages?: {
    text: string;
    at: number;
    delivered: boolean;
    /** The sending subagent's name; absent for the person */
    from?: string;
  }[];
  /** A call of the subagent's waiting for the person's approval. */
  pendingApproval?: {
    id: string;
    toolName: string;
    summary: string;
    note?: string;
  };
  startedAt?: number;
  endedAt?: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
  };
}

interface Reasoning {
  active: boolean;
  text: string;
  startAt: number;
  endAt?: number;
  /**
   * What the provider needs back to continue from this reasoning (the CLI
   * keeps Claude's signed and redacted thinking here, as `reasoning_details`
   * entries). Absent when there is nothing to send back.
   */
  details?: Record<string, unknown>[];
}

/**
 * How a turn ended early: Stop, a request that failed for good, or a window
 * that closed or reloaded while it ran.
 */
export type TurnInterruption = "stopped" | "failed" | "reloaded";

/** What "Choose what to keep" took out of one history item. */
export interface RemovedByUser {
  /** The whole item is left out: part of an old turn removed from the start. */
  turn?: boolean;
  /** Tool calls of this assistant item whose results are sent as a stub. */
  toolResults?: string[];
  /** Indexes into `contextItems` sent as a stub. */
  contextItems?: number[];
  /** Indexes of image parts of the message sent as a stub. */
  images?: number[];
}

export interface ChatHistoryItem {
  message: ChatMessage;
  contextItems: ContextItemWithId[];
  editorState?: any;
  modifiers?: InputModifiers;
  promptLogs?: PromptLog[];
  toolCallStates?: ToolCallState[];
  isGatheringContext?: boolean;
  reasoning?: Reasoning;
  appliedRules?: RuleMetadata[];
  conversationSummary?: string;
  /**
   * Set on the last item kept from a turn that the person stopped or that
   * failed, or that a reload cut off. The chat offers Resume for it.
   */
  interrupted?: TurnInterruption;
  /**
   * Parts of this item the person took out of the context with "Choose what
   * to keep" (gui SelectiveCompactDialog). Nothing is deleted: the request
   * sends a one-line stub in their place (core/util/contextRemoval.ts), and
   * the originals stay in the session.
   */
  removedByUser?: RemovedByUser;
  /**
   * Request-time only, never saved: a prompt cache point goes right after this
   * item (a fork point, such as a Loop item's first message), so a retry, a
   * branch or a subagent that starts from the same context reads the cached
   * prefix instead of writing it again. Set by the CLI's loopRequestHistory
   * and read by buildChatRequestBody.
   */
  cachePin?: boolean;
}

export interface LLMFullCompletionOptions extends BaseCompletionOptions {
  log?: boolean;
  model?: string;
}

export type ToastType = "info" | "error" | "warning";

export interface LLMInteractionBase {
  interactionId: string;
  timestamp: number;
}

export interface LLMInteractionStartChat extends LLMInteractionBase {
  kind: "startChat";
  messages: ChatMessage[];
  options: CompletionOptions;
  provider: string;
}

export interface LLMInteractionStartComplete extends LLMInteractionBase {
  kind: "startComplete";
  prompt: string;
  options: CompletionOptions;
  provider: string;
}

export interface LLMInteractionStartFim extends LLMInteractionBase {
  kind: "startFim";
  prefix: string;
  suffix: string;
  options: CompletionOptions;
  provider: string;
}

export interface LLMInteractionChunk extends LLMInteractionBase {
  kind: "chunk";
  chunk: string;
}

export interface LLMInteractionMessage extends LLMInteractionBase {
  kind: "message";
  message: ChatMessage;
}

export interface LLMInteractionEnd extends LLMInteractionBase {
  promptTokens: number;
  generatedTokens: number;
  thinkingTokens: number;
  usage: Usage | undefined;
}

export interface LLMInteractionSuccess extends LLMInteractionEnd {
  kind: "success";
}

export interface LLMInteractionCancel extends LLMInteractionEnd {
  kind: "cancel";
}

export interface LLMInteractionError extends LLMInteractionEnd {
  kind: "error";
  name: string;
  message: string;
}

export type LLMInteractionItem =
  | LLMInteractionStartChat
  | LLMInteractionStartComplete
  | LLMInteractionStartFim
  | LLMInteractionChunk
  | LLMInteractionMessage
  | LLMInteractionSuccess
  | LLMInteractionCancel
  | LLMInteractionError;

// When we log a LLM interaction, we want to add the interactionId and timestamp
// in the logger code, so we need a type that omits these members from *each*
// member of the union. This can be done by using the distributive behavior of
// conditional types in Typescript.
//
// www.typescriptlang.org/docs/handbook/2/conditional-types.html#distributive-conditional-types
// https://stackoverflow.com/questions/57103834/typescript-omit-a-property-from-all-interfaces-in-a-union-but-keep-the-union-s
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

export type LLMInteractionItemDetails = DistributiveOmit<
  LLMInteractionItem,
  "interactionId" | "timestamp"
>;

export interface ILLMInteractionLog {
  logItem(item: LLMInteractionItemDetails): void;
}

export interface ILLMLogger {
  createInteractionLog(): ILLMInteractionLog;
}

export interface LLMOptions {
  model: string;

  title?: string;
  uniqueId?: string;
  baseAgentSystemMessage?: string;
  toolDialect?: ToolDialectSetting;
  basePlanSystemMessage?: string;
  baseChatSystemMessage?: string;
  autocompleteOptions?: Partial<TabAutocompleteOptions>;
  contextLength?: number;
  maxStopWords?: number;
  completionOptions?: CompletionOptions;
  requestOptions?: RequestOptions;
  template?: TemplateType;
  promptTemplates?: Partial<Record<keyof PromptTemplates, PromptTemplate>>;
  templateMessages?: (messages: ChatMessage[]) => string;
  logger?: ILLMLogger;
  llmRequestHook?: (model: string, prompt: string) => any;
  apiKey?: string;

  // continueProperties
  apiKeyLocation?: string;
  envSecretLocations?: Record<string, string>;
  apiBase?: string;

  onPremProxyUrl?: string | null;

  aiGatewaySlug?: string;
  cacheBehavior?: CacheBehavior;
  capabilities?: ModelCapability;
  roles?: ModelRole[];

  useLegacyCompletionsEndpoint?: boolean;
  useResponsesApi?: boolean;

  // Embedding options
  embeddingId?: string;
  maxEmbeddingChunkSize?: number;
  maxEmbeddingBatchSize?: number;

  // Cloudflare options
  accountId?: string;

  // Azure options
  deployment?: string;
  apiVersion?: string;
  apiType?: string;

  // AWS options
  profile?: string;
  modelArn?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  mantlePathPrefix?: string;
  maxTokensParam?: string;
  crossRegionInference?: string;
  serviceTier?: string;
  latency?: string;
  guardrailIdentifier?: string;
  guardrailVersion?: string;

  // AWS and VertexAI Options
  region?: string;

  // VertexAI and Watsonx Options
  projectId?: string;

  // IBM watsonx Options
  deploymentId?: string;

  env?: Record<string, string | number | boolean>;

  sourceFile?: string;
  isFromAutoDetect?: boolean;

  /** Tool overrides for this model */
  toolOverrides?: ToolOverride[];
}

type RequireAtLeastOne<T, Keys extends keyof T = keyof T> = Pick<
  T,
  Exclude<keyof T, Keys>
> &
  {
    [K in Keys]-?: Required<Pick<T, K>> & Partial<Pick<T, Exclude<Keys, K>>>;
  }[Keys];

export interface CustomLLMWithOptionals {
  options: LLMOptions;
  streamCompletion?: (
    prompt: string,
    signal: AbortSignal,
    options: CompletionOptions,
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  ) => AsyncGenerator<string>;
  streamChat?: (
    messages: ChatMessage[],
    signal: AbortSignal,
    options: CompletionOptions,
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  ) => AsyncGenerator<ChatMessage | string>;
  listModels?: (
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  ) => Promise<string[]>;
}

/**
 * The LLM interface requires you to specify either `streamCompletion` or `streamChat` (or both).
 */
export type CustomLLM = RequireAtLeastOne<
  CustomLLMWithOptionals,
  "streamCompletion" | "streamChat"
>;

// IDE

export type DiffType = "new" | "old" | "same";

export interface DiffObject {
  type: DiffType;
}

export interface DiffLine extends DiffObject {
  line: string;
}

interface DiffChar extends DiffObject {
  char: string;
  oldIndex?: number; // Character index assuming a flattened line string.
  newIndex?: number;
  oldCharIndexInLine?: number; // Character index assuming new lines reset the character index to 0.
  newCharIndexInLine?: number;
  oldLineIndex?: number;
  newLineIndex?: number;
}

export interface Problem {
  filepath: string;
  range: Range;
  message: string;
  /** Unset when the IDE does not report it. */
  severity?: "error" | "warning" | "information" | "hint";
  /** The tool that reported it, such as "ts" or "eslint". */
  source?: string;
}

/** A symbol found by a workspace-wide search (LSP workspace/symbol). */
export interface WorkspaceSymbol {
  name: string;
  kind: SymbolKind;
  containerName?: string;
  location: RangeInFile;
}

export interface Thread {
  name: string;
  id: number;
}

export type IdeType = "vscode" | "jetbrains";

export interface IdeInfo {
  ideType: IdeType;
  name: string;
  version: string;
  remoteName: string;
  extensionVersion: string;
  isPrerelease: boolean;
}

export interface BranchAndDir {
  branch: string;
  directory: string;
}

export interface IndexTag extends BranchAndDir {
  artifactId: string;
}

export enum FileType {
  Unkown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

export interface IdeSettings {
  remoteConfigServerUrl: string | undefined;
  remoteConfigSyncPeriod: number;
  userToken: string;
  continueTestEnvironment: "none" | "production" | "staging" | "local";
  pauseCodebaseIndexOnStart: boolean;
  /** Keep each request's full prompt in the size-capped debug prompt log. Off by default. */
  debugPromptLog?: boolean;
}

export interface FileStats {
  size: number;
  lastModified: number;
}

/** Map of file name to stats */
export type FileStatsMap = {
  [path: string]: FileStats;
};

export interface IDE {
  getIdeInfo(): Promise<IdeInfo>;

  getIdeSettings(): Promise<IdeSettings>;

  getDiff(includeUnstaged: boolean): Promise<string[]>;

  getClipboardContent(): Promise<{ text: string; copiedAt: string }>;

  isTelemetryEnabled(): Promise<boolean>;

  isWorkspaceRemote(): Promise<boolean>;

  getUniqueId(): Promise<string>;

  getTerminalContents(): Promise<string>;

  getDebugLocals(threadIndex: number): Promise<string>;

  getTopLevelCallStackSources(
    threadIndex: number,
    stackDepth: number,
  ): Promise<string[]>;

  getAvailableThreads(): Promise<Thread[]>;

  getWorkspaceDirs(): Promise<string[]>;

  fileExists(fileUri: string): Promise<boolean>;

  writeFile(path: string, contents: string): Promise<void>;

  removeFile(path: string): Promise<void>;

  showVirtualFile(title: string, contents: string): Promise<void>;

  openFile(path: string): Promise<void>;

  openUrl(url: string): Promise<void>;

  getExternalUri?(uri: string): Promise<string>;

  runCommand(command: string, options?: TerminalOptions): Promise<void>;

  saveFile(fileUri: string): Promise<void>;

  readFile(fileUri: string): Promise<string>;

  readRangeInFile(fileUri: string, range: Range): Promise<string>;

  showLines(fileUri: string, startLine: number, endLine: number): Promise<void>;

  getOpenFiles(): Promise<string[]>;

  getCurrentFile(): Promise<
    | undefined
    | {
        isUntitled: boolean;
        path: string;
        contents: string;
      }
  >;

  getPinnedFiles(): Promise<string[]>;

  getSearchResults(query: string, maxResults?: number): Promise<string>;

  getFileResults(pattern: string, maxResults?: number): Promise<string[]>;

  subprocess(command: string, cwd?: string): Promise<[string, string]>;

  getProblems(fileUri?: string | undefined): Promise<Problem[]>;

  getBranch(dir: string): Promise<string>;

  getTags(artifactId: string): Promise<IndexTag[]>;

  getRepoName(dir: string): Promise<string | undefined>;

  showToast(
    type: ToastType,
    message: string,
    ...otherParams: any[]
  ): Promise<any>;

  getGitRootPath(dir: string): Promise<string | undefined>;

  listDir(dir: string): Promise<[string, FileType][]>;

  getFileStats(files: string[]): Promise<FileStatsMap>;

  // Secret Storage
  readSecrets(keys: string[]): Promise<Record<string, string>>;

  writeSecrets(secrets: { [key: string]: string }): Promise<void>;

  // LSP
  gotoDefinition(location: Location): Promise<RangeInFile[]>;
  gotoTypeDefinition(location: Location): Promise<RangeInFile[]>; // TODO: add to jetbrains
  getSignatureHelp(location: Location): Promise<SignatureHelp | null>; // TODO: add to jetbrains
  getReferences(location: Location): Promise<RangeInFile[]>;
  getDocumentSymbols(textDocumentIdentifier: string): Promise<DocumentSymbol[]>;
  /** Symbols whose names match `query`, across the workspace. */
  getWorkspaceSymbols(query: string): Promise<WorkspaceSymbol[]>;
  /**
   * A file's problems once its language servers have caught up with a
   * change: waits for the file's diagnostics to change, at most `timeoutMs`,
   * then returns them. IDEs without diagnostics return [].
   */
  waitForProblems(fileUri: string, timeoutMs: number): Promise<Problem[]>;

  // Callbacks
  onDidChangeActiveTextEditor(callback: (fileUri: string) => void): void;
}

// Slash Commands

export interface ContinueSDK {
  ide: IDE;
  llm: ILLM;
  addContextItem: (item: ContextItemWithId) => void;
  history: ChatMessage[];
  input: string;
  params?: { [key: string]: any } | undefined;
  contextItems: ContextItemWithId[];
  selectedCode: RangeInFile[];
  config: ContinueConfig;
  fetch: FetchFunction;
  completionOptions?: LLMFullCompletionOptions;
  abortController: AbortController;
}

/* Be careful changing SlashCommand or SlashCommandDescription, config.ts can break */
export interface SlashCommandDescription {
  name: string;
  description: string;
  prompt?: string;
  params?: { [key: string]: any };
}

export interface SlashCommand extends SlashCommandDescription {
  run: (sdk: ContinueSDK) => AsyncGenerator<string | undefined>;
}

export interface SlashCommandWithSource extends SlashCommandDescription {
  run?: (sdk: ContinueSDK) => AsyncGenerator<string | undefined>; // Optional - only needed for legacy
  source: SlashCommandSource;
  sourceFile?: string;
  slug?: string;
  overrideSystemMessage?: string;
}

export type SlashCommandSource =
  | "built-in-legacy"
  | "built-in"
  | "json-custom-command"
  | "config-ts-slash-command"
  | "yaml-prompt-block"
  | "mcp-prompt"
  | "prompt-file-v1"
  | "prompt-file-v2"
  | "invokable-rule";

export interface SlashCommandDescWithSource extends SlashCommandDescription {
  isLegacy: boolean; // Maps to if slashcommand.run exists
  source: SlashCommandSource;
  sourceFile?: string;
  slug?: string;
  mcpServerName?: string;
  mcpArgs?: MCPPromptArgs;
}

// Config

export type StepName =
  | "AnswerQuestionChroma"
  | "GenerateShellCommandStep"
  | "EditHighlightedCodeStep"
  | "ShareSessionStep"
  | "CommentCodeStep"
  | "ClearHistoryStep"
  | "StackOverflowStep"
  | "OpenConfigStep"
  | "GenerateShellCommandStep"
  | "DraftIssueStep";

export type ContextProviderName =
  | "diff"
  | "terminal"
  | "debugger"
  | "open"
  | "google"
  | "search"
  | "tree"
  | "http"
  | "codebase"
  | "problems"
  | "folder"
  | "jira"
  | "postgres"
  | "database"
  | "code"
  | "docs"
  | "gitlab-mr"
  | "os"
  | "currentFile"
  | "greptile"
  | "outline"
  | "highlights"
  | "file"
  | "issue"
  | "repo-map"
  | "url"
  | "commit"
  | "web"
  | "discord"
  | "clipboard"
  | string;

export type TemplateType =
  | "llama2"
  | "alpaca"
  | "zephyr"
  | "phi2"
  | "phind"
  | "anthropic"
  | "chatml"
  | "none"
  | "openchat"
  | "deepseek"
  | "xwin-coder"
  | "neural-chat"
  | "codellama-70b"
  | "llava"
  | "gemma"
  | "granite"
  | "llama3"
  | "codestral";

export interface RequestOptions {
  timeout?: number;
  /** Seconds to wait for a connection to the server (default 10). */
  connectTimeout?: number;
  verifySsl?: boolean;
  /** Also trust the operating system certificate store (default: on for Windows and macOS). */
  useSystemCa?: boolean;
  caBundlePath?: string | string[];
  proxy?: string;
  headers?: { [key: string]: string };
  extraBodyProperties?: { [key: string]: any };
  noProxy?: string[];
  clientCertificate?: ClientCertificateOptions;
}

export interface CacheBehavior {
  cacheSystemMessage?: boolean;
  cacheConversation?: boolean;
  /**
   * Lifetime of prompt cache entries: "5m", "1h", or "auto" (5 minutes, then
   * 1 hour after a pause a 1-hour entry would have covered). Does not turn
   * caching on. A choice in the chat toolbar overrides it.
   */
  ttl?: "auto" | "5m" | "1h";
}

export interface ClientCertificateOptions {
  cert: string;
  key: string;
  passphrase?: string;
}

export interface StepWithParams {
  name: StepName;
  params: { [key: string]: any };
}

export interface ContextProviderWithParams {
  name: ContextProviderName;
  params: { [key: string]: any };
}

export interface CustomCommand {
  name: string;
  prompt: string;
  description?: string;
  sourceFile?: string;
}

export interface Prediction {
  type: "content";
  content:
    | string
    | {
        type: "text";
        text: string;
      }[];
}

export interface ToolExtras {
  ide: IDE;
  llm: ILLM;
  fetch: FetchFunction;
  tool: Tool;
  toolCallId?: string;
  onPartialOutput?: (params: {
    toolCallId: string;
    contextItems: ContextItem[];
  }) => void;
  config: ContinueConfig;
  codeBaseIndexer?: CodebaseIndexer;
  /**
   * Set when the call runs in another checkout (`tools/call` with
   * `workspaceDirs`: a Loop worker's worktree). `ide` already answers these
   * folders; the exact edit tools run only with this set.
   */
  workspaceDirs?: string[];
  /**
   * Set when File edits is IDGAF, which says nothing asks: the file
   * tools may then name a path outside the workspace folders. The permission
   * layer has already decided the call; this only lets the tool resolve the
   * path instead of treating it as not a target.
   */
  allowOutsideWorkspace?: boolean;
}

export interface McpToolMeta {
  ui?: {
    resourceUri?: string;
  };
  "ui/resourceUri"?: string;
}

export interface Tool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, any>;
    strict?: boolean | null;
  };
  displayTitle: string;
  wouldLikeTo?: string;
  isCurrently?: string;
  hasAlready?: string;
  readonly: boolean;
  isInstant?: boolean;
  uri?: string;
  faviconUrl?: string;
  group: string;
  originalFunctionName?: string;
  /** An MCP tool from a server the open folder brought, not the person's own config */
  mcpFromWorkspace?: boolean;
  systemMessageDescription?: {
    prefix: string;
    exampleArgs?: Array<[string, string | number]>;
  };
  defaultToolPolicy?: ToolPolicy;
  toolCallIcon?: string;
  preprocessArgs?: (
    args: Record<string, unknown>,
    extras: {
      ide: IDE;
      /** As for ToolExtras: File edits is IDGAF */
      allowOutsideWorkspace?: boolean;
    },
  ) => Promise<Record<string, unknown>>;
  evaluateToolCallPolicy?: (
    basePolicy: ToolPolicy,
    parsedArgs: Record<string, unknown>,
    processedArgs?: Record<string, unknown>,
  ) => ToolPolicy;
  mcpMeta?: McpToolMeta;
  /**
   * An MCP tool whose definition changed, or that appeared, after the person
   * approved its server. It asks again at every level but IDGAF until a call to
   * it is approved. `summary` says what changed.
   */
  mcpDefinitionChange?: {
    kind: "changed" | "added" | "launch";
    summary: string;
  };
}

/**
 * Configuration for overriding built-in tool prompts.
 * Extends ToolOverrideConfig with required name for array usage.
 */
export type ToolOverride = ToolOverrideConfig & {
  /** Tool name to override (matches function.name, e.g., "read_file") */
  name: string;
};

interface ToolChoice {
  type: "function";
  function: {
    name: string;
  };
}

export interface ConfigDependentToolParams {
  rules: RuleWithSource[];
  enableExperimentalTools: boolean;
  isRemote: boolean;
  modelName: string | undefined;
  ide: IDE;
  /** `experimental.toolSearch`: "auto" adds the search_tools meta-tool. Default off. */
  toolSearch?: "off" | "auto";
}

export type GetTool = (params: ConfigDependentToolParams) => Promise<Tool>;

export interface BaseCompletionOptions {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  mirostat?: number;
  stop?: string[];
  maxTokens?: number;
  numThreads?: number;
  useMmap?: boolean;
  keepAlive?: number;
  numGpu?: number;
  raw?: boolean;
  stream?: boolean;
  prediction?: Prediction;
  tools?: Tool[];
  toolChoice?: ToolChoice;
  reasoning?: boolean;
  reasoningBudgetTokens?: number;
  promptCaching?: boolean;
  /**
   * Advanced. `true` leaves temperature, topP and topK out of the request;
   * `false` sends them even to a Claude model that refuses them (4.7 and
   * later); unset follows the model.
   */
  omitSampling?: boolean;
  /**
   * Lifetime of prompt cache entries written by this request. Only honoured by
   * providers that support it (Anthropic and Claude models on Bedrock); omit
   * for the provider's default of 5 minutes.
   */
  promptCacheTtl?: "5m" | "1h";
}

export interface ModelCapability {
  uploadImage?: boolean;
  tools?: boolean;
  nextEdit?: boolean;
}

export interface ModelDescription {
  title: string;
  provider: string;
  underlyingProviderName: string;
  model: string;
  apiKey?: string;

  apiBase?: string;
  apiKeyLocation?: string;
  envSecretLocations?: Record<string, string>;

  onPremProxyUrl?: string | null;

  contextLength?: number;
  maxStopWords?: number;
  template?: TemplateType;
  completionOptions?: BaseCompletionOptions;
  baseAgentSystemMessage?: string;
  toolDialect?: ToolDialectSetting;
  basePlanSystemMessage?: string;
  baseChatSystemMessage?: string;
  requestOptions?: RequestOptions;
  promptTemplates?: { [key: string]: string };
  cacheBehavior?: CacheBehavior;
  capabilities?: ModelCapability;
  roles?: ModelRole[];
  configurationStatus?: LLMConfigurationStatuses;

  sourceFile?: string;
  isFromAutoDetect?: boolean;

  /**
   * For a model with routes: the accounts serving it, in the order they are
   * tried. Each has its own prompt cache.
   */
  routes?: string[];

  /** Tool overrides for this model */
  toolOverrides?: ToolOverride[];
}

export interface JSONEmbedOptions {
  apiBase?: string;
  apiKey?: string;
  model?: string;
  deployment?: string;
  apiType?: string;
  apiVersion?: string;
  requestOptions?: RequestOptions;
  maxEmbeddingChunkSize?: number;
  maxEmbeddingBatchSize?: number;

  // AWS options
  profile?: string;

  // AWS and VertexAI Options
  region?: string;

  // VertexAI and Watsonx Options
  projectId?: string;
}

export interface EmbeddingsProviderDescription extends JSONEmbedOptions {
  provider: string;
}

export interface RerankerDescription {
  name: string;
  params?: { [key: string]: any };
}

// TODO: We should consider renaming this to AutocompleteOptions.
export interface TabAutocompleteOptions {
  disable: boolean;
  maxPromptTokens: number;
  debounceDelay: number;
  modelTimeout: number;
  maxSuffixPercentage: number;
  prefixPercentage: number;
  transform?: boolean;
  template?: string;
  multilineCompletions: "always" | "never" | "auto";
  slidingWindowPrefixPercentage: number;
  slidingWindowSize: number;
  useCache: boolean;
  onlyMyCode: boolean;
  useRecentlyEdited: boolean;
  useRecentlyOpened: boolean;
  disableInFiles?: string[];
  useImports?: boolean;
  showWhateverWeHaveAtXMs?: number;
  // true = enabled, false = disabled, number = enabled with priority
  experimental_includeClipboard: boolean | number;
  experimental_includeRecentlyVisitedRanges: boolean | number;
  experimental_includeRecentlyEditedRanges: boolean | number;
  experimental_includeDiff: boolean | number;
  experimental_enableStaticContextualization: boolean;
}

export interface StdioOptions {
  type: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface WebSocketOptions {
  type: "websocket";
  url: string;
  requestOptions?: RequestOptions;
}

export interface SSEOptions {
  type: "sse";
  url: string;
  requestOptions?: RequestOptions;
}

export interface StreamableHTTPOptions {
  type: "streamable-http";
  url: string;
  requestOptions?: RequestOptions;
}

export type TransportOptions =
  StdioOptions | WebSocketOptions | SSEOptions | StreamableHTTPOptions;

export type MCPConnectionStatus =
  | "disabled"
  | "connecting"
  | "connected"
  | "error"
  | "authenticating"
  | "not-connected";

export type MCPPromptArgs = {
  name: string;
  description?: string;
  required?: boolean;
}[];

export interface MCPPrompt {
  name: string;
  description?: string;
  arguments?: MCPPromptArgs;
}

// https://modelcontextprotocol.io/docs/concepts/resources#direct-resources
export interface MCPResource {
  name: string;
  uri: string;
  description?: string;
  mimeType?: string;
}

// https://modelcontextprotocol.io/docs/concepts/resources#resource-templates
export interface MCPResourceTemplate {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, any>;
  };
  _meta?: Record<string, unknown> | undefined;
  /** MCP tool annotations; `readOnlyHint` says the tool changes nothing */
  annotations?: { readOnlyHint?: boolean };
}

type BaseInternalMCPOptions = {
  id: string;
  name: string;
  faviconUrl?: string;
  timeout?: number;
  requestOptions?: RequestOptions;
  sourceFile?: string;
  /**
   * "user" for the person's own config and global MCP files. "workspace" for
   * a file that came with the folder.
   */
  configSource?: "user" | "workspace";
  /**
   * Set when a workspace file defined this server and that folder is not
   * trusted. The server is not started and its secret values are not kept.
   */
  projectTrust?: "required";
};

export type InternalStdioMcpOptions = BaseInternalMCPOptions & {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};

export type InternalStreamableHttpMcpOptions = BaseInternalMCPOptions & {
  type?: "streamable-http";
  url: string;
  apiKey?: string;
  oauth?: McpOauthSettings;
};

export type InternalSseMcpOptions = BaseInternalMCPOptions & {
  type?: "sse";
  url: string;
  apiKey?: string;
  oauth?: McpOauthSettings;
};

export interface McpOauthSettings {
  /** Port of the local redirect server used while signing in (default 3000). */
  callbackPort?: number;
  /** Pre-registered OAuth client id; skips dynamic client registration. */
  clientId?: string;
  /** Secret of the pre-registered client (use a secrets reference). */
  clientSecret?: string;
  /** Host in the redirect URI: "localhost" (default) or "127.0.0.1". */
  redirectHost?: "localhost" | "127.0.0.1";
}

export type InternalWebsocketMcpOptions = BaseInternalMCPOptions & {
  type: "websocket"; // websocket requires explicit type
  url: string;
};

export type InternalMcpOptions =
  | InternalStdioMcpOptions
  | InternalStreamableHttpMcpOptions
  | InternalSseMcpOptions
  | InternalWebsocketMcpOptions;

export type MCPServerStatus = InternalMcpOptions & {
  status: MCPConnectionStatus;
  errors: string[];
  infos: string[];
  isProtectedResource: boolean;
  prompts: MCPPrompt[];
  tools: MCPTool[];
  resources: MCPResource[];
  resourceTemplates: MCPResourceTemplate[];
  sourceFile?: string;
};

export interface ContinueUIConfig {
  codeBlockToolbarPosition?: "top" | "bottom";
  fontSize?: number;
  displayRawMarkdown?: boolean;
  showChatScrollbar?: boolean;
  codeWrap?: boolean;
  showSessionTabs?: boolean;
  continueAfterToolRejection?: boolean;
  /**
   * Save sessions as an append-only log with large tool outputs and images
   * stored once by hash (STOR6/STOR7) instead of rewriting a JSON file.
   */
  sessionLogStorage?: boolean;
  /** Ask the model once to re-issue a tool call it wrote as text (H13). Default true. */
  nudgeLeakedToolCalls?: boolean;
  /** The first-run overview on Settings > Permissions was dismissed. Never shown again. */
  permissionsIntroDismissed?: boolean;
  /** Leave the model's thinking open after the answer starts, instead of folding it to "Thought for Ns". Default false. */
  keepThinkingExpanded?: boolean;
}

export interface ContextMenuConfig {
  comment?: string;
  docstring?: string;
  fix?: string;
  optimize?: string;
  fixGrammar?: string;
}

export interface ExperimentalModelRoles {
  repoMapFileSelection?: string;
  inlineEdit?: string;
  applyCodeBlock?: string;
}

export interface ExperimentalMCPOptions {
  transport: TransportOptions;
  faviconUrl?: string;
  timeout?: number;
}

export type ApplyStateStatus =
  | "not-started" // Apply state created but not necessarily streaming
  | "streaming" // Changes are being applied to the file
  | "done" // All changes have been applied, awaiting user to accept/reject
  | "closed"; // All changes have been applied. Note that for new files, we immediately set the status to "closed"

export interface ApplyState {
  streamId: string;
  status?: ApplyStateStatus;
  numDiffs?: number;
  filepath?: string;
  fileContent?: string;
  originalFileContent?: string;
  toolCallId?: string;
  autoFormattingDiff?: string;
}

export type StreamDiffLinesType = "edit" | "apply";
interface StreamDiffLinesOptionsBase {
  type: StreamDiffLinesType;
  prefix: string;
  highlighted: string;
  suffix: string;
  input: string;
  language: string | undefined;
  modelTitle: string | undefined;
  includeRulesInSystemMessage: boolean;
  fileUri?: string;
}

interface StreamDiffLinesOptionsEdit extends StreamDiffLinesOptionsBase {
  type: "edit";
}

interface StreamDiffLinesOptionsApply extends StreamDiffLinesOptionsBase {
  type: "apply";
  newCode: string;
}

type StreamDiffLinesPayload =
  StreamDiffLinesOptionsApply | StreamDiffLinesOptionsEdit;

export interface HighlightedCodePayload {
  rangeInFileWithContents: RangeInFileWithContents;
  prompt?: string;
  shouldRun?: boolean;
}

export interface AcceptOrRejectDiffPayload {
  filepath?: string;
  streamId?: string;
}

export interface ShowFilePayload {
  filepath: string;
}

export interface ApplyToFilePayload {
  streamId: string;
  filepath?: string;
  text: string;
  toolCallId?: string;
  isSearchAndReplace?: boolean;
}

export interface RangeInFileWithContents {
  filepath: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  contents: string;
}

export interface RangeInFileWithNextEditInfo {
  filepath: string;
  range: Range;
  fileContents: string;
  fileContentsBefore: string;
  editText: string;
  afterCursorPos: Position;
  beforeCursorPos: Position;
  workspaceDir: string;
}

export type SetCodeToEditPayload = RangeInFileWithContents | FileWithContents;

/**
 * Signature help represents the signature of something
 * callable. There can be multiple signatures but only one
 * active and only one active parameter.
 */
export class SignatureHelp {
  /**
   * One or more signatures.
   */
  signatures: SignatureInformation[];

  /**
   * The active signature.
   */
  activeSignature: number;

  /**
   * The active parameter of the active signature.
   */
  activeParameter: number;
}

/**
 * Represents the signature of something callable. A signature
 * can have a label, like a function-name, a doc-comment, and
 * a set of parameters.
 */
export class SignatureInformation {
  /**
   * The label of this signature. Will be shown in
   * the UI.
   */
  label: string;

  /**
   * The parameters of this signature.
   */
  parameters: ParameterInformation[];

  /**
   * The index of the active parameter.
   *
   * If provided, this is used in place of {@linkcode SignatureHelp.activeParameter}.
   */
  activeParameter?: number;
}

/**
 * Represents a parameter of a callable-signature. A parameter can
 * have a label and a doc-comment.
 */
export class ParameterInformation {
  /**
   * The label of this signature.
   *
   * Either a string or inclusive start and exclusive end offsets within its containing
   * {@link SignatureInformation.label signature label}. *Note*: A label of type string must be
   * a substring of its containing signature information's {@link SignatureInformation.label label}.
   */
  label: string | [number, number];
}

/**
 * Represents the configuration for a quick action in the Code Lens.
 * Quick actions are custom commands that can be added to function and class declarations.
 */
export interface QuickActionConfig {
  /**
   * The title of the quick action that will display in the Code Lens.
   */
  title: string;

  /**
   * The prompt that will be sent to the model when the quick action is invoked,
   * with the function or class body concatenated.
   */
  prompt: string;

  /**
   * If `true`, the result of the quick action will be sent to the chat panel.
   * If `false`, the streamed result will be inserted into the document.
   *
   * Defaults to `false`.
   */
  sendToChat: boolean;
}

export type DefaultContextProvider = ContextProviderWithParams & {
  query?: string;
};

export interface ExperimentalConfig {
  contextMenuPrompts?: ContextMenuConfig;
  modelRoles?: ExperimentalModelRoles;
  defaultContext?: DefaultContextProvider[];
  promptPath?: string;
  enableExperimentalTools?: boolean;
  onlyUseSystemMessageTools?: boolean;

  /**
   * "auto": when MCP tools cost more than a token budget, offer the ones that
   * fit and a `search_tools` tool for the rest. Default "off" (plans/tool-overhead.md).
   */
  toolSearch?: "off" | "auto";

  /**
   * Wrap `fetch_url_content` results in a boundary marked with a per-session
   * token, with a sentence saying the text inside is untrusted. Off by default
   * because it changes what the model reads. The environment variable
   * CONTINUOUS_SPOTLIGHT_UNTRUSTED=1 turns it on too.
   */
  spotlightUntrusted?: boolean;

  /**
   * Show the "Auto" approval option, where a reviewer model decides tool calls
   * the rules leave open. Needs a model with `roles: [reviewer]`.
   */
  enableAutoApproval?: boolean;

  /**
   * Quick actions are a way to add custom commands to the Code Lens of
   * function and class declarations.
   */
  quickActions?: QuickActionConfig[];

  /**
   * Automatically read LLM chat responses aloud using system TTS models
   */
  readResponseTTS?: boolean;

  /**
   * If set to true, we will attempt to pull down and install an instance of Chromium
   * that is compatible with the current version of Puppeteer.
   * This is needed to crawl a large number of documentation sites that are dynamically rendered.
   */
  useChromiumForDocsCrawling?: boolean;
  modelContextProtocolServers?: ExperimentalMCPOptions[];

  /**
   * If enabled, will add the current file as context.
   */
  useCurrentFileAsContext?: boolean;

  /**
   * If enabled, @codebase will only use tool calling
   * instead of embeddings, FTS, recently edited files, etc.
   */
  codebaseToolCallingOnly?: boolean;

  /**
   * If enabled, static contextualization will be used to
   * gather context for the model where necessary.
   */
  enableStaticContextualization?: boolean;
}

export interface AnalyticsConfig {
  provider: string;
  url?: string;
  clientKey?: string;
}

export interface JSONModelDescription {
  title: string;
  provider: string;
  underlyingProviderName: string;
  model: string;
  apiKey?: string;
  apiBase?: string;

  contextLength?: number;
  maxStopWords?: number;
  template?: TemplateType;
  completionOptions?: BaseCompletionOptions;
  capabilities?: ModelCapability;
  systemMessage?: string;
  requestOptions?: RequestOptions;
  cacheBehavior?: CacheBehavior;

  region?: string;
  profile?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  mantlePathPrefix?: string;
  maxTokensParam?: string;
  crossRegionInference?: string;
  serviceTier?: string;
  latency?: string;
  guardrailIdentifier?: string;
  guardrailVersion?: string;
  modelArn?: string;
  apiType?: "openai" | "azure";
  apiVersion?: string;
  deployment?: string;
  projectId?: string;
  accountId?: string;
  aiGatewaySlug?: string;
  useLegacyCompletionsEndpoint?: boolean;
  useResponsesApi?: boolean;
  deploymentId?: string;
  isFromAutoDetect?: boolean;
}

// config.json
export interface SerializedContinueConfig {
  env?: string[];
  allowAnonymousTelemetry?: boolean;
  models: JSONModelDescription[];
  systemMessage?: string;
  completionOptions?: BaseCompletionOptions;
  requestOptions?: RequestOptions;
  slashCommands?: SlashCommandDescription[];
  customCommands?: CustomCommand[];
  contextProviders?: ContextProviderWithParams[];
  disableIndexing?: boolean;
  disableSessionTitles?: boolean;
  userToken?: string;
  embeddingsProvider?: EmbeddingsProviderDescription;
  tabAutocompleteModel?: JSONModelDescription | JSONModelDescription[];
  tabAutocompleteOptions?: Partial<TabAutocompleteOptions>;
  ui?: ContinueUIConfig;
  reranker?: RerankerDescription;
  experimental?: ExperimentalConfig;
  analytics?: AnalyticsConfig;
  docs?: SiteIndexingConfig[];
  data?: DataDestination[];
}

export type ConfigMergeType = "merge" | "overwrite";

export type ContinueRcJson = Partial<SerializedContinueConfig> & {
  mergeBehavior: ConfigMergeType;
};

// config.ts - give users simplified interfaces
export interface Config {
  /** Has no effect: Continuous collects no telemetry. Kept so existing configs stay valid. */
  allowAnonymousTelemetry?: boolean;
  /** Each entry in this array will originally be a JSONModelDescription, the same object from your config.json, but you may add CustomLLMs.
   * A CustomLLM requires you only to define an AsyncGenerator that calls the LLM and yields string updates. You can choose to define either `streamCompletion` or `streamChat` (or both).
   * Continuous will do the rest of the work to construct prompt templates, handle context items, prune context, etc.
   */
  models: (CustomLLM | JSONModelDescription)[];
  /** A system message to be followed by all of your models */
  systemMessage?: string;
  /** The default completion options for all models */
  completionOptions?: BaseCompletionOptions;
  /** Request options that will be applied to all models and context providers */
  requestOptions?: RequestOptions;
  /** The list of slash commands that will be available in the sidebar */
  slashCommands?: (SlashCommand | SlashCommandWithSource)[];
  /** Each entry in this array will originally be a ContextProviderWithParams, the same object from your config.json, but you may add CustomContextProviders.
   * A CustomContextProvider requires you only to define a title and getContextItems function. When you type '@title <query>', Continuous will call `getContextItems(query)`.
   */
  contextProviders?: (CustomContextProvider | ContextProviderWithParams)[];
  /** If set to true, Continuous will not index your codebase for retrieval */
  disableIndexing?: boolean;
  /** If set to true, Continuous will not make extra requests to the LLM to generate a summary title of each session. */
  disableSessionTitles?: boolean;
  /** An optional token to identify a user. Not used by Continuous unless you write custom coniguration that requires such a token */
  userToken?: string;
  /** The provider used to calculate embeddings. If left empty, Continuous will use transformers.js to calculate the embeddings with all-MiniLM-L6-v2 */
  embeddingsProvider?: EmbeddingsProviderDescription | ILLM;
  /** The model that Continuous will use for tab autocompletions. */
  tabAutocompleteModel?:
    CustomLLM | JSONModelDescription | (CustomLLM | JSONModelDescription)[];
  /** Options for tab autocomplete */
  tabAutocompleteOptions?: Partial<TabAutocompleteOptions>;
  /** UI styles customization */
  ui?: ContinueUIConfig;
  /** Options for the reranker */
  reranker?: RerankerDescription | ILLM;
  /** Experimental configuration */
  experimental?: ExperimentalConfig;
  /** Analytics configuration */
  analytics?: AnalyticsConfig;
  docs?: SiteIndexingConfig[];
  data?: DataDestination[];
}

// in the actual Continuous source code
/** Reasoning effort requested for a chat mode. */
export type ModeReasoningEffort = "off" | "low" | "medium" | "high";

/** Chat model (by title) and reasoning effort to use in a mode. */
export interface ModeModelSetting {
  /**
   * The default model: selected when switching into the mode. Absent for an
   * entry that only chooses a prompt (`loop: { prompt: short }`).
   */
  title?: string;
  /**
   * Every model offered in the mode, default first. Absent when the config sets
   * only `model`, in which case all models are offered as before.
   */
  titles?: string[];
  reasoningEffort?: ModeReasoningEffort;
  /**
   * Which system prompt the use gets: `full`, `short`, or the name of a
   * prompt block (core/llm/prompts/usePrompts.ts). Absent: the model's
   * prompt profile decides.
   */
  prompt?: string;
  /** The prompt block's text, when `prompt` names one. */
  promptText?: string;
  /**
   * The reminder appended to every user message of the use's requests
   * (`modeModels.<use>.tail`): `"on"` for the built-in line of the turn kind,
   * `"off"`, or a short text. Absent: on for Loop items and for the `short`
   * prompt profile, off elsewhere (core/llm/prompts/usePrompts.ts).
   */
  tail?: string;
}

/**
 * Whether rules are sent in each mode. A mode left out is enabled; `loop`
 * follows `agent` and `replan` follows `plan` when left out.
 */
export type RulesByModeConfig = Partial<
  Record<"chat" | "agent" | "plan" | "loop" | "replan", boolean>
>;

/**
 * What a model can be used for: the three chat modes, Loop item turns,
 * Loop re-plans, the Auto reviewer and subagents (see core/util/modelUse.ts).
 */
export type ModelUse =
  "chat" | "agent" | "plan" | "loop" | "replan" | "reviewer" | "subagent";

/** Which model does what, from `modeModels:` in config.yaml. */
export type ModeModelsConfig = Partial<Record<ModelUse, ModeModelSetting>>;

export interface ContinueConfig {
  allowAnonymousTelemetry?: boolean;
  // systemMessage?: string;
  completionOptions?: BaseCompletionOptions;
  requestOptions?: RequestOptions;
  slashCommands: SlashCommandWithSource[];
  contextProviders: IContextProvider[];
  disableSessionTitles?: boolean;
  disableIndexing?: boolean;
  userToken?: string;
  tabAutocompleteOptions?: Partial<TabAutocompleteOptions>;
  ui?: ContinueUIConfig;
  experimental?: ExperimentalConfig;
  analytics?: AnalyticsConfig;
  docs?: SiteIndexingConfig[];
  tools: Tool[];
  mcpServerStatuses: MCPServerStatus[];
  rules: RuleWithSource[];
  modelsByRole: Record<ModelRole, ILLM[]>;
  /**
   * Catalog models (and variants) that this config does not use for any
   * role, offered to VS Code's model picker next to the config's chat models.
   */
  offeredModels?: ILLM[];
  selectedModelByRole: Record<ModelRole, ILLM | null>;
  modeModels?: ModeModelsConfig;
  /** Per-mode rules switch from `rulesByMode:` in config.yaml; a missing mode is on. */
  rulesByMode?: RulesByModeConfig;
  /** Rules from `toolPermissions:` in config.yaml (allow / ask / deny). */
  toolPermissions?: ToolPermissions;
  data?: DataDestination[];
}

export interface BrowserSerializedContinueConfig {
  allowAnonymousTelemetry?: boolean;
  // systemMessage?: string;
  completionOptions?: BaseCompletionOptions;
  requestOptions?: RequestOptions;
  slashCommands: SlashCommandDescWithSource[];
  contextProviders: ContextProviderDescription[];
  disableIndexing?: boolean;
  disableSessionTitles?: boolean;
  userToken?: string;
  ui?: ContinueUIConfig;
  experimental?: ExperimentalConfig;
  analytics?: AnalyticsConfig;
  docs?: SiteIndexingConfig[];
  tools: Omit<Tool, "preprocessArgs", "evaluateToolCallPolicy">[];
  mcpServerStatuses: MCPServerStatus[];
  rules: RuleWithSource[];
  tabAutocompleteOptions?: Partial<TabAutocompleteOptions>;
  modelsByRole: Record<ModelRole, ModelDescription[]>;
  selectedModelByRole: Record<ModelRole, ModelDescription | null>;
  modeModels?: ModeModelsConfig;
  rulesByMode?: RulesByModeConfig;
}

// DOCS SUGGESTIONS AND PACKAGE INFO
export interface FilePathAndName {
  path: string;
  name: string;
}

export interface PackageFilePathAndName extends FilePathAndName {
  packageRegistry: string; // e.g. npm, pypi
}

export type ParsedPackageInfo = {
  name: string;
  packageFile: PackageFilePathAndName;
  language: string;
  version: string;
};

export type PackageDetails = {
  docsLink?: string;
  docsLinkWarning?: string;
  title?: string;
  description?: string;
  repo?: string;
  license?: string;
};

export type PackageDetailsSuccess = PackageDetails & {
  docsLink: string;
};

export type PackageDocsResult = {
  packageInfo: ParsedPackageInfo;
} & (
  | { error: string; details?: never }
  | { details: PackageDetailsSuccess; error?: never }
);

export interface TerminalOptions {
  reuseTerminal?: boolean;
  terminalName?: string;
  waitForCompletion?: boolean;
}

export type RuleSource =
  | "default-chat"
  | "default-plan"
  | "default-agent"
  | "model-options-chat"
  | "model-options-plan"
  | "model-options-agent"
  | "rules-block"
  | "colocated-markdown"
  | "json-systemMessage"
  | ".continuerules"
  | "agentFile";

export interface RuleMetadata {
  name?: string;
  slug?: string;
  source: RuleSource;
  globs?: string | string[];
  regex?: string | string[];
  description?: string;
  sourceFile?: string;
  alwaysApply?: boolean;
  invokable?: boolean;
}
export interface RuleWithSource extends RuleMetadata {
  rule: string;
}

export interface Skill {
  name: string;
  description: string;
  path: string;
  content: string;
  files: string[];
  license?: string;
}

/**
 * A local model the person chose on the onboarding Local tab instead of the
 * suggested default. Everything but `chatModel` is optional.
 */
export interface LocalOnboardingChoice {
  /** A provider id of the config schema: ollama, lmstudio, llama.cpp, vllm, openai. */
  provider: string;
  chatModel: string;
  /** Shown in the model picker; the model name when absent. */
  chatTitle?: string;
  /** The server address; the provider's own default when absent. */
  apiBase?: string;
  /** Autocomplete (FIM) model. Ollama falls back to the suggested default. */
  fimModel?: string;
  /** Embeddings model. Ollama falls back to the suggested default. */
  embeddingsModel?: string;
}

export interface CompleteOnboardingPayload {
  mode: OnboardingModes;
  /** The Local tab's own choice; the suggested Ollama setup when absent. */
  local?: LocalOnboardingChoice;
}

export interface CompiledMessagesResult {
  compiledChatMessages: ChatMessage[];
  didPrune: boolean;
  /** History ageing masked more tool results in this request (a planned cache rebuild). */
  didAge?: boolean;
  /** What normalizeTurns repaired in the history (llm/normalizeTurns.ts); absent when nothing. */
  repairs?: string[];
  contextPercentage: number;
  /** Tokens the context has left for the reply, after the prompt. */
  outputTokensAvailable?: number;
}

export interface AddToChatPayload {
  data: AddToChatPayloadItem[];
  /** Resources the host would not add, so the chat can say why. */
  refused?: AddToChatRefusal[];
}

export interface AddToChatPayloadItem {
  type: "file" | "folder";
  /** A URI string, read by the `file` or `folder` provider at send time. */
  fullPath: string;
  name: string;
}

export interface AddToChatRefusal {
  name: string;
  reason: "secret" | "outside-workspace" | "not-found" | "unsaved";
}

export interface MessageOption {
  precompiled: boolean;
}

/* LSP-specific interfaces. */

// See https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#symbolKind.
// We shift this one index down to match vscode.SymbolKind.
export enum SymbolKind {
  File = 0,
  Module = 1,
  Namespace = 2,
  Package = 3,
  Class = 4,
  Method = 5,
  Property = 6,
  Field = 7,
  Constructor = 8,
  Enum = 9,
  Interface = 10,
  Function = 11,
  Variable = 12,
  Constant = 13,
  String = 14,
  Number = 15,
  Boolean = 16,
  Array = 17,
  Object = 18,
  Key = 19,
  Null = 20,
  EnumMember = 21,
  Struct = 22,
  Event = 23,
  Operator = 24,
  TypeParameter = 25,
}

// See https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#symbolTag.
export namespace SymbolTag {
  export const Deprecated: 1 = 1;
}

// See https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#symbolTag.
export type SymbolTag = 1;

// See https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#documentSymbol.
export interface DocumentSymbol {
  name: string;
  detail?: string;
  kind: SymbolKind;
  tags?: SymbolTag[];
  deprecated?: boolean;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}
