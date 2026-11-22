import { ChevronRightIcon } from "@heroicons/react/24/outline";
import { useEffect, useId, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { cn } from "../../util/cn";

/**
 * A place a link can land on: `?section=<id>` scrolls to the returned ref and
 * calls `onArrive`. The parameter is taken out of the URL once applied, so the
 * same link works again after the person has scrolled away.
 */
export function useSectionLink<T extends HTMLElement>(
  id: string,
  onArrive?: () => void,
) {
  const ref = useRef<T>(null);
  const [params, setParams] = useSearchParams();
  const wanted = params.get("section") === id;
  useEffect(() => {
    if (!wanted) return;
    onArrive?.();
    ref.current?.scrollIntoView?.({ block: "start" });
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("section");
        return next;
      },
      { replace: true },
    );
    // onArrive is the caller's inline function; only the link matters here
  }, [wanted, setParams]);
  return ref;
}

interface FoldProps {
  /** Names the fold in links (`?section=<id>`) and test ids. */
  id: string;
  title: string;
  /** One line with the values in use, readable while the fold is closed. */
  summary: string;
  /** Warning: something in the fold was loosened or needs attention. */
  tone?: "warning";
  /** A short mark after the title, such as "deprecated". */
  mark?: string;
  defaultOpen?: boolean;
  className?: string;
  children: React.ReactNode;
}

/**
 * A folded group of settings. The header is never empty: it carries the
 * state in one line, so nothing has to be opened to read it. The content
 * stays mounted while closed, because some of it loads the state the header
 * shows.
 */
export function Fold({
  id,
  title,
  summary,
  tone,
  mark,
  defaultOpen = false,
  className,
  children,
}: FoldProps) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const ref = useSectionLink<HTMLElement>(id, () => setOpen(true));
  return (
    <section
      ref={ref}
      data-testid={`fold-${id}`}
      className={cn("min-w-0", className)}
    >
      <h3 className="my-0 text-sm font-normal">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          data-testid={`fold-toggle-${id}`}
          onClick={() => setOpen(!open)}
          // A button does not take the page's font by itself
          style={{ fontFamily: "inherit" }}
          className="box-border flex w-full min-w-0 cursor-pointer items-start gap-1.5 rounded-sm border border-solid border-border bg-transparent px-2 py-1.5 text-left text-foreground hover:bg-input"
        >
          <ChevronRightIcon
            aria-hidden="true"
            className={cn(
              "mt-0.5 h-3.5 w-3.5 shrink-0 transition-transform",
              open && "rotate-90",
            )}
          />
          <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-sm font-semibold">
              {title}
              {mark && (
                <span className="ml-1.5 rounded-sm border border-solid border-border px-1 text-2xs font-normal text-description">
                  {mark}
                </span>
              )}
            </span>
            <span
              data-testid={`fold-summary-${id}`}
              className={cn(
                "min-w-0 text-xs break-words",
                tone === "warning" ? "text-warning" : "text-description",
              )}
            >
              {summary}
            </span>
          </span>
        </button>
      </h3>
      <div id={bodyId} hidden={!open} className="min-w-0 pt-2">
        {children}
      </div>
    </section>
  );
}
