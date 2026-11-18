import {
  ArrowPathIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  MinusIcon,
  PauseIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import type { LoopState, TaskPlan } from "core";
import type { ReplanDiff } from "core/util/loopMode";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { maskCommandForDisplay } from "core/tools/permissions/displayMask";
import { useAppSelector } from "../../redux/hooks";
import { announce } from "../a11y/announcer";
import {
  planTreeModel,
  TREE_STATUS_WORD,
  type PlanTreeModel,
  type TreeExtras,
  type TreeFold,
  type TreeItem,
  type TreeLine,
  type TreeStatus,
} from "./planTreeModel";

const ICON = "h-3.5 w-3.5 shrink-0";

/** The state's icon: colour and shape together, never colour alone */
function StatusIcon({ status }: { status: TreeStatus | "idle" }) {
  switch (status) {
    case "done":
      return <CheckIcon aria-hidden className={`${ICON} text-success`} />;
    case "failed":
      return <XMarkIcon aria-hidden className={`${ICON} text-error`} />;
    case "waiting":
      return <PauseIcon aria-hidden className={`${ICON} text-warning`} />;
    case "running":
      return (
        <span
          aria-hidden
          className={`${ICON} flex items-center justify-center`}
        >
          <span className="plan-tree-dot h-2 w-2 rounded-full bg-link" />
        </span>
      );
    case "replaced":
    case "dropped":
      return (
        <ArrowPathIcon aria-hidden className={`${ICON} text-description`} />
      );
    case "skipped":
      return <MinusIcon aria-hidden className={`${ICON} text-description`} />;
    default:
      return (
        <span
          aria-hidden
          className={`${ICON} flex items-center justify-center`}
        >
          <span className="h-2 w-2 rounded-full border border-solid border-description" />
        </span>
      );
  }
}

const LINE_LABEL_CLASS = "font-semibold";

interface RowProps {
  /** The node's tree id */
  nodeId: string;
  /** Names the item; the nested group is not part of the name */
  labelId: string;
  focusId: string;
  onFocusNode: (id: string) => void;
  onToggle?: (id: string) => void;
  expandable: boolean;
  open: boolean;
  current?: boolean;
  followTo?: string;
  children: ReactNode;
  group?: ReactNode;
  testId?: string;
  title?: string;
  highlight?: boolean;
}

function Row(p: RowProps) {
  return (
    <li
      role="treeitem"
      data-node-id={p.nodeId}
      data-testid={p.testId}
      data-follow={p.followTo}
      aria-expanded={p.expandable ? p.open : undefined}
      aria-current={p.current ? "step" : undefined}
      aria-labelledby={p.labelId}
      tabIndex={p.focusId === p.nodeId ? 0 : -1}
      onFocus={(e) => {
        if (e.target === e.currentTarget) p.onFocusNode(p.nodeId);
      }}
      className="m-0 list-none rounded outline-offset-0"
    >
      <div
        id={p.labelId}
        title={p.title}
        onClick={() => p.onToggle?.(p.nodeId)}
        className={`flex min-h-6 min-w-0 items-center gap-1.5 rounded px-1 py-px ${
          p.expandable || p.followTo ? "cursor-pointer" : ""
        } ${p.highlight ? "bg-input outline outline-1 outline-link" : ""}`}
      >
        {p.children}
      </div>
      {p.group}
    </li>
  );
}

function Group({ children }: { children: ReactNode }) {
  return (
    <ul
      role="group"
      className="m-0 mt-px ml-2 list-none border-0 border-l border-solid border-border p-0 pl-2.5"
    >
      {children}
    </ul>
  );
}

function Chip({
  tone,
  children,
}: {
  tone: "new" | "round";
  children: ReactNode;
}) {
  return (
    <span
      className={`shrink-0 rounded border border-solid px-1 text-2xs leading-4 ${
        tone === "new" ? "border-success text-success" : "border-link text-link"
      }`}
    >
      {children}
    </span>
  );
}

interface PlanTreeProps {
  loop: LoopState;
  plan: TaskPlan;
  /** The re-plan waiting to be accepted, when one is */
  diff?: ReplanDiff;
  extras?: TreeExtras;
}

/**
 * The plan as a fold-away tree: Plan, then the to-dos. Finished items fold
 * into one row, the current one is open with its live lines, upcoming ones
 * take a line each. ARIA tree semantics with a roving tabindex: Up and Down
 * move through the visible rows, Right opens or steps into a row, Left closes
 * it or steps out, Home and End jump, Enter and Space open and close, and
 * Enter on a replaced to-do goes to the one that replaced it. Folding never
 * moves focus, and a new current item does not take it.
 */
export function PlanTree({ loop, plan, diff, extras }: PlanTreeProps) {
  const history = useAppSelector((s) => s.session.history);
  const prefix = useId();
  const treeRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [focusId, setFocusId] = useState("root");
  const pendingFocus = useRef<string | undefined>(undefined);

  const running = !!loop.current?.itemId && loop.current.kind !== "replan";
  const [now, setNow] = useState(() => Date.now());
  const rootOpenNow = open.root ?? (loop.status === "awaiting_plan" && !!diff);
  useEffect(() => {
    if (!running || !rootOpenNow) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, [running, rootOpenNow]);

  const model = useMemo(
    () => planTreeModel({ loop, plan, diff, history, now, extras }),
    [loop, plan, diff, history, now, extras],
  );

  // A plan that starts waiting, or an item that starts to fail, opens the
  // tree; closing it afterwards is the person's choice and stays.
  const wasAuto = useRef(model.autoExpand);
  useEffect(() => {
    if (model.autoExpand && !wasAuto.current) {
      setOpen((o) => ({ ...o, root: true }));
    }
    wasAuto.current = model.autoExpand;
  }, [model.autoExpand]);

  usePlanTreeAnnouncements(model, loop);

  const isOpen = useCallback(
    (id: string, fallback: boolean) => open[id] ?? fallback,
    [open],
  );
  const toggle = useCallback(
    (id: string, fallback: boolean) =>
      setOpen((o) => ({ ...o, [id]: !(o[id] ?? fallback) })),
    [],
  );

  const focusNode = (id: string) => {
    pendingFocus.current = id;
    setFocusId(id);
  };
  // Focus after the render that mounted the target (a fold that was closed)
  useEffect(() => {
    const id = pendingFocus.current;
    if (!id) return;
    const el = treeRef.current?.querySelector<HTMLElement>(
      `[data-node-id="${CSS.escape(id)}"]`,
    );
    if (el) {
      pendingFocus.current = undefined;
      el.focus();
    }
  });
  // The focused row went away with a fold: fall back to its tree
  useEffect(() => {
    if (!treeRef.current) return;
    const el = treeRef.current.querySelector(
      `[data-node-id="${CSS.escape(focusId)}"]`,
    );
    if (!el && !pendingFocus.current) setFocusId("root");
  });

  const visible = () =>
    Array.from(
      treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [],
    );

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const el = e.target as HTMLElement;
    if (el.getAttribute("role") !== "treeitem") return;
    const items = visible();
    const i = items.indexOf(el);
    const id = el.dataset.nodeId ?? "";
    const expanded = el.getAttribute("aria-expanded");
    const go = (target: HTMLElement | undefined) => {
      if (!target) return;
      e.preventDefault();
      focusNode(target.dataset.nodeId ?? "root");
    };
    switch (e.key) {
      case "ArrowDown":
        go(items[i + 1]);
        break;
      case "ArrowUp":
        go(items[i - 1]);
        break;
      case "Home":
        go(items[0]);
        break;
      case "End":
        go(items[items.length - 1]);
        break;
      case "ArrowRight":
        if (expanded === "false") {
          e.preventDefault();
          setOpen((o) => ({ ...o, [id]: true }));
        } else if (expanded === "true") {
          go(
            el.querySelector<HTMLElement>(
              ':scope > [role="group"] > [role="treeitem"]',
            ) ?? undefined,
          );
        }
        break;
      case "ArrowLeft":
        if (expanded === "true") {
          e.preventDefault();
          setOpen((o) => ({ ...o, [id]: false }));
        } else {
          go(
            el.parentElement?.closest<HTMLElement>('[role="treeitem"]') ??
              undefined,
          );
        }
        break;
      case "Enter":
      case " ": {
        const follow = el.dataset.follow;
        if (e.key === "Enter" && follow) {
          e.preventDefault();
          followTo(follow);
        } else if (expanded !== null) {
          e.preventDefault();
          setOpen((o) => ({ ...o, [id]: expanded !== "true" }));
        }
        break;
      }
    }
  };

  /** Goes to a to-do, opening the fold that holds it */
  const followTo = (itemId: string) => {
    const holder = model.nodes.find(
      (n): n is TreeFold =>
        n.type === "fold" && n.children.some((c) => c.id === itemId),
    );
    if (holder) setOpen((o) => ({ ...o, [`fold:${holder.id}`]: true }));
    focusNode(itemId);
  };

  const rootOpen = isOpen("root", model.autoExpand);
  const labelId = (id: string) => `${prefix}-${id}`;

  const renderLine = (line: TreeLine) => (
    <Row
      key={line.id}
      nodeId={`line:${line.id}`}
      labelId={labelId(`line:${line.id}`)}
      focusId={focusId}
      onFocusNode={setFocusId}
      expandable={false}
      open={false}
      testId={`plan-tree-line-${line.tone}`}
    >
      <span aria-hidden className={`${ICON} text-description`} />
      <span className="min-w-0 text-xs break-words text-description">
        {line.label && <span className={LINE_LABEL_CLASS}>{line.label}: </span>}
        {line.text}
      </span>
    </Row>
  );

  const renderItem = (item: TreeItem) => {
    const id = item.id;
    const expandable = item.lines.length > 0;
    const itemOpen = isOpen(id, item.openByDefault);
    const struck = item.status === "replaced" || item.status === "dropped";
    return (
      <Row
        key={id}
        nodeId={id}
        labelId={labelId(id)}
        focusId={focusId}
        onFocusNode={setFocusId}
        expandable={expandable}
        open={itemOpen}
        current={item.current}
        highlight={item.current}
        followTo={item.replacedById}
        onToggle={() => {
          if (expandable) toggle(id, item.openByDefault);
          else if (item.replacedById) followTo(item.replacedById);
        }}
        testId={`plan-tree-item-${id}`}
        title={item.text}
        group={
          expandable && itemOpen ? (
            <Group>{item.lines.map(renderLine)}</Group>
          ) : undefined
        }
      >
        <StatusIcon status={item.status} />
        <span
          className={`min-w-0 text-xs break-words ${
            struck ? "text-description-muted line-through" : ""
          } ${item.current ? "" : item.status === "pending" ? "text-description" : ""}`}
        >
          <span className="sr-only">{TREE_STATUS_WORD[item.status]}, </span>
          {item.number !== undefined && `${item.number}. `}
          {item.text}
        </span>
        {item.status === "dropped" && (
          <span className="shrink-0 text-2xs text-description">dropped</span>
        )}
        {item.isNew && <Chip tone="new">new</Chip>}
        {item.round && <Chip tone="round">R{item.round}</Chip>}
        {item.replacedByNumber !== undefined && (
          <span className="shrink-0 text-2xs text-description">
            replaced by {item.replacedByNumber}
          </span>
        )}
      </Row>
    );
  };

  const renderFold = (fold: TreeFold) => {
    const id = `fold:${fold.id}`;
    const foldOpen = isOpen(id, false);
    return (
      <Row
        key={id}
        nodeId={id}
        labelId={labelId(id)}
        focusId={focusId}
        onFocusNode={setFocusId}
        expandable
        open={foldOpen}
        onToggle={() => toggle(id, false)}
        testId={`plan-tree-fold-${fold.id}`}
        group={
          foldOpen ? <Group>{fold.children.map(renderItem)}</Group> : undefined
        }
      >
        {foldOpen ? (
          <ChevronDownIcon aria-hidden className={`${ICON} text-description`} />
        ) : (
          <ChevronRightIcon
            aria-hidden
            className={`${ICON} text-description`}
          />
        )}
        <StatusIcon status={fold.status === "done" ? "done" : "pending"} />
        <span className="text-xs text-description">
          <span className="sr-only">{TREE_STATUS_WORD[fold.status]}: </span>
          {fold.label}
        </span>
      </Row>
    );
  };

  return (
    <ul
      ref={treeRef}
      role="tree"
      aria-label="Plan to-dos"
      data-testid="plan-tree"
      onKeyDown={onKeyDown}
      className="m-0 list-none p-0"
    >
      <Row
        nodeId="root"
        labelId={labelId("root")}
        focusId={focusId}
        onFocusNode={setFocusId}
        expandable
        open={rootOpen}
        onToggle={() => toggle("root", model.autoExpand)}
        testId="plan-tree-root"
        group={
          rootOpen ? (
            <Group>
              {model.nodes.map((node) =>
                node.type === "fold" ? (
                  renderFold(node)
                ) : node.type === "trace" ? (
                  <Row
                    key={node.id}
                    nodeId={`trace:${node.id}`}
                    labelId={labelId(`trace:${node.id}`)}
                    focusId={focusId}
                    onFocusNode={setFocusId}
                    expandable={false}
                    open={false}
                    testId="plan-tree-trace"
                  >
                    <ArrowPathIcon
                      aria-hidden
                      className={`${ICON} text-description`}
                    />
                    <span className="min-w-0 text-2xs break-words text-description">
                      {node.text}
                    </span>
                  </Row>
                ) : (
                  renderItem(node)
                ),
              )}
            </Group>
          ) : undefined
        }
      >
        {rootOpen ? (
          <ChevronDownIcon aria-hidden className={`${ICON} text-description`} />
        ) : (
          <ChevronRightIcon
            aria-hidden
            className={`${ICON} text-description`}
          />
        )}
        <span className="text-xs">
          <span className="font-semibold">To-dos</span>
          {" · "}
          <span className="font-semibold">{model.rootLabel}</span>
        </span>
        {model.rootStatus !== "idle" && (
          <StatusIcon status={model.rootStatus} />
        )}
      </Row>
    </ul>
  );
}

/**
 * Says the changes that matter through the webview's existing live regions:
 * no region of its own, and nothing for plain progress. Nothing is said for
 * what was already true when the tree mounted.
 */
function usePlanTreeAnnouncements(model: PlanTreeModel, loop: LoopState) {
  const prev = useRef<{
    waiting: boolean;
    failed: Set<string>;
    finished: boolean;
    decisions: number;
  }>(undefined);
  const decisions = (loop as { autoDecisions?: { text: string }[] })
    .autoDecisions;
  useEffect(() => {
    const failed = new Set<string>();
    for (const n of model.nodes) {
      const items =
        n.type === "fold" ? n.children : n.type === "item" ? [n] : [];
      for (const i of items) if (i.status === "failed") failed.add(i.id);
    }
    const waiting =
      model.rootStatus === "waiting" && loop.status === "awaiting_plan";
    const finished = model.total > 0 && model.done === model.total;
    const count = decisions?.length ?? 0;
    const p = prev.current;
    if (p) {
      if (waiting && !p.waiting) {
        announce("Loop waiting for you: new plan to accept");
      }
      for (const id of failed) {
        if (p.failed.has(id)) continue;
        const item = model.nodes
          .flatMap((n) =>
            n.type === "fold" ? n.children : n.type === "item" ? [n] : [],
          )
          .find((i) => i.id === id);
        const repairing = item?.lines.some((l) => l.tone === "repair");
        announce(
          `Item ${item?.number ?? ""} failed${repairing ? ", repairing" : ""}`,
        );
      }
      if (finished && !p.finished) {
        announce(`Loop finished, ${model.done} of ${model.total} done`);
      }
      if (decisions && count > p.decisions) {
        for (const d of decisions.slice(p.decisions))
          announce(maskCommandForDisplay(d.text));
      }
    }
    prev.current = { waiting, failed, finished, decisions: count };
  }, [model, loop.status, decisions]);
}
