import {
  Children,
  cloneElement,
  isValidElement,
  CSSProperties,
  ReactElement,
  ReactNode,
  useId,
} from "react";
import ReactDOM from "react-dom";
import { ITooltip, Tooltip } from "react-tooltip";
import { vscBackground, vscForeground } from "..";
import { varWithFallback } from "../../styles/theme";
import { fontSize } from "../../util";

// Needed to override styles in react-tooltip
const TooltipStyles: CSSProperties = {
  fontSize: fontSize(-4),
  backgroundColor: vscBackground,
  outline: `0.5px solid ${varWithFallback("description")}`,
  color: vscForeground,
  padding: "4px 8px",
  zIndex: 1000,
  maxWidth: "80vw",
  textAlign: "center",
};

/**
 * A button that holds only an icon has no name; its tooltip text is the name a
 * screen reader should hear. Nothing is added to a child that has a name, text
 * of its own, or is not a button.
 */
/** Whether a React subtree holds text (so the button already has a name). */
function hasText(node: ReactNode): boolean {
  return Children.toArray(node).some(
    (c) =>
      typeof c === "string" ||
      typeof c === "number" ||
      (isValidElement(c) &&
        typeof c.type === "string" &&
        hasText((c.props as { children?: ReactNode }).children)),
  );
}

function nameFromTooltip(
  child: ReactElement<ChildProps>,
  content: ReactNode,
): { "aria-label"?: string } {
  if (typeof content !== "string" || !content.trim()) return {};
  const { props, type } = child;
  const isButton =
    type === "button" ||
    (typeof type !== "string" &&
      /button/i.test((type as { displayName?: string }).displayName ?? ""));
  if (!isButton || props["aria-label"] || props["aria-labelledby"]) return {};
  return hasText(props.children) ? {} : { "aria-label": content };
}

type ChildProps = {
  "data-tooltip-id"?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  children?: ReactNode;
};

export function ToolTip({
  children,
  content,
  ...props
}: Omit<ITooltip, "id" | "children" | "content"> & {
  content: ITooltip["children"];
  children: ReactElement<ChildProps>;
}) {
  const tooltipId = useId();

  const combinedStyles = {
    ...TooltipStyles,
    ...props.style,
  };

  const tooltipPortalDiv = document.getElementById("tooltip-portal-div");

  const childrenWithTooltipId = cloneElement(children, {
    "data-tooltip-id": tooltipId,
    ...nameFromTooltip(children, content),
  });

  return (
    <>
      {childrenWithTooltipId}
      {tooltipPortalDiv &&
        ReactDOM.createPortal(
          <Tooltip
            {...props}
            id={tooltipId}
            noArrow
            style={combinedStyles}
            opacity={1}
            delayShow={200}
          >
            {content}
          </Tooltip>,
          tooltipPortalDiv,
        )}
    </>
  );
}
