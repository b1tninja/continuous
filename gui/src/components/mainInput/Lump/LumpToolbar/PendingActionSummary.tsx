import { maskCommandForDisplay } from "core/tools/permissions/displayMask";
import { useId, useState } from "react";
import { describeAction } from "./actionSummary";
import { hiddenNote, revealHidden } from "./hiddenCharacters";

/** Lines in sight before "Show full ..." is offered; the whole text is always in the page. */
const VISIBLE_LINES = 6;
const LONG_TEXT = 400;

type ToolShape = Parameters<typeof describeAction>[2];

export interface PendingActionSummaryProps {
  /** The element id the Accept and Reject buttons point at with aria-describedby. */
  id: string;
  toolName: string;
  args: unknown;
  tool?: ToolShape;
  /** Why the call waits or was refused, in full. */
  note?: string;
  rule?: string;
  testId: string;
}

/**
 * What a person is approving, in full: the kind of action, the exact command,
 * edit, URL or MCP arguments, and the paths it names, with the reason it is
 * asking written out (never cut). A long payload stays complete in the page,
 * scrolls in its own box and can be opened to its full height.
 */
export function PendingActionSummary({
  id,
  toolName,
  args,
  tool,
  note,
  rule,
  testId,
}: PendingActionSummaryProps) {
  const summary = describeAction(toolName, args, tool);
  const [open, setOpen] = useState(false);
  const blockId = useId();
  // Every string of the call goes through this before it is drawn, so a
  // character that draws as nothing, or reorders the text, is in sight.
  let hidden = 0;
  const shown = (text: string) => {
    const revealed = revealHidden(text);
    hidden += revealed.count;
    return revealed.text;
  };
  const block = summary.block && {
    ...summary.block,
    text: shown(summary.block.text),
  };
  const fields = summary.fields.map((f) => ({ ...f, value: shown(f.value) }));
  const paths = summary.paths.map(shown);
  const hiddenLine = hiddenNote(hidden);
  const lineCount = block ? block.text.split("\n").length : 0;
  const isLong =
    !!block && (lineCount > VISIBLE_LINES || block.text.length > LONG_TEXT);
  const noun = block?.label.toLowerCase() ?? "";

  return (
    <div
      id={id}
      data-testid={`pending-action-${testId}`}
      className="flex min-w-0 basis-full flex-col gap-0.5 px-1 py-0.5 text-xs"
    >
      <span
        className="font-medium text-foreground"
        data-testid={`pending-action-kind-${testId}`}
      >
        {summary.kind}
      </span>

      {fields.length > 0 && (
        <dl className="m-0 flex min-w-0 flex-col gap-0.5">
          {fields.map((f) => (
            <div key={f.label} className="flex min-w-0 flex-wrap gap-x-1">
              <dt className="text-description">{f.label}:</dt>
              <dd className="m-0 min-w-0 font-mono break-all whitespace-pre-wrap text-foreground">
                {f.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {block && (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-description">{block.label}:</span>
          <pre
            id={blockId}
            tabIndex={0}
            aria-label={`${summary.kind}: ${block.label}`}
            data-testid={`pending-action-block-${testId}`}
            className={`m-0 min-w-0 overflow-x-hidden overflow-y-auto rounded-sm border border-solid border-command-border bg-editor p-1 font-mono text-xs break-words whitespace-pre-wrap text-foreground ${
              open ? "max-h-[60vh]" : "max-h-24"
            }`}
          >
            {block.text}
          </pre>
          {isLong && (
            <button
              type="button"
              className="min-h-6 min-w-6 cursor-pointer self-start border-none bg-transparent px-1 py-0 text-2xs text-description underline"
              aria-expanded={open}
              aria-controls={blockId}
              onClick={() => setOpen(!open)}
              data-testid={`pending-action-toggle-${testId}`}
            >
              {open ? `Show less ${noun}` : `Show full ${noun}`}
            </button>
          )}
        </div>
      )}

      {paths.length > 0 && (
        <div className="flex min-w-0 flex-col">
          <span className="text-description">
            {paths.length === 1 ? "Path:" : "Paths:"}
          </span>
          <ul
            className="m-0 list-none p-0"
            data-testid={`pending-action-paths-${testId}`}
          >
            {paths.map((p) => (
              <li
                key={p}
                className="font-mono break-all whitespace-pre-wrap text-foreground"
              >
                {p}
              </li>
            ))}
          </ul>
        </div>
      )}

      {hiddenLine && (
        <p
          className="m-0 border-0 border-l-2 border-solid border-warning pl-1 text-2xs break-words whitespace-normal text-foreground"
          data-testid={`hidden-characters-${testId}`}
        >
          {hiddenLine}
        </p>
      )}

      {note && (
        <p
          className="m-0 border-0 border-l-2 border-solid border-warning pl-1 text-2xs break-words whitespace-normal text-foreground"
          data-testid={`policy-note-${testId}`}
        >
          {maskCommandForDisplay(note)}
          {rule && (
            <>
              {" "}
              <span className="text-description-muted">
                Rule:{" "}
                <code className="break-all">{maskCommandForDisplay(rule)}</code>
              </span>
            </>
          )}
        </p>
      )}
    </div>
  );
}
