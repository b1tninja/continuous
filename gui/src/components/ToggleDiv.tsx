import { ChevronDownIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import { ComponentType, useState } from "react";
import { vscBackground } from ".";
import { useKeptOpenState } from "../hooks/useKeptOpenState";

interface ToggleProps {
  children: React.ReactNode;
  title: React.ReactNode;
  icon?: ComponentType<React.SVGProps<SVGSVGElement>>;
  testId?: string;
  defaultOpen?: boolean;
  /** Names this toggle within its transcript row, so its state is kept. */
  keptAs?: string;
}

function ToggleDiv({
  children,
  title,
  icon: Icon,
  testId = "context-items-peek",
  defaultOpen = false,
  keptAs,
}: ToggleProps) {
  const [open, setOpen] = useKeptOpenState(keptAs, defaultOpen);
  const [isHovered, setIsHovered] = useState(false);

  return (
    <div
      className={`pl-2`}
      style={{
        backgroundColor: vscBackground,
      }}
    >
      <div
        className="flex cursor-pointer items-center justify-start text-xs text-description hover:brightness-125"
        onClick={() => setOpen(!open)}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        data-testid={testId}
      >
        <div className="relative h-4 w-4">
          {Icon && !isHovered && !open ? (
            <Icon className="absolute h-4 w-4" />
          ) : (
            <>
              <ChevronRightIcon
                className={`absolute h-4 w-4 transition-all duration-200 ease-in-out ${
                  open ? "rotate-90 opacity-0" : "rotate-0 opacity-100"
                }`}
              />
              <ChevronDownIcon
                className={`absolute h-4 w-4 transition-all duration-200 ease-in-out ${
                  open ? "rotate-0 opacity-100" : "-rotate-90 opacity-0"
                }`}
              />
            </>
          )}
        </div>
        <span className="ml-1 text-xs transition-colors duration-200">
          {title}
        </span>
      </div>

      <div
        className={`mt-2 overflow-y-auto transition-all duration-300 ease-in-out ${
          open ? "max-h-[50vh] opacity-100" : "max-h-0 opacity-0"
        }`}
      >
        {children}
      </div>
    </div>
  );
}

export default ToggleDiv;
