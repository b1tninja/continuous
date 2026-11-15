import { toolChangeWarning } from "core/tools/toolListHold";
import { formatRereadCost } from "../util/cacheNotices";
import { useToolListHold } from "./useToolListHold";
import { useWarmCacheNote } from "./useWarmCacheNote";

/**
 * A sentence for the controls that change the tool list (a tool's policy, a
 * group switch, an MCP server's Disconnect or Reload): while the prompt cache
 * is warm and the re-read is significant, what applying the change costs and
 * that it waits. With the wait turned off, what applying it costs (the
 * general warm-cache note). Empty when nothing is at stake.
 */
export function useToolChangeNote(): string {
  const { waits, loss, dropsThinking } = useToolListHold();
  const warmNote = useWarmCacheNote();
  if (!waits || !loss) return warmNote;
  return `${toolChangeWarning(formatRereadCost(loss), dropsThinking)} The change waits until the cache goes cold unless you apply it now.`;
}
