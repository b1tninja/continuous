// src/components/ThinkingBlockPeek.tsx
import { ChevronDownIcon } from "@heroicons/react/24/outline";
import { ChevronUpIcon } from "@heroicons/react/24/solid";
import { ChatHistoryItem } from "core";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import styled from "styled-components";

import { useAppSelector } from "../../../redux/hooks";
import { AnimatedEllipsis } from "../../AnimatedEllipsis";
import StyledMarkdownPreview from "../../StyledMarkdownPreview";
import { Button } from "../../ui";

const MarkdownWrapper = styled.div`
  & > div > *:first-child {
    margin-top: 0 !important;
  }
`;

/** How close to the bottom (px) still counts as following the stream. */
const FOLLOW_SLACK_PX = 24;

interface ThinkingBlockPeekProps {
  content: string;
  redactedThinking?: string;
  index: number;
  prevItem: ChatHistoryItem | null;
  inProgress?: boolean;
  signature?: string;
  tokens?: number;
  /** When the thinking started and ended (ms), if the caller knows. */
  startAt?: number;
  endAt?: number;
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * The model's thinking. While it streams it is open and follows the newest
 * text (unless the person scrolls up to read); once the answer starts it
 * folds to one line, "Thought for 4.2s", which opens it again.
 * `ui.keepThinkingExpanded` leaves it open. Toggling it by hand wins over both
 * for this block.
 */
function ThinkingBlockPeek({
  content,
  redactedThinking,
  index,
  prevItem,
  inProgress,
  tokens,
  startAt,
  endAt,
}: ThinkingBlockPeekProps) {
  const keepExpanded = useAppSelector(
    (state) => state.config.config.ui?.keepThinkingExpanded === true,
  );
  // null: follow the stream (open while thinking, folded after it)
  const [chosenOpen, setChosenOpen] = useState<boolean | null>(null);
  const open = chosenOpen ?? (!!inProgress || keepExpanded);

  const startedRef = useRef<number | null>(inProgress ? Date.now() : null);
  const [measured, setMeasured] = useState<number | null>(null);
  useEffect(() => {
    if (inProgress) {
      startedRef.current ??= Date.now();
      setMeasured(null);
    } else if (startedRef.current !== null) {
      setMeasured(Date.now() - startedRef.current);
      startedRef.current = null;
    }
  }, [inProgress]);
  const elapsedMs =
    startAt !== undefined && endAt !== undefined ? endAt - startAt : measured;

  // Follow the newest text while it streams, unless scrolled away from it
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !open || !inProgress || !followRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [content, open, inProgress]);

  const duplicateRedactedThinkingBlock =
    prevItem &&
    prevItem.message.role === "thinking" &&
    redactedThinking &&
    prevItem.message.redactedThinking;

  if (duplicateRedactedThinkingBlock) return null;

  const label = inProgress ? (
    <span>
      {redactedThinking ? "Redacted Thinking" : "Thinking"}
      <AnimatedEllipsis />
    </span>
  ) : redactedThinking ? (
    "Redacted Thinking"
  ) : (
    "Thought" +
    (elapsedMs !== null && elapsedMs >= 0
      ? ` for ${formatSeconds(elapsedMs)}`
      : "") +
    (tokens ? ` (${tokens} tokens)` : "")
  );

  const contentId = `thinking-block-content-${index}`;

  return (
    <div className="thread-message">
      <div className="mt-1 flex flex-col px-4">
        <div>
          <Button
            variant="outline"
            className="m-0 mb-2 flex min-w-0 flex-0 cursor-pointer flex-row items-center gap-1.5 rounded-full border-[0.5px] border-solid border-border px-3 text-xs text-description transition-colors duration-200 ease-in-out hover:brightness-125"
            data-testid="thinking-block-peek"
            aria-expanded={open}
            aria-controls={contentId}
            onClick={() => setChosenOpen(!open)}
          >
            {label}
            {open ? (
              <ChevronUpIcon className="h-3 w-3" />
            ) : (
              <ChevronDownIcon className="h-3 w-3" />
            )}
          </Button>
        </div>
        <div
          id={contentId}
          ref={scrollRef}
          data-testid="thinking-block-content"
          hidden={!open}
          onScroll={(e) => {
            const el = e.currentTarget;
            followRef.current =
              el.scrollHeight - el.scrollTop - el.clientHeight <=
              FOLLOW_SLACK_PX;
          }}
          className="mb-2 max-h-[50vh] overflow-y-auto border-0 border-l-2 border-solid border-border pl-3 text-description"
        >
          {redactedThinking ? (
            <div className="text-xs italic">
              Thinking content redacted due to safety reasons.
            </div>
          ) : (
            <MarkdownWrapper>
              <StyledMarkdownPreview
                isRenderingInStepContainer
                source={content}
                itemIndex={index}
              />
            </MarkdownWrapper>
          )}
        </div>
      </div>
    </div>
  );
}

export default ThinkingBlockPeek;
