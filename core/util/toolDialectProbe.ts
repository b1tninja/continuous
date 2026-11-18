/**
 * The add-model wizard's tool-call probe: one request with a made-up tool, the
 * reply classified, and a one-line label for the result. The sender is passed
 * in, so this module sends nothing and the calls in the reply are never run.
 * Design: plans/tool-dialect-detection.md, section 4.
 */
import {
  ACCEPT_THRESHOLD,
  classifyToolReply,
  type Classification,
  PROBE_TOOL_NAME,
  type ProbeRequest,
  probeRequestFor,
  type ToolReply,
  verifyProbeCalls,
} from "./toolDialectDetect.js";
import {
  describePreset,
  resolveToolDialectPreset,
} from "./toolDialectPresets.js";
import {
  type MeasuredFacts,
  surfaceFactsLine,
  surfaceFamily,
  type SurfaceQuery,
} from "./surfaceFacts.js";

export type ToolCallSupport =
  | { kind: "native"; intact: boolean; issues: string[] }
  | { kind: "text"; dialect: string }
  | { kind: "none" }
  | { kind: "unknown" };

export interface ToolDialectProbeResult {
  support: ToolCallSupport;
  /** "Tool calls: native", "Tool calls: written as text (qwen-xml)", "Tool use: could not tell" */
  label: string;
  /** The model-family preset's one-liner (toolDialectPresets.ts), when the model has one. */
  preset?: string;
  /** The server parses this model's calls itself; no recovery is suggested. */
  serverParses?: boolean;
  /** "Provider facts: ..." from the surface facts file: information only, gates nothing. */
  facts?: string;
}

/** The wizard's result line for a support verdict. */
export function labelFor(support: ToolCallSupport): string {
  switch (support.kind) {
    case "native":
      return support.intact
        ? "Tool calls: native"
        : "Tool calls: native (arguments came back altered)";
    case "text":
      return `Tool calls: written as text (${support.dialect})`;
    case "none":
      return "Tool calls: not supported";
    default:
      return "Tool use: could not tell";
  }
}

/** What a reply to the probe says about the model. */
export function supportFromReply(
  reply: ToolReply,
  classification: Classification = classifyToolReply({
    ...reply,
    knownTools: [PROBE_TOOL_NAME],
  }),
): ToolCallSupport {
  const { dialect, confidence } = classification;
  if (dialect === "native-structured") {
    const v = verifyProbeCalls(reply.toolCalls ?? []);
    return { kind: "native", intact: v.argumentsIntact, issues: v.issues };
  }
  if (dialect === "prose" && confidence >= ACCEPT_THRESHOLD) {
    return { kind: "none" };
  }
  if (dialect !== "prose" && dialect !== "unknown") {
    return confidence >= ACCEPT_THRESHOLD
      ? { kind: "text", dialect }
      : { kind: "unknown" };
  }
  return { kind: "unknown" };
}

/** A server's refusal of the tools parameter itself: the model has no tool format. */
function refusedTools(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    /tool/i.test(msg) && /(not support|unsupported|n't support)/i.test(msg)
  );
}

/**
 * Send the probe through `send` and say what came back. A timeout or any other
 * failure is "unknown", never "not supported"; only a reply of plain prose or
 * the server saying it takes no tools is. With `model`, the result also
 * carries what the family preset says; the preset never changes the verdict.
 */
export async function probeToolDialect(
  send: (request: ProbeRequest) => Promise<ToolReply>,
  model?: string,
  options: {
    serverParses?: boolean;
    /** `/api/show` listed capabilities and `tools` is not among them: do not probe. */
    toolsAdvertised?: boolean;
    /** The provider/engine/API surface, with the label to show for it. */
    surface?: { query: SurfaceQuery; label: string };
    /** What earlier probes of this exact endpoint measured (core/util/measuredFacts.ts). */
    measured?: MeasuredFacts;
  } = {},
): Promise<ToolDialectProbeResult> {
  let support: ToolCallSupport;
  if (options.toolsAdvertised === false) {
    // The server lists capabilities without `tools`: nothing to probe.
    support = { kind: "none" };
  } else
    try {
      support = supportFromReply(await send(probeRequestFor()));
    } catch (e) {
      support = refusedTools(e) ? { kind: "none" } : { kind: "unknown" };
    }
  const preset = options.serverParses
    ? undefined
    : resolveToolDialectPreset(model);
  const family = surfaceFamily(resolveToolDialectPreset(model)?.id, model);
  const facts = options.surface
    ? surfaceFactsLine(options.surface.label, {
        ...options.surface.query,
        modelFamily: family,
        ...(options.measured ? { measured: options.measured } : {}),
      })
    : undefined;
  return {
    support,
    label: labelFor(support),
    ...(facts ? { facts } : {}),
    ...(options.serverParses ? { serverParses: true } : {}),
    ...(preset ? { preset: describePreset(preset) } : {}),
  };
}
