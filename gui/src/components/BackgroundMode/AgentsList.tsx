import {
  ArchiveBoxIcon,
  ArrowLeftIcon,
  ArrowUturnLeftIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  StopIcon,
} from "@heroicons/react/24/outline";
import type { AgentView } from "core/agents/project";
import type { AgentState } from "core/agents/types";
import { formatCostAmount } from "core/util/costOf";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { SubagentCard } from "../../pages/gui/ToolCallDiv/SubagentCard";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { selectAgentsSnapshot } from "../../redux/selectors/selectAgents";
import {
  archiveAgents,
  restoreAgents,
  setAgentsPanelFocusRequested,
} from "../../redux/slices/uiSlice";
import { findToolCallById } from "../../redux/util";
import {
  isLoopWorkerLive,
  stopLoopWorker,
} from "../../util/subagents/loopWorkers";
import {
  isSubagentRunLive,
  stopSubagentRun,
} from "../../util/subagents/registry";
import { announce } from "../a11y/announcer";
import { jumpToPlan } from "../loop/LoopStatusLine";
import { SubagentMessages } from "./SubagentMessages";
import {
  agentActions,
  agentArchiveKey,
  groupAgents,
  loopWorkerItemId,
  subagentToolCallId,
  type ActionAvailability,
} from "./agentsPanelModel";

const STATE_LABEL: Record<AgentState, string> = {
  running: "Running",
  "waiting-approval": "Needs you",
  blocked: "Blocked",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
  "over-budget": "Over budget",
};

const STATE_CLASS: Record<AgentState, string> = {
  running: "text-description",
  "waiting-approval": "text-warning",
  blocked: "text-warning",
  done: "text-success",
  failed: "text-error",
  stopped: "text-warning",
  "over-budget": "text-error",
};

const BLOCKED_LABEL: Record<string, string> = {
  approval: "waiting for you",
  question: "waiting for your answer",
  slot: "waiting for a free slot",
  dependency: "waiting for another item",
  budget: "out of budget",
};

const ICON_BUTTON =
  "flex h-5 w-5 flex-shrink-0 cursor-pointer items-center justify-center rounded border-none bg-transparent p-0 text-description hover:bg-input hover:text-foreground";
const TEXT_BUTTON =
  "flex min-h-5 flex-shrink-0 cursor-pointer items-center gap-1 rounded border border-solid border-border bg-transparent px-1.5 text-2xs text-foreground hover:bg-input aria-disabled:cursor-default aria-disabled:opacity-50";

