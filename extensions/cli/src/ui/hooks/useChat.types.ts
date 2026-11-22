import { AssistantUnrolled, ModelConfig } from "@continuedev/config-yaml";
import { BaseLlmApi } from "@continuedev/openai-adapters";
import type { Session } from "core/index.js";

import type { AskWhy } from "../../permissions/askWhy.js";
import { QuestionRequestedEvent } from "../../services/QuizService.js";
import { ToolCallPreview } from "../../tools/types.js";

export interface UseChatProps {
  assistant?: AssistantUnrolled;
  model?: ModelConfig;
  llmApi?: BaseLlmApi;
  initialPrompt?: string;
  resume?: boolean;
  fork?: string;
  additionalRules?: string[];
  additionalPrompts?: string[];
  onShowConfigSelector: () => void;
  onShowMCPSelector: () => void;
  onShowUpdateSelector: () => void;
  onShowModelSelector?: () => void;
  onShowSessionSelector?: () => void;
  onShowJobsSelector?: () => void;
  onShowLoopInbox?: () => void;
  /** `raw`: `/export --json --raw`, the session JSON unscrubbed. */
  onShowExportSelector?: (options?: { raw?: boolean }) => void;
  onShowRewindSelector?: () => void;
  onReload?: () => Promise<void>;
  onClear?: () => void;
  onRefreshStatic?: () => void;
  // Remote mode props
  isRemoteMode?: boolean;
  remoteUrl?: string;
  onShowDiff?: (diffContent: string) => void;
  onShowStatusMessage?: (message: string) => void;
}

export interface AttachedFile {
  path: string;
  content: string;
}

export interface ActivePermissionRequest {
  toolName: string;
  toolArgs: any;
  requestId: string;
  toolCallPreview?: ToolCallPreview[];
  hasDynamicEvaluation?: boolean;
  /** Why the call asks and where that was decided */
  why?: AskWhy;
}

export type ActiveQuizQuestion = QuestionRequestedEvent;

export interface RemoteServerState {
  session: Session;
  isProcessing: boolean;
  messageQueueLength: number;
  /** What is queued, oldest first; `steer` marks what goes in this turn. */
  messageQueue?: {
    id: string;
    message: string;
    timestamp: number;
    steer: boolean;
  }[];
  messageQueuePaused?: boolean;
  steerRequested?: boolean;
  pendingPermission?: {
    toolName: string;
    toolArgs: any;
    requestId: string;
    toolCallPreview?: any[];
  };
}

export interface SlashCommandResult {
  output?: string;
  exit?: boolean;
  newInput?: string;
  clear?: boolean;
  openConfigSelector?: boolean;
  openModelSelector?: boolean;
  openMcpSelector?: boolean;
  openUpdateSelector?: boolean;
  openSessionSelector?: boolean;
  openJobsSelector?: boolean;
  openExportSelector?: boolean | { raw: boolean };
  openLoopInbox?: boolean;
  openRewindSelector?: boolean;
  compact?: boolean;
  diffContent?: string;
}
