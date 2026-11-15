/**
 * Under the input when an unsent draft came back (useDraftPersistence). A
 * status, so a screen reader hears it once without moving focus.
 */
export function DraftRestoredNotice(props: {
  text: string;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      data-testid="draft-restored-notice"
      className="mt-1 flex items-start gap-1 text-xs text-description"
    >
      <span className="min-w-0 flex-1 break-words">{props.text}</span>
      <button
        type="button"
        aria-label="Dismiss restored message notice"
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
