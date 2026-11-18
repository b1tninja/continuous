/**
 * The visible result of a drop when something was refused or needs a word
 * (a folder is a search scope). It is not a live region: the same sentence is
 * announced once through `announce()`, so a screen reader hears it once.
 */
export function DropNotice(props: { text: string; onDismiss: () => void }) {
  return (
    <div
      data-testid="chat-drop-notice"
      className="mt-1 flex items-start gap-1 text-xs text-description"
    >
      <span className="min-w-0 flex-1 break-words">{props.text}</span>
      <button
        type="button"
        aria-label="Dismiss drop result"
        onClick={(e) => {
          e.stopPropagation();
          props.onDismiss();
        }}
        className="min-h-6 min-w-6 flex-none cursor-pointer border-none bg-transparent px-2 text-xs text-description hover:text-foreground"
      >
        Dismiss
      </button>
    </div>
  );
}
