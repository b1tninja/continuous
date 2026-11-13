import type {
  IDE,
  InternalMcpOptions,
  InternalSseMcpOptions,
  InternalStdioMcpOptions,
  InternalStreamableHttpMcpOptions,
} from "../..";
import MCPConnection from "../../context/mcp/MCPConnection";
import { probeAuthRequirement } from "../../context/mcp/mcpAuthProbe";
import { suspiciousToolDefinitions } from "../../context/mcp/toolPinning";
import { maskCommandForDisplay } from "../../tools/permissions/displayMask";
import { detectInstructionLikeText } from "../../tools/permissions/injection";

import type { McpServerDraft, McpWizardTransport } from "./types";
import { normalizeUntrustedText } from "./untrustedText";

/*
  MCPW3: "Test connection" for a server that is not saved yet. It starts or
  connects through the same MCPConnection a real run uses (same environment,
  same Windows cmd.exe wrapping, same transports and fallbacks), lists tools,
  resources and prompts, and disconnects. It never sends tools/call, never
  reads a resource and never fetches a prompt. The caller must have asked
  the person first: a probe of a stdio server runs its command.

  Everything returned is data for the review screen: descriptions are
  normalised and checked for instruction-like text, and stderr and error text
  are masked before they leave this function.
*/

export const DEFAULT_PROBE_TIMEOUT_MS = 20_000;
/** Characters of the server's stderr kept, from the end. */
export const DEFAULT_STDERR_CAP = 64 * 1024;
const STDERR_LINES = 20;

export interface ProbeOptions {
  timeoutMs?: number;
  stderrCap?: number;
  /** For the working folder and a stored sign-in, as in a real run. */
  ide?: IDE;
  /** Where the probe runs; defaults to this process. Used for the hints. */
  platform?: NodeJS.Platform;
}

export interface ProbeTool {
  name: string;
  description: string;
  truncated: boolean;
  /** Labels of the instruction-like patterns found; empty when none. */
  instructionLike: string[];
  /** The server says it changes nothing. A claim, not a fact. */
  readOnlyHint?: boolean;
}

export type ProbeHintCode =
  | "install-node"
  | "install-uv"
  | "install-docker"
  | "command-not-found"
  | "windows-cmd"
  | "timeout"
  | "exited"
  | "sign-in"
  | "needs-key"
  | "tls"
  | "no-tools";

export interface ProbeHint {
  code: ProbeHintCode;
  text: string;
  /** A page to open in the browser; nothing is fetched. */
  link?: string;
}

export interface McpProbeResult {
  ok: boolean;
  status: "connected" | "error" | "timeout";
  durationMs: number;
  transport: McpWizardTransport;
  tools: ProbeTool[];
  resources: { name: string; uri: string }[];
  prompts: { name: string; description: string }[];
  /** Masked. */
  errors: string[];
  /** Masked, without HTML. */
  infos: string[];
  /** The last lines of the server's stderr, masked. */
  stderr: { lines: string[]; truncated: boolean };
  hints: ProbeHint[];
  needsSignIn: boolean;
  /** One line for the success screen. */
  notice: string;
}

/** The connection a real run would make, with pin evaluation left out. */
class ProbeConnection extends MCPConnection {
  // A probe must not adopt, compare or record tool pins: the server is not
  // saved yet and the person has not approved a call. Pin at Add is MCPW17.
  override async refreshPins(): Promise<void> {}
  override async recordToolUse(): Promise<void> {}

  /**
   * MCPConnection keeps stderr in a private string with no cap (MCPW19,
   * #738 adds a bounded buffer). Until that lands the probe reads it here
   * and caps and masks it itself.
   */
  stderrText(): string {
    const out = (this as unknown as { stdioOutput?: { stderr?: string } })
      .stdioOutput;
    return out?.stderr ?? "";
  }
}

