import {
  MAX_AGENT_MESSAGE_CHARS,
  MAX_AGENT_MESSAGES_PER_RUN,
  type SessionMessageSender,
} from "core/subagents/messages";
import {
  MAX_CONCURRENT_SUBAGENTS,
  PrefixGate,
  Semaphore,
} from "core/subagents/scheduling";

/**
 * What a running subagent needs outside redux: its abort controller (for the
 * card's Stop) and the resolver of a call waiting for approval. Neither can
 * be serialized, and neither outlives the window: after a reload the run is
 * marked interrupted instead (see interrupt.ts).
 */
const runs = new Map<string, AbortController>();
const approvals = new Map<string, (allowed: boolean) => void>();

/** Shared by every run in this window. */
export const subagentSlots = new Semaphore(MAX_CONCURRENT_SUBAGENTS);
export const subagentPrefixGate = new PrefixGate();

/**
 * Slots per model server, for servers that say how many requests they serve
 * at once (Strata, llama.cpp). A one-slot server then runs one subagent at a
 * time: more would only wait in its queue and push each other's
 * conversations out of its cache. Keyed by server address and limit, so a
 * server restarted with more slots gets a fresh semaphore.
 */
const serverSlots = new Map<string, Semaphore>();

export function subagentServerSlots(apiBase: string, limit: number): Semaphore {
  const key = `${apiBase.replace(/\/+$/, "")}|${limit}`;
  let slots = serverSlots.get(key);
  if (!slots) {
    slots = new Semaphore(limit);
    serverSlots.set(key, slots);
  }
  return slots;
}

export const STOPPED_BY_USER = "Stopped by the user";

export function registerSubagentRun(
  toolCallId: string,
  controller: AbortController,
): () => void {
  runs.set(toolCallId, controller);
  emit();
  return () => {
    if (runs.get(toolCallId) === controller) {
      runs.delete(toolCallId);
      agentSends.delete(toolCallId);
      emit();
    }
  };
}

/** The card's Stop: cancels one run; its parent keeps going. */
export function stopSubagentRun(toolCallId: string): boolean {
  const controller = runs.get(toolCallId);
  if (!controller) return false;
  controller.abort(new Error(STOPPED_BY_USER));
  return true;
}

export function isSubagentRunLive(toolCallId: string): boolean {
  return runs.has(toolCallId);
}

/**
 * A message to a running subagent: from the person, sent from its record,
 * or from another agent started with it (send_message). "Send" waits until
 * the run would otherwise finish; "Send now" (steer) goes in after the
 * current tool calls, as the main chat's steering does.
 */
export interface SubagentInboxMessage {
  id: string;
  text: string;
  steer: boolean;
  at: number;
  /** Absent means the person (messages queued before agents could send) */
  from?: SessionMessageSender;
}

const NO_MESSAGES: readonly SubagentInboxMessage[] = [];
/** Per run (the parent's tool call id); replaced, never mutated, on change */
const inboxes = new Map<string, readonly SubagentInboxMessage[]>();
const listeners = new Set<() => void>();
let nextMessageId = 0;

function emit() {
  for (const listener of [...listeners]) listener();
}

function setInbox(runId: string, messages: readonly SubagentInboxMessage[]) {
  if (messages.length) inboxes.set(runId, messages);
  else inboxes.delete(runId);
  emit();
}