/** An agent the IDE restarted under is "Interrupted" rather than "Stopped". */
function stateOf(agent: AgentView): { label: string; className: string } {
  if (agent.interrupted && agent.state === "stopped") {
    return { label: "Interrupted", className: STATE_CLASS.stopped };
  }
  return {
    label: STATE_LABEL[agent.state],
    className: STATE_CLASS[agent.state],
  };
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function elapsed(agent: AgentView, now: number): string | undefined {
  if (agent.startedAt === undefined) return undefined;
  const s = Math.max(
    0,
    Math.round(((agent.endedAt ?? now) - agent.startedAt) / 1000),
  );
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

/** What it is doing, in a fixed phrase, and where. */
function doingOf(agent: AgentView): string | undefined {
  const doing = agent.blockedOn
    ? BLOCKED_LABEL[agent.blockedOn]
    : agent.state === "running"
      ? agent.activity
      : undefined;
  return (
    [doing, agent.workspace?.name].filter(Boolean).join(" · ") || undefined
  );
}

/** Is this run live in this window, so that Stop reaches it? */
function isLive(agent: AgentView): boolean {
  const toolCallId = subagentToolCallId(agent);
  if (toolCallId) return isSubagentRunLive(toolCallId);
  const itemId = loopWorkerItemId(agent);
  return itemId ? isLoopWorkerLive(itemId) : false;
}

function stop(agent: AgentView): boolean {
  const toolCallId = subagentToolCallId(agent);
  if (toolCallId) return stopSubagentRun(toolCallId);
  const itemId = loopWorkerItemId(agent);
  return itemId ? stopLoopWorker(itemId) : false;
}

/** Brings the subagent's card in the conversation into view. */
function showInConversation(agent: AgentView): boolean {
  const toolCallId = subagentToolCallId(agent);
  if (!toolCallId) return false;
  const card = document.querySelector<HTMLElement>(
    `[data-testid=${JSON.stringify(`subagent-card-${toolCallId}`)}]`,
  );
  if (!card) return false;
  card.scrollIntoView?.({ block: "center", behavior: "smooth" });
  return true;
}

const nameOf = (agent: AgentView) =>
  agent.kind === "main" ? "Session" : agent.role;

interface RowAction {
  label: string;
  icon: ReactNode;
  run: () => void;
  testId: string;
}

interface RowProps {
  agent: AgentView;
  now: number;
  costUnknown: boolean;
  onOpen: (agent: AgentView) => void;
  /** The row's one quick action: Stop, Archive or Restore */
  action?: RowAction;
}

/**
 * One line per agent: its name, state, what it does, time, tokens and cost.
 * The line opens the agent; the icon at its end is its one quick action.
 */
function AgentRow({ agent, now, costUnknown, onOpen, action }: RowProps) {
  const name = nameOf(agent);
  const state = stateOf(agent);
  const doing = doingOf(agent);
  const time = elapsed(agent, now);
  const tokens = agent.tokens
    ? agent.tokens.input + agent.tokens.output
    : undefined;
  return (
    <li
      data-testid={`agent-row-${agent.id}`}
      data-state={agent.state}
      className="flex min-w-0 items-center gap-1"
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 overflow-hidden rounded border-none bg-transparent px-0.5 py-0.5 text-left text-xs whitespace-nowrap text-foreground hover:bg-input"
        onClick={() => onOpen(agent)}
        aria-label={`Open ${name}, ${state.label}${doing ? `, ${doing}` : ""}`}
        data-testid={`agent-open-${agent.id}`}
      >
        <span
          className="max-w-[45%] min-w-0 flex-shrink truncate font-semibold [overflow-wrap:anywhere]"
          title={name}
          data-testid={`agent-name-${agent.id}`}
        >
          {name}
        </span>
        <span
          className={`flex-shrink-0 rounded border border-solid border-border px-1 text-2xs ${state.className}`}
          data-testid={`agent-state-${agent.id}`}
        >
          {state.label}
        </span>
        {doing && (
          <span
            className="min-w-0 flex-1 truncate text-description-muted"
            data-testid={`agent-doing-${agent.id}`}
          >
            {doing}
          </span>
        )}
        <span className="ml-auto flex flex-shrink-0 items-center gap-2 text-description-muted">
          {tokens !== undefined && tokens > 0 && (
            <span>{formatTokens(tokens)} tokens</span>
          )}
          {time && <span>{time}</span>}
          {!costUnknown && (
            <span data-testid={`agent-cost-${agent.id}`}>
              {formatCostAmount(agent.cost.subtree)}
            </span>
          )}
        </span>
      </button>
      {action && (
        <button
          type="button"
          className={ICON_BUTTON}
          onClick={action.run}
          aria-label={`${action.label} ${name}`}
          title={action.label}
          data-testid={action.testId}
        >
          {action.icon}
        </button>
      )}
    </li>
  );
}

interface GroupProps {
  id: string;
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  extra?: ReactNode;
  children: ReactNode;
}

function Group({
  id,
  label,
  count,
  open,
  onToggle,
  extra,
  children,
}: GroupProps) {
  const listId = useId();
  const Icon = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div data-testid={`agents-group-${id}`} className="min-w-0">
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 border-none bg-transparent px-0 py-0.5 text-left text-2xs text-description hover:brightness-125"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          data-testid={`agents-group-toggle-${id}`}
        >
          <Icon className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
          {label} ({count})
        </button>
        {extra}
      </div>
      {open && (
        <ul
          id={listId}
          className="m-0 min-w-0 list-none p-0 pl-2"
          aria-label={label}
          data-testid={`agents-group-list-${id}`}
        >
          {children}
        </ul>
      )}
    </div>
  );
}

/**
 * A button for an action that may not exist for this agent. One that does not
 * stays focusable and says why (aria-disabled, the reason as its description
 * and, when pressed, shown and read out), rather than vanishing.
 */
function ActionButton({
  label,
  availability,
  onRun,
  testId,
  icon,
  onUnavailable,
}: {
  label: string;
  availability: ActionAvailability;
  onRun: () => void;
  testId: string;
  icon?: ReactNode;
  onUnavailable: (reason: string) => void;
}) {
  const reasonId = useId();
  const reason = availability.enabled ? undefined : availability.reason;
  return (
    <button
      type="button"
      className={TEXT_BUTTON}
      aria-disabled={reason ? true : undefined}
      aria-describedby={reason ? reasonId : undefined}
      title={reason}
      onClick={() => (reason ? onUnavailable(reason) : onRun())}
      data-testid={testId}
    >
      {icon}
      {label}
      {reason && (
        <span id={reasonId} hidden>
          {reason}
        </span>
      )}
    </button>
  );
}

const ENABLED: ActionAvailability = { enabled: true };

/**
 * One agent, opened from the list: its record as the conversation's card
 * shows it (read-only: approvals are answered on that card), what can be done
 * to it, and Back to the session that started it. Escape goes back too.
 */
function AgentDetail({
  agent,
  parentName,
  archived,
  onBack,
}: {
  agent: AgentView;
  parentName: string;
  archived: boolean;
  onBack: () => void;
}) {
  const dispatch = useAppDispatch();
  const history = useAppSelector((s) => s.session.history);
  const backRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [note, setNote] = useState<string>();
  const name = nameOf(agent);
  const state = stateOf(agent);
  const actions = agentActions(agent, isLive(agent));
  const toolCallId = subagentToolCallId(agent);
  const toolCallState = toolCallId
    ? findToolCallById(history, toolCallId)
    : undefined;

  useEffect(() => {
    backRef.current?.focus();
  }, [agent.id]);

  const say = (text: string) => {
    setNote(text);
    announce(text);
  };
  const key = agentArchiveKey(agent);
  const goToConversation = () => {
    if (!showInConversation(agent)) say("Its card is not in the conversation.");
  };

  return (
    <section
      aria-labelledby={titleId}
      data-testid="agent-detail"
      className="flex min-w-0 flex-col gap-1"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onBack();
        }
      }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <button
          ref={backRef}
          type="button"
          className="flex flex-shrink-0 cursor-pointer items-center gap-1 rounded border-none bg-transparent px-0.5 text-xs text-link hover:underline"
          onClick={onBack}
          data-testid="agent-detail-back"
        >
          <ArrowLeftIcon className="h-3 w-3" aria-hidden="true" />
          Back to {parentName}
        </button>
        <h3
          id={titleId}
          className="m-0 min-w-0 truncate text-xs font-semibold"
          title={name}
        >
          {name}
        </h3>
        <span
          className={`flex-shrink-0 rounded border border-solid border-border px-1 text-2xs ${state.className}`}
          data-testid="agent-detail-state"
        >
          {state.label}
        </span>
      </div>
      <div
        role="toolbar"
        aria-label={`Actions for ${name}`}
        className="flex min-w-0 flex-wrap items-center gap-1"
      >
        <ActionButton
          label="Stop"
          icon={<StopIcon className="h-3 w-3" aria-hidden="true" />}
          availability={actions.stop}
          onRun={() => {
            if (stop(agent)) say(`Stopping ${name}.`);
            else say("It is not live in this window.");
          }}
          onUnavailable={say}
          testId="agent-detail-stop"
        />
        <ActionButton
          label="Resume"
          availability={actions.resume}
          onRun={() => undefined}
          onUnavailable={say}
          testId="agent-detail-resume"
        />
        {archived ? (
          <ActionButton
            label="Restore"
            icon={<ArrowUturnLeftIcon className="h-3 w-3" aria-hidden="true" />}
            availability={ENABLED}
            onRun={() => {
              dispatch(restoreAgents({ keys: [key] }));
              say(`Restored ${name} to Done.`);
            }}
            onUnavailable={say}
            testId="agent-detail-restore"
          />
        ) : (
          <ActionButton
            label="Archive"
            icon={<ArchiveBoxIcon className="h-3 w-3" aria-hidden="true" />}
            availability={actions.archive}
            onRun={() => {
              dispatch(archiveAgents({ keys: [key] }));
              say(`Archived ${name}. Restore brings it back.`);
            }}
            onUnavailable={say}
            testId="agent-detail-archive"
          />
        )}
        <ActionButton
          label="Delete"
          availability={actions.delete}
          onRun={() => undefined}
          onUnavailable={say}
          testId="agent-detail-delete"
        />
        {agent.kind === "loop-worker" ? (
          <ActionButton
            label="Show in plan"
            availability={ENABLED}
            onRun={() => {
              if (!jumpToPlan()) say("The plan is not in the conversation.");
            }}
            onUnavailable={say}
            testId="agent-detail-plan"
          />
        ) : (
          <ActionButton
            label="Show in conversation"
            availability={ENABLED}
            onRun={goToConversation}
            onUnavailable={say}
            testId="agent-detail-jump"
          />
        )}
      </div>
      {note && (
        <div
          className="min-w-0 break-words text-description"
          data-testid="agent-detail-note"
        >
          {note}
        </div>
      )}
      {actions.transcript.enabled && toolCallState ? (
        <div
          role="region"
          aria-label={`Record of ${name}`}
          tabIndex={0}
          className="max-h-[50vh] min-w-0 overflow-y-auto"
          data-testid="agent-detail-transcript"
        >
          <SubagentCard
            toolCallState={toolCallState}
            readOnly
            onShowInConversation={goToConversation}
          />
        </div>
      ) : (
        <div
          className="min-w-0 break-words text-description-muted"
          data-testid="agent-detail-no-transcript"
        >
          {actions.transcript.enabled
            ? "Its record is not in this session."
            : actions.transcript.reason}
        </div>
      )}
      {/* Loop workers take no messages here: the loop steers its items */}
      {toolCallId && (
        <SubagentMessages
          runId={toolCallId}
          name={name}
          run={toolCallState?.subagent}
        />
      )}
    </section>
  );
}

