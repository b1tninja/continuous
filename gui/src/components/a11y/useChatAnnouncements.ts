import type { ToolStatus } from "core";
import { renderChatMessage } from "core/util/messageContent";
import { useEffect, useRef } from "react";
import { useAppSelector } from "../../redux/hooks";
import { announce } from "./announcer";
import {
  approvalAnnouncement,
  replySummary,
  statusAnnouncement,
} from "./toolCallAnnouncement";

/**
 * Turns the chat's state into a few sentences, never one per token: once when
 * a reply starts, once with its first 200 characters when it ends, once per
 * tool call state change, and one assertive sentence when a call needs
 * approval. Mounted once, by <ChatAnnouncer/>.
 */
export function useChatAnnouncements() {
  const isStreaming = useAppSelector((s) => s.session.isStreaming);
  const history = useAppSelector((s) => s.session.history);
  const wasStreaming = useRef(false);
  const seen = useRef(new Map<string, ToolStatus>());
  const sessionId = useAppSelector((s) => s.session.id);
  const lastSession = useRef(sessionId);
  const seededFor = useRef<string | null>(null);

  useEffect(() => {
    if (lastSession.current !== sessionId) {
      lastSession.current = sessionId;
      seen.current.clear();
      wasStreaming.current = false;
    }
    if (isStreaming && !wasStreaming.current) {
      announce("Assistant is responding");
    }
    if (!isStreaming && wasStreaming.current) {
      const last = history.findLast((h) => h.message.role === "assistant");
      announce(last ? replySummary(renderChatMessage(last.message)) : "");
    }
    wasStreaming.current = isStreaming;
  }, [isStreaming, history, sessionId]);

  useEffect(() => {
    // A session that was just loaded is history, not news
    const silent = seededFor.current !== sessionId;
    seededFor.current = sessionId;
    const changed: string[] = [];
    const needApproval = [];
    for (const item of history) {
      for (const call of item.toolCallStates ?? []) {
        const before = seen.current.get(call.toolCallId);
        if (before === call.status) continue;
        seen.current.set(call.toolCallId, call.status);
        if (silent && call.status !== "generated") continue;
        if (call.status === "generated") needApproval.push(call);
        else if (before !== undefined || call.status !== "generating") {
          const s = statusAnnouncement(call);
          if (s) changed.push(s);
        }
      }
    }
    if (needApproval.length) {
      announce(approvalAnnouncement(needApproval), "assertive");
    }
    if (changed.length) announce(changed.join(". "));
  }, [history, sessionId]);
}
