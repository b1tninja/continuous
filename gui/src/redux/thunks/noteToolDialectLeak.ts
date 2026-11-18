import { renderChatMessage } from "core/util/messageContent";
import {
  detectToolDialectLeak,
  providerRecoversText,
} from "core/util/toolDialectLeak";
import { ollamaBaseFor } from "core/util/ollamaShowHint";
import type { IIdeMessenger } from "../../context/IdeMessenger";
import { selectSelectedChatModel } from "../slices/configSlice";
import { noteToolDialectLeak } from "../slices/sessionSlice";
import type { AppDispatch, RootState } from "../store";

/**
 * After a reply: if the selected model wrote a tool call as text (outside any
 * code fence) and recovery is not set for it, record it so the notice shows
 * once. Warns only; nothing is changed here.
 */
export async function checkToolDialectLeak(
  state: RootState,
  dispatch: AppDispatch,
  ideMessenger?: IIdeMessenger,
): Promise<void> {
  const model = selectSelectedChatModel(state);
  if (!model || !providerRecoversText(model.provider)) return;
  const last = state.session.history.at(-1)?.message;
  if (last?.role !== "assistant") return;
  const leak = detectToolDialectLeak({
    content: renderChatMessage(last),
    toolCalls: last.toolCalls?.map((c) => ({
      id: c.id,
      name: c.function?.name ?? "",
      arguments: c.function?.arguments ?? "",
    })),
    current: model.toolDialect,
    model: model.model,
  });
  if (!leak) return;
  // An Ollama server that parses this model's calls itself: not a leak.
  if (ollamaBaseFor(model.provider, model.apiBase) && ideMessenger) {
    try {
      const res = await ideMessenger.request("ollama/showHint", {
        provider: model.provider,
        apiBase: model.apiBase,
        model: model.model,
      });
      if (res.status === "success" && res.content.serverParses) return;
    } catch {
      // no hint: the notice stays
    }
  }
  dispatch(noteToolDialectLeak({ model: model.title, dialect: leak.dialect }));
}
