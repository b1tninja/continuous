import { Toolbox } from "../Toolbox/Toolbox";
import {
  isInlineToolbarKind,
  LumpToolbar,
  useLumpToolbarKind,
} from "./LumpToolbar/LumpToolbar";
import { SessionControls } from "./SessionControls";

/**
 * The row above the input: the session controls (mode, permission policy), the
 * state toolbar and the toolbox glyph. A one-line toolbar shares the row with
 * the session controls and drops below them only when the panel is too narrow;
 * a block toolbar (pending tool calls, edits) always takes the full width.
 */
export function Lump() {
  const inline = isInlineToolbarKind(useLumpToolbarKind());

  return (
    <div className="relative mx-1.5 rounded-t-default bg-input">
      <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 px-1 py-0.5 xs:px-2">
        <SessionControls />
        <div
          className={`flex min-w-0 flex-col ${inline ? "order-2 grow basis-32" : "order-4 basis-full"}`}
        >
          <LumpToolbar />
        </div>
        <div className="order-3 ml-auto shrink-0">
          <Toolbox />
        </div>
      </div>
    </div>
  );
}
