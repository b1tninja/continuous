import type { ReactNode } from "react";

/**
 * A one-line, dismissible notice above the chat input. Notices here never
 * block sending: they say what is about to cost money and offer a cheaper way.
 */
export function NoticeBar(props: {
  testId: string;
  onDismiss: () => void;
  children: ReactNode;
}) {
  return (
    <div
      role="status"
      data-testid={props.testId}
      className="mx-1 mb-1 flex flex-wrap items-center gap-x-1 gap-y-0 rounded border border-solid border-border bg-transparent py-0.5 pl-2 text-xs text-description"
    >
      {props.children}
      <button
        type="button"
        data-testid={`${props.testId}-dismiss`}
        aria-label="Dismiss"
        onClick={props.onDismiss}
        className="ml-auto min-h-6 cursor-pointer border-none bg-transparent px-2 text-xs text-description hover:text-foreground"
      >
        Dismiss
      </button>
    </div>
  );
}

export function NoticeAction(props: {
  testId: string;
  title?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={props.testId}
      title={props.title}
      onClick={props.onClick}
      className="min-h-6 cursor-pointer border-none bg-transparent px-2 text-xs text-link underline hover:brightness-125"
    >
      {props.children}
    </button>
  );
}
