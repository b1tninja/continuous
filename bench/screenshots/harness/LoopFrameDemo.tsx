// A stand-in for the loop dock, for the picture of the loop frame until the
// real dock lands: the status strip (icon and word), the Needs-you tray and
// the input, as one framed object. Only the harness mounts it (see main.tsx).
import { LoopFrame, type LoopFrameState } from "@gui/components/loop/LoopFrame";

const STRIP: Record<LoopFrameState, { icon: string; word: string }> = {
  running: { icon: "●", word: "Running · 6/12 · R3/10" },
  waiting: { icon: "||", word: "Waiting for your answer" },
  failed: { icon: "✕", word: "Item 5 failed, repairing" },
  finished: { icon: "✓", word: "Done · 12/12" },
  stopped: { icon: "■", word: "Stopped · 6/12" },
};

export function LoopFrameDemo({
  state,
  animate = false,
}: {
  state: LoopFrameState;
  animate?: boolean;
}) {
  const { icon, word } = STRIP[state];
  return (
    <div className="bg-background text-foreground min-h-screen p-2">
      <div className="text-description-muted mb-3 text-xs">
        Transcript above the dock stays plain.
      </div>
      <div className="m-1.5">
        <LoopFrame state={state} animate={animate} className="text-sm">
          <div className="flex min-w-0 items-center gap-2 px-2 py-1.5">
            <span aria-hidden="true" className="shrink-0">
              {icon}
            </span>
            <span className="truncate">{word}</span>
          </div>
          {state === "waiting" && (
            <div className="border-border border-0 border-t border-solid px-2 py-1.5">
              <div className="font-semibold">Needs you</div>
              <div className="text-description-muted">
                Which database should item 5 migrate first?
              </div>
            </div>
          )}
          <div className="border-border border-0 border-t border-solid p-1.5">
            <div className="bg-input text-input-foreground border-input-border rounded border border-solid px-2 py-1.5">
              Message the loop
            </div>
          </div>
        </LoopFrame>
      </div>
    </div>
  );
}
