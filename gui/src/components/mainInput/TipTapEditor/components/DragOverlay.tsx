import React from "react";
import styled from "styled-components";
import {
  vscBadgeBackground,
  vscFocusBorder,
  vscForeground,
  vscInputBackground,
} from "../../..";

const Target = styled.div`
  position: absolute;
  inset: 0;
  z-index: 10;
  /* Never take the drop: it must reach the input underneath. */
  pointer-events: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 4px 8px;
  text-align: center;
  border: 2px dashed ${vscFocusBorder};
  border-radius: inherit;
  background-color: color-mix(
    in srgb,
    ${vscBadgeBackground} 35%,
    ${vscInputBackground}
  );
  color: ${vscForeground};
  /* No animation, so there is nothing to turn off for reduced motion. */
  transition: none;

  @media (forced-colors: active) {
    border-color: Highlight;
    background-color: Canvas;
    color: CanvasText;
  }
`;

interface DragOverlayProps {
  show: boolean;
  /** A host-specific line, such as the VS Code Shift rule. */
  hint?: string | null;
}

/**
 * The visible drop target. It is `aria-hidden`: a drag has no screen reader
 * user, and the result of a drop is announced once by the drop handler.
 */
export const DragOverlay: React.FC<DragOverlayProps> = ({ show, hint }) => {
  if (!show) return null;
  return (
    <Target aria-hidden="true" data-testid="chat-drop-target">
      <span className="font-medium">Drop to add context</span>
      {hint ? <span className="text-xs">{hint}</span> : null}
    </Target>
  );
};