export function draftToOptions(
  draft: McpServerDraft,
  timeoutMs: number,
): InternalMcpOptions {
  const id = `wizard-probe-${draft.name}`;
  const base = { id, name: draft.name, timeout: timeoutMs };
  const headers = Object.fromEntries(
    (draft.headers ?? []).map((h) => [h.name, h.value]),
  );
  if (draft.transport === "stdio") {
    const o: InternalStdioMcpOptions = {
      ...base,
      // `type` set: MCPConnection only adds the process output to its error
      // message for an explicit stdio entry
      type: "stdio",
      command: draft.command ?? "",
      args: draft.args ?? [],
      env: Object.fromEntries((draft.env ?? []).map((e) => [e.name, e.value])),
      ...(draft.cwd ? { cwd: draft.cwd } : {}),
    };
    return o;
  }
  const remote = {
    ...base,
    url: draft.url ?? "",
    ...(Object.keys(headers).length ? { requestOptions: { headers } } : {}),
  };
  return draft.transport === "sse"
    ? ({ ...remote, type: "sse" } satisfies InternalSseMcpOptions)
    : ({
        ...remote,
        type: "streamable-http",
      } satisfies InternalStreamableHttpMcpOptions);
}

/** Mask the draft's own values first (exact match), then every known shape. */
function masker(draft: McpServerDraft): (text: string) => string {
  const known = [...(draft.env ?? []), ...(draft.headers ?? [])]
    .map((v) => v.value.replace(/^(?:Bearer|Basic|Token)\s+/i, ""))
    .filter((v) => v.length >= 6)
    .sort((a, b) => b.length - a.length);
  return (text: string) => {
    let out = text;
    for (const v of known) out = out.split(v).join("«masked:value»");
    return maskCommandForDisplay(out);
  };
}

export async function probeMcpServer(
  draft: McpServerDraft,
  opts: ProbeOptions = {},
): Promise<McpProbeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const stderrCap = opts.stderrCap ?? DEFAULT_STDERR_CAP;
  const platform = opts.platform ?? process.platform;
  const mask = masker(draft);
  const started = Date.now();
  const conn = new ProbeConnection(
    draftToOptions(draft, timeoutMs),
    opts.ide ? { ide: opts.ide } : undefined,
  );
  const abort = new AbortController();
  let guardTimer: ReturnType<typeof setTimeout> | undefined;
  let guardFired = false;
  try {
    // MCPConnection has its own timeout; this guard is for a step it does
    // not cover (an IDE call that never answers)
    await Promise.race([
      conn.connectClient(true, abort.signal),
      new Promise<void>((resolve) => {
        guardTimer = setTimeout(() => {
          guardFired = true;
          abort.abort();
          resolve();
        }, timeoutMs + 2_000);
      }),
    ]);
  } finally {
    if (guardTimer) clearTimeout(guardTimer);
  }
  const durationMs = Date.now() - started;
  const status = conn.getStatus();
  const stderrRaw = conn.stderrText();
  try {
    await conn.disconnect();
  } catch {
    // already closed, or the process never started
  }

  const connected = status.status === "connected" && !guardFired;
  const errors = status.errors.map(mask);
  const timedOut =
    guardFired || errors.some((e) => /connection timed out/i.test(e));

  const suspicious = new Map<string, string[]>();
  for (const s of suspiciousToolDefinitions(
    status.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  )) {
    suspicious.set(s.name, [...(suspicious.get(s.name) ?? []), ...s.ids]);
  }
  const tools: ProbeTool[] = status.tools.map((t) => {
    const n = normalizeUntrustedText(t.description ?? "");
    const labels = new Set(
      detectInstructionLikeText(t.description ?? "").map((m) => m.label),
    );
    if (suspicious.has(t.name) && labels.size === 0) {
      labels.add("its definition contains text that reads like instructions");
    }
    if (n.hadHiddenCharacters) labels.add("contains hidden characters");
    return {
      name: normalizeUntrustedText(t.name, 128).text,
      description: n.text,
      truncated: n.truncated,
      instructionLike: [...labels],
      ...(t.annotations?.readOnlyHint === undefined
        ? {}
        : { readOnlyHint: t.annotations.readOnlyHint }),
    };
  });

  const capped =
    stderrRaw.length > stderrCap ? stderrRaw.slice(-stderrCap) : stderrRaw;
  const lines = mask(capped)
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");
  const stderr = {
    lines: lines.slice(-STDERR_LINES),
    truncated: stderrRaw.length > stderrCap || lines.length > STDERR_LINES,
  };

  let needsSignIn = false;
  let hasMetadata = false;
  if (!connected && draft.transport !== "stdio" && status.isProtectedResource) {
    needsSignIn = true;
    const auth = await probeAuthRequirement(draft.url ?? "");
    hasMetadata = !!auth.resourceMetadataUrl;
  }

  const hints = connected
    ? tools.length === 0
      ? [
          {
            code: "no-tools" as const,
            text: "Connected, but the server offers no tools. It may offer resources or prompts only.",
          },
        ]
      : []
    : failureHints({
        draft,
        errors,
        timedOut,
        stderrLines: stderr.lines.length,
        needsSignIn,
        hasMetadata,
        platform,
        timeoutMs,
      });

  return {
    ok: connected,
    status: connected ? "connected" : timedOut ? "timeout" : "error",
    durationMs,
    transport: draft.transport,
    tools,
    resources: status.resources.map((r) => ({
      name: normalizeUntrustedText(r.name, 256).text,
      uri: normalizeUntrustedText(r.uri, 512).text,
    })),
    prompts: status.prompts.map((p) => ({
      name: normalizeUntrustedText(p.name, 128).text,
      description: normalizeUntrustedText(p.description ?? "").text,
    })),
    errors,
    infos: status.infos.map((i) =>
      mask(i.replace(/<a [^>]*>([^<]*)<\/a>/g, "$1").replace(/<[^>]+>/g, "")),
    ),
    stderr,
    hints,
    needsSignIn,
    notice: "Results from this server are treated as untrusted text.",
  };
}

