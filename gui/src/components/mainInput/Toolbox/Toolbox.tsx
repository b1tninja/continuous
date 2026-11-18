import { BriefcaseIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fillToolboxCard,
  TOOLBOX_GROUPS,
  toolboxCardsIn,
  type ToolboxCard,
} from "core/util/toolboxCards";
import { ToolTip } from "../../gui/Tooltip";
import { useAppDispatch, useAppSelector } from "../../../redux/hooks";
import { useMainEditor } from "../TipTapEditor";
import {
  insertToolboxText,
  sendToolboxText,
  toolboxFactsFromState,
} from "./toolboxActions";

/**
 * The toolbox: a small glyph that pulls the drawer out. The drawer is a panel
 * anchored to the glyph, so it takes no toolbar or input space while closed. It
 * closes on Escape, on a press outside it and when a card is sent or inserted;
 * focus moves into the panel on open and back to the glyph on close (an insert
 * leaves focus in the editor, which is where the person goes next).
 *
 * The drawer: problem-solving prompts grouped by what the person is
 * trying to do. Each card is inserted into the input for editing or sent as the
 * next message. Its text is shown filled in from the session before either,
 * so the person sees exactly what will be sent.
 *
 * Test ids: toolbox-toggle, toolbox-drawer, toolbox-group-<group>,
 * toolbox-card-<id> (with -method, -expand, -prompt, -insert, -send).
 */
export function Toolbox() {
  const dispatch = useAppDispatch();
  const { mainEditor } = useMainEditor();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | undefined>();

  const isStreaming = useAppSelector((state) => state.session.isStreaming);
  const history = useAppSelector((state) => state.session.history);
  const loop = useAppSelector((state) => state.session.loop);
  const taskPlan = useAppSelector((state) => state.session.taskPlan);
  const facts = useMemo(
    () => toolboxFactsFromState({ history, loop, taskPlan }),
    [history, loop, taskPlan],
  );

  const textFor = (card: ToolboxCard) => fillToolboxCard(card, facts);

  const rootRef = useRef<HTMLDivElement>(null);
  const glyphRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    if (returnFocus) {
      glyphRef.current?.focus();
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };
    const onPointerDown = (event: Event) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        close(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open, close]);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <ToolTip content="Toolbox: problem-solving prompts" delayShow={700}>
        <button
          ref={glyphRef}
          type="button"
          data-testid="toolbox-toggle"
          aria-label="Toolbox"
          aria-haspopup="true"
          aria-expanded={open}
          onClick={() => (open ? close() : setOpen(true))}
          className="hover:bg-list-item-hover focus-visible:ring-ring flex h-6 w-6 cursor-pointer items-center justify-center rounded-sm border-none bg-transparent p-0 text-description focus-visible:ring-2 focus-visible:outline-hidden"
        >
          <BriefcaseIcon className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </ToolTip>

      {open && (
        <div
          ref={panelRef}
          role="region"
          aria-label="Toolbox"
          tabIndex={-1}
          data-testid="toolbox-drawer"
          className="toolbox-slide-out absolute right-0 bottom-full z-50 mb-1 max-h-72 w-[min(22rem,calc(100vw-1rem))] space-y-3 overflow-y-auto rounded-default border border-command-border bg-background p-2 shadow-lg focus:outline-hidden"
        >
          {TOOLBOX_GROUPS.map((group) => (
            <section key={group.id} data-testid={`toolbox-group-${group.id}`}>
              <h3 className="m-0 text-xs font-medium">{group.label}</h3>
              <p className="m-0 mb-1 text-xs text-description">{group.use}</p>
              <ul className="m-0 list-none space-y-1 p-0">
                {toolboxCardsIn(group.id).map((card) => (
                  <li
                    key={card.id}
                    data-testid={`toolbox-card-${card.id}`}
                    className="rounded-sm border border-command-border p-1.5"
                  >
                    <div className="text-xs font-medium">{card.title}</div>
                    {card.method && (
                      <div
                        data-testid={`toolbox-card-${card.id}-method`}
                        className="text-[10px] text-description-muted"
                      >
                        {card.method}
                      </div>
                    )}
                    <div className="text-xs text-description">{card.when}</div>

                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <button
                        type="button"
                        data-testid={`toolbox-card-${card.id}-expand`}
                        aria-expanded={expanded === card.id}
                        onClick={() =>
                          setExpanded((current) =>
                            current === card.id ? undefined : card.id,
                          )
                        }
                        className="border-none bg-transparent p-0 text-xs underline"
                      >
                        {expanded === card.id ? "Hide prompt" : "Show prompt"}
                      </button>
                      <button
                        type="button"
                        data-testid={`toolbox-card-${card.id}-insert`}
                        onClick={() => {
                          close(false);
                          insertToolboxText(mainEditor, textFor(card));
                        }}
                        className="rounded-sm border border-command-border bg-transparent px-1.5 py-0.5 text-xs"
                      >
                        Insert
                      </button>
                      <button
                        type="button"
                        data-testid={`toolbox-card-${card.id}-send`}
                        disabled={isStreaming}
                        title={
                          isStreaming
                            ? "Wait for the reply to finish, or insert the card and edit it"
                            : undefined
                        }
                        onClick={() => {
                          close();
                          sendToolboxText(dispatch, textFor(card));
                        }}
                        className="rounded-sm border border-command-border bg-transparent px-1.5 py-0.5 text-xs disabled:opacity-40"
                      >
                        Send
                      </button>
                    </div>

                    {expanded === card.id && (
                      <p
                        data-testid={`toolbox-card-${card.id}-prompt`}
                        className="mt-1 mb-0 text-xs whitespace-pre-wrap"
                      >
                        {textFor(card)}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
