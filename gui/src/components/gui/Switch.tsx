import { InformationCircleIcon } from "@heroicons/react/24/outline";
import React, { ReactNode } from "react";
import { vscButtonBackground } from "..";
import { ToolTip } from "./Tooltip";

type ToggleSwitchProps = {
  isToggled: boolean;
  onToggle: () => void;
  text: string;
  size?: number;
  showIfToggled?: ReactNode;
  disabled?: boolean;
  tooltip?: string;
};

const ToggleSwitch: React.FC<ToggleSwitchProps> = ({
  isToggled,
  onToggle,
  text,
  size = 16,
  showIfToggled,
  disabled = false,
  tooltip,
}) => {
  return (
    <div
      className={`flex items-center justify-between gap-3 select-none ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
    >
      <span className="truncate-right flex items-center gap-x-1">
        {text}{" "}
        {tooltip && (
          <ToolTip content={tooltip}>
            <InformationCircleIcon className="h-3 w-3" />
          </ToolTip>
        )}
      </span>
      <div className="flex flex-row items-center gap-1">
        {isToggled && !!showIfToggled && showIfToggled}
        {/* A real switch: reachable with Tab and worked with Space or Enter.
            It was a div, which a keyboard could not reach at all. */}
        <button
          type="button"
          role="switch"
          aria-checked={isToggled}
          aria-label={text}
          disabled={disabled}
          // text-inherit: a button has its own text colour, and the knob's border takes it
          className="relative box-content flex cursor-[inherit] items-center rounded-full border border-solid border-command-border bg-vsc-input-background text-inherit"
          onClick={
            disabled
              ? undefined
              : (e) => {
                  e.stopPropagation();
                  onToggle();
                }
          }
          style={{
            height: size,
            width: size * 2,
            padding: size / 8,
          }}
        >
          <div
            className={`absolute left-1/4 transform rounded-full border-[0.2px] border-solid transition-all ${isToggled ? "translate-x-1/2 brightness-150" : "-translate-x-1/2 brightness-75"}`}
            style={{
              backgroundColor: isToggled ? vscButtonBackground : "",
              height: size,
              width: size,
            }}
          />
        </button>
      </div>
    </div>
  );
};

export default ToggleSwitch;
