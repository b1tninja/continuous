import { promptProfile } from "core/llm/prompts/turns.js";
import {
  createSegmentDump,
  promptSegmentsEnabled,
} from "core/llm/promptSegments.js";
import type {
  ChatCompletionCreateParamsStreaming,
  ChatCompletionFunctionTool,
} from "openai/resources.mjs";

import { environmentContextBlock } from "../environmentContext.js";
import { describeCliRequest } from "../promptSegments.js";

/**
 * CONTINUE_PROMPT_SEGMENTS=1 prints one line per prompt segment of every
 * request to stderr: id, region, stability, tokens, hash8 and, on the last
 * line, which prefix segment changed since the previous request. Never the
 * contents. Read once at load: with the variable unset, `dumpPromptSegments`
 * returns at its first line and builds nothing.
 */
const dump = promptSegmentsEnabled(process.env.CONTINUE_PROMPT_SEGMENTS)
  ? createSegmentDump((line) => process.stderr.write(`${line}\n`))
  : undefined;

export function dumpPromptSegments(args: {
  body: ChatCompletionCreateParamsStreaming;
  systemMessage: string;
  tools?: ChatCompletionFunctionTool[];
  taskListBlock?: string;
  turnTail?: string;
  isCompacting?: boolean;
}): void {
  if (!dump) return;
  const { body, taskListBlock } = args;
  dump(`model=${body.model} compaction=${!!args.isCompacting}`, () =>
    describeCliRequest({
      systemMessage: args.systemMessage,
      tools: args.tools ?? [],
      environmentBlock: environmentContextBlock(),
      taskListBlock,
      turnTail: args.turnTail,
      profile: promptProfile(body.model),
      history: taskListBlock
        ? body.messages.slice(1, -1)
        : body.messages.slice(1),
    }),
  );
}
