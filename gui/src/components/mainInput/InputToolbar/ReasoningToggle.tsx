import { LightBulbIcon as LightBulbIconOutline } from "@heroicons/react/24/outline";
import { LightBulbIcon as LightBulbIconSolid } from "@heroicons/react/24/solid";
import { modelSupportsReasoning } from "core/llm/autodetect";
import { useWarmCacheNote } from "../../../hooks/useWarmCacheNote";
import { useAppDispatch, useAppSelector } from "../../../redux/hooks";
import { selectSelectedChatModel } from "../../../redux/slices/configSlice";
import { setHasReasoningEnabled } from "../../../redux/slices/sessionSlice";
import { setReasoningSetting } from "../../../redux/slices/uiSlice";
import { ToolTip } from "../../gui/Tooltip";
import { HoverButton } from "./HoverItem";
import { useToolbarWidthTier } from "./widthTier";

/**
 * The reasoning switch for the selected model, in the row under the prompt.
 * Filled bulb when on, outlined when off; the word "on" or "off" beside it
 * when the row is wide. The state is in the name and `aria-pressed`, so it
 * does not depend on the tooltip.
 */
export function ReasoningToggle() {
  const dispatch = useAppDispatch();
  const model = useAppSelector(selectSelectedChatModel);
  const enabled = useAppSelector((s) => s.session.hasReasoningEnabled);
  const tier = useToolbarWidthTier();
  // Changing the thinking settings rebuilds the message cache (measured live
  // on Bedrock)
  const warmCacheNote = useWarmCacheNote();
  if (!modelSupportsReasoning(model)) return null;
  const Icon = enabled ? LightBulbIconSolid : LightBulbIconOutline;
  const action = enabled ? "Disable model reasoning" : "Enable model reasoning";
  const state = enabled ? "on" : "off";
  return (
    <ToolTip
      place="top"
      content={action + (warmCacheNote ? ` ${warmCacheNote}` : "")}
    >
      <HoverButton
        aria-label={`Reasoning ${state}`}
        aria-pressed={!!enabled}
        data-testid="reasoning-toggle"
        className={`flex-none gap-1 [font-size:inherit] ${tier === "wide" ? "px-1" : ""}`}
        onClick={() => {
          dispatch(setHasReasoningEnabled(!enabled));
          if (model?.title) {
            dispatch(
              setReasoningSetting({
                modelTitle: model.title,
                enabled: !enabled,
              }),
            );
          }
        }}
      >
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        {tier === "wide" && (
          <span data-testid="reasoning-toggle-label">Reasoning {state}</span>
        )}
      </HoverButton>
    </ToolTip>
  );
}