function programOf(command: string | undefined): string {
  const base = (command ?? "").split(/[\\/]/).pop() ?? "";
  return base.toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
}

export function failureHints(a: {
  draft: McpServerDraft;
  errors: string[];
  timedOut: boolean;
  stderrLines: number;
  needsSignIn: boolean;
  hasMetadata: boolean;
  platform: NodeJS.Platform;
  timeoutMs: number;
}): ProbeHint[] {
  const hints: ProbeHint[] = [];
  const text = a.errors.join("\n");
  // ENOENT from spawn; on Windows cross-spawn goes through cmd.exe, which
  // answers "is not recognized" instead
  const notFound =
    /spawn \S+ ENOENT|command "[^"]*" not found|is not recognized as an internal or external command|: command not found/i.test(
      text,
    );
  if (notFound) {
    const prog = programOf(a.draft.command);
    if (["npx", "node", "pnpx", "npm"].includes(prog)) {
      hints.push({
        code: "install-node",
        text: `\`${prog}\` was not found. Install Node.js (it includes npx), then restart your editor so the PATH is refreshed.`,
        link: "https://nodejs.org/en/download",
      });
    } else if (["uvx", "uv"].includes(prog)) {
      hints.push({
        code: "install-uv",
        text: `\`${prog}\` was not found. Install uv, then restart your editor so the PATH is refreshed.`,
        link: "https://docs.astral.sh/uv/getting-started/installation/",
      });
    } else if (["docker", "podman"].includes(prog)) {
      hints.push({
        code: "install-docker",
        text: "Docker was not found, or the Docker app is not running.",
      });
    } else {
      hints.push({
        code: "command-not-found",
        text: `\`${prog || "The command"}\` was not found on the PATH your editor uses. Give the full path, or start the editor from a terminal where \`${prog}\` works.`,
      });
    }
  }
  if (
    !notFound &&
    a.platform === "win32" &&
    ["npx", "uvx", "uv", "pnpx", "bunx"].includes(programOf(a.draft.command)) &&
    /syntax|is not recognized|not recognised|unexpected/i.test(text)
  ) {
    hints.push({
      code: "windows-cmd",
      text: "On Windows this server is started through cmd.exe. If your arguments contain quotes or spaces, try the JSON form or report it.",
    });
  }
  if (a.timedOut) {
    const seconds = Math.round(a.timeoutMs / 1000);
    hints.push({
      code: "timeout",
      text: `The server did not answer within ${seconds} seconds. The first run of npx or uvx can take longer while it downloads the package. Try again, or raise the timeout.`,
    });
  } else if (!notFound && a.draft.transport === "stdio" && a.stderrLines > 0) {
    hints.push({
      code: "exited",
      text: "The server stopped before it answered. Its last output is shown below.",
    });
  }
  if (a.needsSignIn) {
    hints.push(
      a.hasMetadata
        ? { code: "sign-in", text: "This server needs you to sign in." }
        : {
            code: "needs-key",
            text: "This server needs a key. Add a header such as Authorization.",
          },
    );
  }
  if (/certificate|self[- ]signed|UNABLE_TO_VERIFY|CERT_/i.test(text)) {
    hints.push({
      code: "tls",
      text: "The server's certificate was not accepted. If you are behind a company proxy, turn on useSystemCa or set caBundlePath for this server.",
    });
  }
  return hints;
}