/**
 * The agents of this session, compact: Active (waiting for you first, then
 * running, then queued), Done (collapsed until opened) and Archived (only
 * when there is something in it), one line per agent. A row opens the
 * agent's record with Back to the session; its icon stops a live run,
 * archives an ended one or restores an archived one. Shows nothing until an
 * agent has been started. Design: plans/research/subagent-sessions-panel.md.
 */
export function AgentsList() {
  const dispatch = useAppDispatch();
  const snapshot = useAppSelector(selectAgentsSnapshot);
  const archivedKeys = useAppSelector((s) => s.ui.archivedAgents);
  const [listOpen, setListOpen] = useState(true);
  const [groupsOpen, setGroupsOpen] = useState({
    active: true,
    done: false,
    archived: false,
  });
  const [openId, setOpenId] = useState<string>();
  const returnFocus = useRef<string | undefined>(undefined);

  const opened = openId
    ? snapshot.nodes.find((n) => n.id === openId)
    : undefined;

  // Show Agents in the Command Palette: open the list and focus its toggle
  const focusRequested = useAppSelector(
    (s) => s.ui.agentsPanelFocusRequested === true,
  );
  const hasAgents = snapshot.nodes.length > 0;
  useEffect(() => {
    if (!focusRequested || !hasAgents) return;
    dispatch(setAgentsPanelFocusRequested(false));
    setListOpen(true);
    setOpenId(undefined);
    document
      .querySelector<HTMLElement>('[data-testid="agents-toggle"]')
      ?.focus();
  }, [focusRequested, hasAgents, dispatch]);

  // Back to the list: focus the row that was opened
  useEffect(() => {
    if (openId || !returnFocus.current) return;
    const id = returnFocus.current;
    returnFocus.current = undefined;
    document
      .querySelector<HTMLElement>(
        `[data-testid=${JSON.stringify(`agent-open-${id}`)}]`,
      )
      ?.focus();
  }, [openId]);

  if (snapshot.nodes.length === 0) return null;

  const archived = archivedKeys ?? {};
  const groups = groupAgents(snapshot.nodes, archived);
  const agentRows = snapshot.nodes.filter((n) => n.kind !== "main");
  const costUnknown =
    agentRows.length > 0 &&
    agentRows.every((n) => n.cost.subtree === "unknown");
  const waiting = snapshot.needsYou.length;
  const Icon = listOpen ? ChevronDownIcon : ChevronRightIcon;
  const now = snapshot.generatedAt;
  const parent = snapshot.nodes.find((n) => n.kind === "main");
  // The cost note is about rows, so it shows only while some rows do
  const rowsShown =
    (groupsOpen.active && groups.active.length > 0) ||
    (groupsOpen.done && groups.done.length > 0) ||
    (groupsOpen.archived && groups.archived.length > 0);
  const toggleGroup = (g: keyof typeof groupsOpen) =>
    setGroupsOpen((prev) => ({ ...prev, [g]: !prev[g] }));

  const open = (agent: AgentView) => setOpenId(agent.id);
  const back = () => {
    returnFocus.current = openId;
    setOpenId(undefined);
  };
  const archive = (agents: AgentView[]) => {
    if (agents.length === 0) return;
    dispatch(archiveAgents({ keys: agents.map(agentArchiveKey) }));
    announce(
      agents.length === 1
        ? `Archived ${nameOf(agents[0])}.`
        : `Archived ${agents.length} agents.`,
    );
  };
  const restore = (agent: AgentView) => {
    dispatch(restoreAgents({ keys: [agentArchiveKey(agent)] }));
    announce(`Restored ${nameOf(agent)} to Done.`);
  };
  const row = (agent: AgentView, action?: RowAction) => (
    <AgentRow
      key={agent.id}
      agent={agent}
      now={now}
      costUnknown={costUnknown}
      onOpen={open}
      action={action}
    />
  );

  return (
    <div data-testid="agents-panel" className="mx-1 mb-1 min-w-0">
      <button
        type="button"
        className="flex w-full min-w-0 cursor-pointer items-center gap-1 border-none bg-transparent px-0.5 text-left text-2xs tracking-wide text-description-muted uppercase hover:brightness-125"
        onClick={() => setListOpen((o) => !o)}
        aria-expanded={listOpen}
        data-testid="agents-toggle"
      >
        <Icon className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
        Agents
        <span className="normal-case" data-testid="agents-summary">
          {snapshot.totals.running} running
          {waiting > 0 ? `, ${waiting} waiting for you` : ""}
          {snapshot.totals.done > 0 ? `, ${snapshot.totals.done} done` : ""}
          {snapshot.totals.failed > 0
            ? `, ${snapshot.totals.failed} ended early`
            : ""}
        </span>
        {!costUnknown && (
          <span className="ml-auto normal-case">
            {formatCostAmount(snapshot.totals.costUsd)}
          </span>
        )}
      </button>
      {listOpen && (
        <div
          className="flex min-w-0 flex-col gap-0.5 rounded border border-solid border-border px-2 py-1 text-xs"
          data-testid="agents-list"
        >
          {opened ? (
            <AgentDetail
              agent={opened}
              parentName={parent ? nameOf(parent) : "Session"}
              archived={archived[agentArchiveKey(opened)] !== undefined}
              onBack={back}
            />
          ) : (
            <>
              {costUnknown && rowsShown && (
                <div
                  className="py-0.5 text-description-muted"
                  data-testid="agents-cost-unknown"
                >
                  Cost: not known for this model
                </div>
              )}
              {groups.active.length > 0 && (
                <Group
                  id="active"
                  label="Active"
                  count={groups.active.length}
                  open={groupsOpen.active}
                  onToggle={() => toggleGroup("active")}
                >
                  {groups.active.map((agent) =>
                    row(
                      agent,
                      isLive(agent)
                        ? {
                            label: "Stop",
                            icon: (
                              <StopIcon
                                className="h-3 w-3"
                                aria-hidden="true"
                              />
                            ),
                            run: () => {
                              if (stop(agent))
                                announce(`Stopping ${nameOf(agent)}.`);
                            },
                            testId: `agent-stop-${agent.id}`,
                          }
                        : undefined,
                    ),
                  )}
                </Group>
              )}
              {groups.done.length > 0 && (
                <Group
                  id="done"
                  label="Done"
                  count={groups.done.length}
                  open={groupsOpen.done}
                  onToggle={() => toggleGroup("done")}
                  extra={
                    <button
                      type="button"
                      className="cursor-pointer border-none bg-transparent px-1 text-2xs text-description hover:underline"
                      onClick={() => archive(groups.done)}
                      aria-label={`Archive all ${groups.done.length} done agents`}
                      data-testid="agents-archive-done"
                    >
                      Archive all
                    </button>
                  }
                >
                  {groups.done.map((agent) =>
                    row(agent, {
                      label: "Archive",
                      icon: (
                        <ArchiveBoxIcon
                          className="h-3 w-3"
                          aria-hidden="true"
                        />
                      ),
                      run: () => archive([agent]),
                      testId: `agent-archive-${agent.id}`,
                    }),
                  )}
                </Group>
              )}
              {groups.archived.length > 0 && (
                <Group
                  id="archived"
                  label="Archived"
                  count={groups.archived.length}
                  open={groupsOpen.archived}
                  onToggle={() => toggleGroup("archived")}
                >
                  {groups.archived.map((agent) =>
                    row(agent, {
                      label: "Restore",
                      icon: (
                        <ArrowUturnLeftIcon
                          className="h-3 w-3"
                          aria-hidden="true"
                        />
                      ),
                      run: () => restore(agent),
                      testId: `agent-restore-${agent.id}`,
                    }),
                  )}
                </Group>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