/** Called when a run starts or ends, or its queue changes. */
export function subscribeSubagentRuns(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Queue a message for a live run. A run that is not live in this window
 * (ended, or a Loop worker, which takes no messages) refuses it.
 */
export function sendToSubagent(
  runId: string,
  text: string,
  opts: { steer: boolean; from?: SessionMessageSender },
): "queued" | "not-live" | "empty" {
  if (!runs.has(runId)) return "not-live";
  const trimmed = text.trim();
  if (!trimmed) return "empty";
  setInbox(runId, [
    ...(inboxes.get(runId) ?? []),
    {
      id: `m${++nextMessageId}`,
      text: trimmed,
      steer: opts.steer,
      at: Date.now(),
      ...(opts.from && opts.from.kind !== "person" ? { from: opts.from } : {}),
    },
  ]);
  return "queued";
}

/** Per sending run: the texts it sent, by receiver, for the limits below. */
const agentSends = new Map<string, { to: string; text: string }[]>();

export type AgentSendOutcome =
  "queued" | "not-live" | "empty" | "self" | "too-long" | "limit" | "duplicate";

/**
 * A message from one running subagent to another (send_message). The caller
 * has checked that the two were started together. Delivered after the
 * receiver's current tool calls. Each run may send a few, never the same
 * text twice to the same receiver, so two runs cannot keep each other going.
 */
export function sendAgentMessage(
  from: { runId: string; name: string },
  toRunId: string,
  text: string,
): AgentSendOutcome {
  if (from.runId === toRunId) return "self";
  if (!runs.has(from.runId) || !runs.has(toRunId)) return "not-live";
  const trimmed = text.trim();
  if (!trimmed) return "empty";
  if (trimmed.length > MAX_AGENT_MESSAGE_CHARS) return "too-long";
  const sent = agentSends.get(from.runId) ?? [];
  if (sent.length >= MAX_AGENT_MESSAGES_PER_RUN) return "limit";
  if (sent.some((s) => s.to === toRunId && s.text === trimmed)) {
    return "duplicate";
  }
  const outcome = sendToSubagent(toRunId, trimmed, {
    steer: true,
    from: { kind: "agent", name: from.name, runId: from.runId },
  });
  if (outcome === "queued") {
    agentSends.set(from.runId, [...sent, { to: toRunId, text: trimmed }]);
  }
  return outcome;
}

/** How many more messages a run may send to other agents. */
export function agentMessagesLeft(runId: string): number {
  return Math.max(
    0,
    MAX_AGENT_MESSAGES_PER_RUN - (agentSends.get(runId)?.length ?? 0),
  );
}

/** The run's queued messages, oldest first. Stable until the queue changes. */
export function peekInbox(runId: string): readonly SubagentInboxMessage[] {
  return inboxes.get(runId) ?? NO_MESSAGES;
}

/**
 * Take the messages due at this point, oldest first: the steered ones at a
 * tool boundary, or all of them when the run would finish or has ended.
 */
export function takeInbox(
  runId: string,
  which: "steer" | "all",
): SubagentInboxMessage[] {
  const queued = peekInbox(runId);
  const taken = queued.filter((m) => which === "all" || m.steer);
  if (taken.length)
    setInbox(
      runId,
      queued.filter((m) => !taken.includes(m)),
    );
  return taken;
}

/** Cancel a message before it is delivered. False when it already went. */
export function cancelInboxMessage(runId: string, id: string): boolean {
  const queued = peekInbox(runId);
  if (!queued.some((m) => m.id === id)) return false;
  setInbox(
    runId,
    queued.filter((m) => m.id !== id),
  );
  return true;
}

/** "Send now" on a queued message: deliver it at the next tool boundary. */
export function steerInboxMessage(runId: string, id: string): boolean {
  const queued = peekInbox(runId);
  if (!queued.some((m) => m.id === id && !m.steer)) return false;
  setInbox(
    runId,
    queued.map((m) => (m.id === id ? { ...m, steer: true } : m)),
  );
  return true;
}

/**
 * Wait for the person to allow or reject one of a subagent's calls. Resolves
 * false (rejected) if the run is cancelled first.
 */
export function waitForSubagentApproval(
  approvalId: string,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const done = (allowed: boolean) => {
      approvals.delete(approvalId);
      signal.removeEventListener("abort", onAbort);
      resolve(allowed);
    };
    const onAbort = () => done(false);
    approvals.set(approvalId, done);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** The card's Allow and Reject buttons. */
export function answerSubagentApproval(
  approvalId: string,
  allowed: boolean,
): boolean {
  const resolve = approvals.get(approvalId);
  if (!resolve) return false;
  resolve(allowed);
  return true;
}
