import { ArrowDownIcon } from "@heroicons/react/24/outline";
import { Button } from "../../components/ui";
import { useMainEditor } from "../../components/mainInput/TipTapEditor";

interface JumpToLatestProps {
  /** True while the person has scrolled up and auto-scroll is paused. */
  paused: boolean;
  scrollToLatest: () => void;
}

/**
 * Appears below the transcript while auto-scroll is paused. It sits in the tab
 * order right after the transcript and is a real button, so Enter and Space
 * work. Activating it scrolls to the end (without animation under reduced
 * motion) and hands focus to the chat input, since the button goes away.
 * The "new messages" sentence is spoken by the announcer, once per pause, from
 * useAutoScroll; this component adds no live region.
 */
export function JumpToLatest({ paused, scrollToLatest }: JumpToLatestProps) {
  const editor = useMainEditor();
  if (!paused) return null;
  return (
    <div className="relative h-0 shrink-0">
      <Button
        variant="secondary"
        size="sm"
        className="absolute right-3 bottom-1 z-10 m-0 flex min-h-6 min-w-6 items-center gap-1 shadow-md"
        data-testid="jump-to-latest"
        onClick={() => {
          scrollToLatest();
          editor.mainEditor?.commands.focus();
        }}
      >
        <ArrowDownIcon className="h-3 w-3" aria-hidden="true" />
        <span>Jump to latest</span>
      </Button>
    </div>
  );
}
