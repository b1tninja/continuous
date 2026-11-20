import { modelSupportsReasoning } from "core/llm/autodetect";
import { useContext, useRef } from "react";
import { IdeMessengerContext } from "../../../context/IdeMessenger";
import { useWarmCacheNote } from "../../../hooks/useWarmCacheNote";
import { useAppDispatch, useAppSelector } from "../../../redux/hooks";
import { selectModelUse } from "../../../redux/selectors/selectModelUse";
import { updateConfig } from "../../../redux/slices/configSlice";
import { setHasReasoningEnabled } from "../../../redux/slices/sessionSlice";
import { setReasoningSetting } from "../../../redux/slices/uiSlice";
import { sessionReasoningAfterConfig } from "../../../util/sessionReasoning";
import {
  applyThinkingEffort,
  parseThinkingEffort,
  THINKING_EFFORTS,
} from "../../../util/thinkingEffort";
import { ToolTip } from "../../gui/Tooltip";
import { useToolbarWidthTier } from "./widthTier";

/**
 * Thinking level for the current mode, next to the model. It writes
 * `modeModels.<use>.reasoningEffort` through `config/setModeModels`, the same
 * field the mode table writes, then clears the bulb's session override so
 * that field is what the next request sends. Hidden when this model has no
 * thinking setting (`modelSupportsReasoning`, the same check as the bulb).
 */
export function ThinkingEffort() {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const model = useAppSelector((s) => s.config.config.selectedModelByRole.chat);
  const config = useAppSelector((s) => s.config.config);
  const modelUse = useAppSelector(selectModelUse);
  const hasReasoningEnabled = useAppSelector(
    (s) => s.session.hasReasoningEnabled,
  );
  const storedToggle = useAppSelector((s) =>
    model?.title ? s.ui.reasoningSettings[model.title] : undefined,
  );
  const tier = useToolbarWidthTier();
  const warmCacheNote = useWarmCacheNote();
  const requestSeq = useRef(0);

  if (!modelUse || !modelSupportsReasoning(model)) return null;

  const value = config.modeModels?.[modelUse]?.reasoningEffort ?? "";
  const tip =
    "Thinking effort for this mode" +
    (warmCacheNote ? `. ${warmCacheNote}` : "");

  async function onChange(raw: string) {
    const effort = parseThinkingEffort(raw);
    const applied = applyThinkingEffort(
      config.modeModels,
      modelUse,
      effort,
      model?.title,
    );
    const previousConfig = config;
    const previousEnabled = hasReasoningEnabled;
    const previousStored = storedToggle;
    const seq = ++requestSeq.current;

    dispatch(
      updateConfig({
        ...config,
        modeModels: applied.modeModels,
      }),
    );
    if (model?.title) {
      dispatch(
        setReasoningSetting({ modelTitle: model.title, enabled: undefined }),
      );
    }
    const flag = sessionReasoningAfterConfig({
      supportsReasoning: modelSupportsReasoning(model),
      reasoningDisabledOnModel: model?.completionOptions?.reasoning === false,
      storedToggle: undefined,
      modeEffort: effort,
    });
    dispatch(setHasReasoningEnabled(flag));

    let saved = false;
    try {
      const result = await ideMessenger.request(
        "config/setModeModels",
        applied.update,
      );
      saved = result.status === "success" && result.content.saved;
    } catch {
      saved = false;
    }
    if (seq !== requestSeq.current) return;
    if (saved) {
      dispatch(setHasReasoningEnabled(flag));
      return;
    }
    dispatch(updateConfig(previousConfig));
    dispatch(setHasReasoningEnabled(previousEnabled));
    if (model?.title) {
      dispatch(
        setReasoningSetting({
          modelTitle: model.title,
          enabled: previousStored,
        }),
      );
    }
  }

  return (
    <ToolTip place="top" content={tip}>
      <label className="flex shrink-0 items-center gap-0.5">
        <span className={tier === "wide" ? "text-description" : "sr-only"}>
          Thinking
        </span>
        <select
          aria-label="Thinking"
          data-testid="thinking-effort"
          value={value}
          onChange={(e) => void onChange(e.target.value)}
          className="h-6 cursor-pointer border-none bg-transparent py-0 pr-0 pl-0.5 [font-size:inherit] text-description outline-none"
        >
          {THINKING_EFFORTS.map((o) => (
            <option key={o.value || "default"} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    </ToolTip>
  );
}
