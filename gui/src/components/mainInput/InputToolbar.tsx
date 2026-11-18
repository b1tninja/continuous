import { InputModifiers } from "core";
import { memo, useContext, useRef } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { selectUseActiveFile } from "../../redux/selectors";
import { exitEdit } from "../../redux/thunks/edit";
import { getMetaKeyLabel, isMetaEquivalentKeyPressed } from "../../util";
import { ToolTip } from "../gui/Tooltip";
import ModelSelect from "../modelSelection/ModelSelect";
import { Button } from "../ui";
import { useFontSize } from "../ui/font";
import { CacheTipsButton } from "./CacheTipsButton";
import { ContextMeter } from "./ContextMeter";
import { ModelRetirementChip } from "./ModelRetirementChip";
import { ModelToolChip } from "./ModelToolChip";
import HoverItem, { HoverButton } from "./InputToolbar/HoverItem";
import { ReasoningToggle } from "./InputToolbar/ReasoningToggle";
import { ToolbarWidthContext, useWidthTier } from "./InputToolbar/widthTier";
import { PromptCacheButton } from "./PromptCacheButton";
import { UsageIndicator } from "./UsageIndicator";

export interface ToolbarOptions {
  hideUseCodebase?: boolean;
  hideImageUpload?: boolean;
  hideAddContext?: boolean;
  enterText?: string;
  hideSelectModel?: boolean;
}

interface InputToolbarProps {
  onEnter?: (modifiers: InputModifiers) => void;
  onClick?: () => void;
  hidden?: boolean;
  activeKey: string | null;
  toolbarOptions?: ToolbarOptions;
  disabled?: boolean;
  isMainInput?: boolean;
}

function InputToolbar(props: InputToolbarProps) {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const useActiveFile = useAppSelector(selectUseActiveFile);
  const isInEdit = useAppSelector((store) => store.session.isInEdit);
  const codeToEdit = useAppSelector((store) => store.editModeState.codeToEdit);
  const isEnterDisabled =
    props.disabled || (isInEdit && codeToEdit.length === 0);

  const smallFont = useFontSize(-2);
  const tinyFont = useFontSize(-3);

  // The row's own width picks what each control shows; nothing in the status
  // group is ever moved into a menu. See plans/research/status-row-layout.md.
  const rowRef = useRef<HTMLDivElement>(null);
  const tier = useWidthTier(rowRef);

  return (
    <ToolbarWidthContext.Provider value={tier}>
      <div
        ref={rowRef}
        onClick={props.onClick}
        // Hidden controls must not be Tab stops
        inert={props.hidden}
        data-testid="input-toolbar"
        data-width-tier={tier}
        // Wraps rather than hides: when even the shortest status does not
        // fit beside a truncated model name, it moves to a second line.
        className={`find-widget-skip flex flex-row flex-wrap items-center justify-between gap-x-1 bg-vsc-input-background pt-1 select-none ${props.hidden ? "pointer-events-none h-0 cursor-default opacity-0" : "pointer-events-auto mt-2 cursor-text opacity-100"}`}
        style={{
          fontSize: smallFont,
        }}
      >
        <div
          className={`flex min-w-12 flex-1 basis-12 flex-row items-center ${tier === "wide" ? "max-w-[45%]" : ""}`}
        >
          <ToolTip place="top" content="Select Model">
            <HoverItem className="min-w-0 !p-0">
              <ModelSelect />
            </HoverItem>
          </ToolTip>
          {!isInEdit && <ModelToolChip />}
          {!isInEdit && <ModelRetirementChip />}
        </div>

        <div
          data-testid="input-status-group"
          // Never shrinks into a menu: on its own line in a very narrow
          // panel it wraps its items instead.
          className={`flex max-w-full flex-wrap items-center justify-end whitespace-nowrap text-description ${tier === "narrow" ? "gap-0.5" : "gap-1.5"}`}
          style={{
            fontSize: tinyFont,
          }}
        >
          {!isInEdit && <ContextMeter />}
          <UsageIndicator />
          <ReasoningToggle />
          <PromptCacheButton />
          <CacheTipsButton />
          {!props.toolbarOptions?.hideUseCodebase &&
            !isInEdit &&
            tier === "wide" && (
              <div className="flex transition-colors duration-200 hover:underline">
                <HoverButton
                  data-testid="active-file-button"
                  aria-label={`${getMetaKeyLabel()}⏎ ${
                    useActiveFile ? "No active file" : "Active file"
                  }`}
                  className={`px-1 text-2xs ${
                    props.activeKey === "Meta" ||
                    props.activeKey === "Control" ||
                    props.activeKey === "Alt"
                      ? "underline"
                      : ""
                  }`}
                  onClick={() =>
                    props.onEnter?.({
                      useCodebase: false,
                      noContext: !useActiveFile,
                    })
                  }
                >
                  <ToolTip
                    place="top-end"
                    content={`${
                      useActiveFile
                        ? "Send Without Active File"
                        : "Send With Active File"
                    } (${getMetaKeyLabel()}⏎)`}
                  >
                    <span>
                      {getMetaKeyLabel()}⏎{" "}
                      {useActiveFile ? "No active file" : "Active file"}
                    </span>
                  </ToolTip>
                </HoverButton>
              </div>
            )}
          {isInEdit && (
            <HoverButton
              aria-label="Esc to exit Edit"
              className={`px-1 text-2xs hover:underline ${tier === "narrow" ? "hidden" : "inline-flex"}`}
              onClick={async () => {
                void dispatch(exitEdit({}));
                ideMessenger.post("focusEditor", undefined);
              }}
            >
              <span>
                <i>Esc</i> to exit Edit
              </span>
            </HoverButton>
          )}
          <ToolTip place="top" content="Send (⏎)">
            <Button
              variant={props.isMainInput ? "primary" : "secondary"}
              size="sm"
              data-testid="submit-input-button"
              onClick={async (e) => {
                if (props.onEnter) {
                  props.onEnter({
                    useCodebase: false,
                    noContext: useActiveFile
                      ? isMetaEquivalentKeyPressed(e as any) || e.altKey
                      : !(isMetaEquivalentKeyPressed(e as any) || e.altKey),
                  });
                }
              }}
              disabled={isEnterDisabled}
            >
              {tier === "wide" ? (
                <span>⏎ {props.toolbarOptions?.enterText ?? "Enter"}</span>
              ) : (
                <>
                  <span aria-hidden="true">⏎</span>
                  <span className="sr-only">
                    {props.toolbarOptions?.enterText ?? "Enter"}
                  </span>
                </>
              )}
            </Button>
          </ToolTip>
        </div>
      </div>
    </ToolbarWidthContext.Provider>
  );
}

function shallowToolbarOptionsEqual(a?: ToolbarOptions, b?: ToolbarOptions) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.hideAddContext === b.hideAddContext &&
    a.hideImageUpload === b.hideImageUpload &&
    a.hideUseCodebase === b.hideUseCodebase &&
    a.hideSelectModel === b.hideSelectModel &&
    a.enterText === b.enterText
  );
}

export default memo(
  InputToolbar,
  (prev, next) =>
    prev.hidden === next.hidden &&
    prev.disabled === next.disabled &&
    prev.isMainInput === next.isMainInput &&
    prev.activeKey === next.activeKey &&
    shallowToolbarOptionsEqual(prev.toolbarOptions, next.toolbarOptions),
);
