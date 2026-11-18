import {
  type Offender,
  type PromptSegment,
  canonicalTools,
  makeSegment,
} from "core/llm/promptSegments.js";
import type { ChatCompletionTool } from "openai/resources.mjs";

import { SYSTEM_MARKERS } from "./systemMessageMarkers.js";
import { ALL_BUILT_IN_TOOLS } from "./tools/allBuiltIns.js";

/**
 * Describes, without changing anything, the segments the CLI's chat request
 * carries (core/llm/promptSegments.ts), from the same inputs
 * `buildChatRequestBody` takes: the system message (split at the markers
 * `constructSystemMessage` writes), the tool list, the environment block, the
 * task list block and the turn tail. Nothing here is sent.
 */

export interface CliRequestFacts {
  systemMessage: string;
  tools: readonly ChatCompletionTool[];
  /** The environment block the request puts in the first user message. */
  environmentBlock?: string;
  taskListBlock?: string;
  turnTail?: string;
  /** The prompt profile of the turn text (full, short, tailored). */
  profile?: string;
  /** The request's messages after the system message, as sent. */
  history: unknown;
  /** Text a subagent's executor appends after the base message. */
  subagentPrompt?: string;
}

const BUILT_IN_NAMES = new Set(ALL_BUILT_IN_TOOLS.map((t) => t.name));
const REGISTRY_TOOLS = new Set(["Subagent", "Skills"]);

function toolSegments(
  tools: readonly ChatCompletionTool[],
  mode: "plan" | "agent",
): PromptSegment[] {
  if (tools.length === 0) return [];
  const names = tools.map(
    (t) => (t as { function: { name: string } }).function.name,
  );
  const builtin = tools.filter((_, i) => BUILT_IN_NAMES.has(names[i]));
  const mcp = tools.filter((_, i) => !BUILT_IN_NAMES.has(names[i]));
  const events: Offender[] = ["mode-switch"];
  if (names.includes("TaskList") || names.includes("FinishItem")) {
    events.push("tool-list-event");
  }
  if (names.some((n) => REGISTRY_TOOLS.has(n))) {
    events.push("registry-in-tool-description");
  }
  const out = [
    makeSegment({
      id: `tools.builtin@${mode}`,
      source: "builtin",
      stability: "static",
      region: "tools",
      text: canonicalTools(builtin),
      exposedTo: events,
    }),
  ];
  if (mcp.length > 0) {
    out.push(
      makeSegment({
        id: "tools.mcp",
        source: "mcp",
        stability: "session",
        region: "tools",
        text: canonicalTools(mcp),
        // The CLI keeps MCP tools in connection order (the IDE sorts them).
        exposedTo: ["mcp-order"],
      }),
    );
  }
  return out;
}

/** The system message cut at the markers the builder writes. */
function systemSegments(
  text: string,
  profile: string,
  subagentPrompt?: string,
): { segments: PromptSegment[]; mode: "plan" | "agent" } {
  const cuts: { id: string; at: number; offenders?: Offender[] }[] = [];
  let cursor = 0;
  let mode: "plan" | "agent" = "agent";
  const find = (marker: string, id: string, offenders?: Offender[]) => {
    const at = text.indexOf(marker, cursor);
    if (at < 0) return false;
    cuts.push({ id, at, offenders });
    cursor = at + marker.length;
    return true;
  };
  if (find(SYSTEM_MARKERS.plan, `turn.plan@${profile}`, ["mode-switch"])) {
    mode = "plan";
  } else {
    find(SYSTEM_MARKERS.agent, `turn.act@${profile}`, ["mode-switch"]);
  }
  find(SYSTEM_MARKERS.commit, "attribution");
  find(SYSTEM_MARKERS.headless, "headless");
  find(SYSTEM_MARKERS.json, "json-format");
  find(SYSTEM_MARKERS.rules, "rules.user", ["instruction-file-edit"]);
  const boundaries = [
    { id: "preamble", at: 0, offenders: undefined as Offender[] | undefined },
    ...cuts,
  ];
  const segments = boundaries.map((b, i) => {
    let end = boundaries[i + 1]?.at ?? text.length;
    let piece = text.slice(b.at, end);
    // A subagent's own prompt follows the last part: its own segment.
    if (
      i === boundaries.length - 1 &&
      subagentPrompt &&
      piece.endsWith(subagentPrompt)
    ) {
      end = text.length - subagentPrompt.length;
      piece = text.slice(b.at, end);
    }
    return makeSegment({
      id: b.id,
      source: b.id.startsWith("rules")
        ? "rules"
        : b.id.startsWith("turn") || b.id === "attribution"
          ? "mode"
          : "builtin",
      stability: b.id === "rules.user" ? "session" : "static",
      region: "system",
      text: piece,
      exposedTo: b.offenders,
    });
  });
  if (subagentPrompt && text.endsWith(subagentPrompt)) {
    segments.push(
      makeSegment({
        id: "subagent.prompt",
        source: "mode",
        // Differs per subagent while the rules before it are shared by all
        // of them, so it is the more volatile of the two and belongs last.
        stability: "session",
        region: "system",
        text: subagentPrompt,
      }),
    );
  }
  return { segments, mode };
}

/** The manifest of the request `buildChatRequestBody(facts)` builds. */
export function describeCliRequest(facts: CliRequestFacts): PromptSegment[] {
  const { segments: system, mode } = systemSegments(
    facts.systemMessage,
    facts.profile ?? "full",
    facts.subagentPrompt,
  );
  const out: PromptSegment[] = [...toolSegments(facts.tools, mode), ...system];
  if (facts.environmentBlock) {
    out.push(
      makeSegment({
        id: "env.date+git",
        source: "environment",
        stability: "session",
        region: "first-user",
        text: facts.environmentBlock,
        // No cap on the status text, and a resumed run takes a new snapshot.
        exposedTo: ["uncapped-git-status"],
      }),
    );
  }
  out.push(
    makeSegment({
      id: "history",
      source: "history",
      stability: "turn",
      region: "history",
      text: JSON.stringify(facts.history),
    }),
  );
  if (facts.turnTail) {
    out.push(
      makeSegment({
        id: "tail.turn",
        source: "tail",
        stability: "turn",
        region: "tail",
        text: facts.turnTail,
      }),
    );
  }
  if (facts.taskListBlock) {
    out.push(
      makeSegment({
        id: "task-list",
        source: "task-list",
        stability: "request",
        region: "tail",
        text: facts.taskListBlock,
      }),
    );
  }
  return out;
}
