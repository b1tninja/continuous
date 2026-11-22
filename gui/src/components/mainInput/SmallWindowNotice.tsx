import { useContext, useState } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useSmallWindowCost } from "../../hooks/useSmallWindowCost";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { leaveLoopMode } from "../../redux/thunks/loop";
import {
  buildUpdate,
  draftFromConfig,
  setPrompt,
} from "../../util/modeModelsDraft";
import { smallWindowLine } from "../../util/smallWindow";
import { NoticeAction, NoticeBar } from "./NoticeBar";

/** Chat sessions whose line was dismissed, for the life of the webview. */
const dismissedSessions = new Set<string>();

/** For tests: show the line again in every session. */
export function resetSmallWindowNoticeForTests(): void {
  dismissedSessions.clear();
}

/**
 * One line above the input when the tools and the system message of the
 * current mode take more than half of the model's room for input: an 8,192
 * window in Agent mode is mostly spent before the first message, and nothing
 * else says that Chat mode costs no tool tokens. Once per chat session.
 */
export function SmallWindowNotice() {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const sessionId = useAppSelector((s) => s.session.id);
  const mode = useAppSelector((s) => s.session.mode);
  const config = useAppSelector((s) => s.config.config);
  const [, setDismissed] = useState(0);
  const [failed, setFailed] = useState(false);

  const dismissed = dismissedSessions.has(sessionId);
  const found = useSmallWindowCost({ enabled: !dismissed });
  if (!found || dismissed) return null;
  const { cost, shortPromptMode } = found;

  async function setShortPrompt(turn: "agent" | "plan") {
    const loaded = draftFromConfig(config);
    const update = buildUpdate(loaded, {
      ...loaded,
      [turn]: setPrompt(loaded[turn], "short"),
    });
    try {
      const res = await ideMessenger.request("config/setModeModels", update);
      setFailed(!(res.status === "success" && res.content.saved));
    } catch {
      setFailed(true);
    }
  }

  return (
    <NoticeBar
      testId="small-window-notice"
      onDismiss={() => {
        dismissedSessions.add(sessionId);
        setDismissed((n) => n + 1);
      }}
    >
      <span>
        {smallWindowLine(cost)}
        {failed &&
          shortPromptMode &&
          ` Could not edit the config. Add \`prompt: short\` under modeModels.${shortPromptMode} in config.yaml.`}
      </span>
      {mode !== "chat" && (
        <NoticeAction
          testId="small-window-chat-mode"
          title="Chat mode sends no tool definitions"
          onClick={() => void dispatch(leaveLoopMode("chat"))}
        >
          Chat mode
        </NoticeAction>
      )}
      {shortPromptMode && !failed && (
        <NoticeAction
          testId="small-window-short-prompt"
          title={`Sets modeModels.${shortPromptMode}.prompt to short in config.yaml: the same rules in about a third of the text`}
          onClick={() => void setShortPrompt(shortPromptMode)}
        >
          Use the short prompt
        </NoticeAction>
      )}
    </NoticeBar>
  );
}
