/**
 * One sentence for "the model server on this machine or this network could
 * not be reached": which host and port, what happened, and what to check.
 * It is keyed on the kind of address (loopback or private range), not on one
 * server's default address, so Ollama on another machine, llama.cpp on 8080
 * and LM Studio on 1234 all get it. Pure: the GUI reads it too.
 */
import { openAICompatDefaultBase } from "../util/openaiCompatBases.js";

export type ConnectionFailureKind =
  "refused" | "timed-out" | "not-found" | "failed";

export interface LocalServerTarget {
  provider?: string;
  apiBase?: string;
}

export interface LocalServerAddress {
  /** What to call the server: "Ollama", or "the model server". */
  name: string;
  /** Host and port as one would type them: "192.168.1.50:11434". */
  hostPort: string;
  /** "localhost", an address, or a name ending in .local. */
  hostname: string;
  /** This machine, as opposed to another one on the network. */
  loopback: boolean;
}

const SERVER_NAMES: Record<string, string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  "llama.cpp": "llama.cpp",
  llamafile: "llamafile",
  lemonade: "Lemonade",
  vllm: "vLLM",
};

function ipv4Octets(host: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return undefined;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o <= 255) ? octets : undefined;
}

function isLoopbackHostname(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    ipv4Octets(host)?.[0] === 127
  );
}

/**
 * Loopback, the private IPv4 ranges (10/8, 172.16/12, 192.168/16), and the
 * names that only resolve on the local network.
 */
export function isLocalServerHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isLoopbackHostname(host)) return true;
  if (host.endsWith(".local") || host === "host.docker.internal") return true;
  const o = ipv4Octets(host);
  if (!o) return false;
  return (
    o[0] === 10 ||
    (o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||
    (o[0] === 192 && o[1] === 168)
  );
}

/** The host and port of a local or private-range `apiBase`, or undefined for any other. */
export function localServerAddress(
  target: LocalServerTarget,
): LocalServerAddress | undefined {
  const provider = target.provider?.toLowerCase() ?? "";
  const base = target.apiBase?.trim() || openAICompatDefaultBase(provider);
  if (!base) return undefined;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return undefined;
  }
  if (!isLocalServerHostname(url.hostname)) return undefined;
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const bare = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return {
    name: SERVER_NAMES[provider] ?? "the model server",
    hostPort: `${url.hostname}:${port}`,
    hostname: bare,
    loopback: isLoopbackHostname(bare),
  };
}

const REFUSED_CODES = new Set(["ECONNREFUSED"]);
const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const NOT_FOUND_CODES = new Set(["ENOTFOUND", "EAI_AGAIN"]);
const UNREACHABLE_CODES = new Set([
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "ENETUNREACH",
  "ENETDOWN",
  "EADDRNOTAVAIL",
]);

function kindOfCode(code: unknown): ConnectionFailureKind | undefined {
  if (typeof code !== "string") return undefined;
  if (REFUSED_CODES.has(code)) return "refused";
  if (TIMEOUT_CODES.has(code)) return "timed-out";
  if (NOT_FOUND_CODES.has(code)) return "not-found";
  if (UNREACHABLE_CODES.has(code)) return "failed";
  return undefined;
}

function* causeChain(error: unknown): Generator<Record<string, unknown>> {
  let current: unknown = error;
  for (let i = 0; i < 6 && current && typeof current === "object"; i++) {
    yield current as Record<string, unknown>;
    current = (current as { cause?: unknown }).cause;
  }
}

/**
 * How a connection that never got an answer failed, or undefined when the
 * error is something else: a reply with an HTTP status, a cancelled request,
 * or a connection lost in the middle of a reply (that one has its own
 * message in utils/streamRetry.ts).
 */
export function connectionFailureKind(
  error: unknown,
): ConnectionFailureKind | undefined {
  let fromMessage: ConnectionFailureKind | undefined;
  for (const e of causeChain(error)) {
    if (e.name === "AbortError") return undefined;
    if (typeof e.status === "number" || e.response) return undefined;
    const fromCode = kindOfCode(e.code);
    if (fromCode) return fromCode;
    const message = typeof e.message === "string" ? e.message : "";
    if (/in the middle of the response/.test(message)) return undefined;
    // A code that only survived inside the text, e.g. node-fetch's
    // "request to ... failed, reason: connect ECONNREFUSED 127.0.0.1:8080"
    const named = /\b(E[A-Z]{4,}|UND_ERR_[A-Z_]+)\b/.exec(message);
    fromMessage ??= kindOfCode(named?.[1]);
    // What undici and the OpenAI SDK say when they give no code
    if (/\bfetch failed\b/i.test(message) || message === "Connection error.") {
      fromMessage ??= "failed";
    } else if (message === "Request timed out.") {
      fromMessage ??= "timed-out";
    }
  }
  return fromMessage;
}

// The editor reads these back to offer "Start Ollama" and the like
// (localServerFixFor), so they are written in one place.
const OLLAMA_NOT_INSTALLED =
  "Ollama does not seem to be installed on this computer.";
const OLLAMA_START = "To start Ollama, run `ollama serve`.";
const LEMONADE_NOT_INSTALLED =
  "Lemonade does not seem to be installed on this computer.";

const WHAT_HAPPENED: Record<ConnectionFailureKind, string> = {
  refused: "The connection was refused.",
  "timed-out": "The connection timed out.",
  "not-found": "The host name could not be found.",
  failed: "The connection failed.",
};

/**
 * The sentences for one failed connection, or undefined when the address is
 * not a local or private-range one. `installed: false` is for a server the
 * caller looked for on this machine and did not find.
 */
export function describeLocalServerFailure(
  target: LocalServerTarget,
  kind: ConnectionFailureKind,
  options: { installed?: boolean } = {},
): string | undefined {
  const address = localServerAddress(target);
  if (!address) return undefined;
  const provider = target.provider?.toLowerCase() ?? "";
  const parts = [
    `Could not reach ${address.name} at ${address.hostPort}.`,
    WHAT_HAPPENED[kind],
    kind === "not-found"
      ? "Check the host name in apiBase, and that the server is running."
      : "Check that the server is running, that the port is right, and that it listens on this address.",
  ];

  if (address.hostname === "localhost") {
    parts.push(
      "The name localhost can mean 127.0.0.1 or ::1. If the server listens on only one of them, put that address in apiBase.",
    );
  } else if (!address.loopback && kind !== "not-found") {
    parts.push(
      provider === "ollama"
        ? "Ollama accepts connections from other machines only when OLLAMA_HOST is set on the machine that runs it, for example to 0.0.0.0."
        : "A server that listens only on 127.0.0.1 does not accept connections from other machines.",
    );
    if (kind === "timed-out") {
      parts.push("A firewall on that machine can also block the port.");
    }
  }

  // Hints that belong to one server, whatever address it is on
  const notInstalled = address.loopback && options.installed === false;
  if (provider === "ollama") {
    parts.push(
      notInstalled
        ? OLLAMA_NOT_INSTALLED
        : address.loopback
          ? OLLAMA_START
          : "To start Ollama, run `ollama serve` on that machine.",
    );
  } else if (provider === "lemonade") {
    if (notInstalled) {
      parts.push(LEMONADE_NOT_INSTALLED);
    }
    parts.push("See http://lemonade-server.ai for setup instructions.");
  }
  return parts.join(" ");
}

/** True for a message `describeLocalServerFailure` wrote. */
export function isLocalServerFailureMessage(message: string): boolean {
  return /^Could not reach .+ at \S+:\d+\. /.test(message);
}

export type LocalServerFix =
  "start-ollama" | "download-ollama" | "start-lemonade";

/**
 * What can be done on this machine about a message written above: start the
 * server, or get it. Nothing for a server on another machine.
 */
export function localServerFixFor(message: string): LocalServerFix | undefined {
  const m = /^Could not reach (.+) at (\S+):\d+\. /.exec(message);
  if (!m || !isLoopbackHostname(m[2].replace(/^\[|\]$/g, ""))) {
    return undefined;
  }
  if (m[1] === "Ollama") {
    if (message.includes(OLLAMA_NOT_INSTALLED)) return "download-ollama";
    return message.includes(OLLAMA_START) ? "start-ollama" : undefined;
  }
  if (m[1] === "Lemonade" && !message.includes(LEMONADE_NOT_INSTALLED)) {
    return "start-lemonade";
  }
  return undefined;
}

/**
 * A failed connection to a local server, with the sentence as its message.
 * It keeps the original error as `cause` and its `code`, so the retry and
 * failover checks that read them still see a connection failure.
 */
export class LocalServerError extends Error {
  code?: string;

  constructor(
    message: string,
    public kind: ConnectionFailureKind,
    cause: unknown,
  ) {
    super(message, { cause });
    this.name = "LocalServerError";
    for (const e of causeChain(cause)) {
      if (typeof e.code === "string") {
        this.code = e.code;
        break;
      }
    }
  }
}

/** The LocalServerError an error is or wraps, if any. */
export function heldLocalServerError(
  error: unknown,
): LocalServerError | undefined {
  for (const e of causeChain(error)) {
    if (e instanceof LocalServerError) return e;
  }
  return undefined;
}

/**
 * `error` as a LocalServerError when it is a connection to a local or
 * private-range `apiBase` that got no answer; undefined for anything else.
 * An error that already holds one (wrapped by a retry) gives that one back.
 */
export function localServerError(
  error: unknown,
  target: LocalServerTarget,
  options: { installed?: boolean } = {},
): LocalServerError | undefined {
  const kind = connectionFailureKind(error);
  if (!kind) return undefined;
  const held = heldLocalServerError(error);
  if (held) return held;
  const message = describeLocalServerFailure(target, kind, options);
  return message ? new LocalServerError(message, kind, error) : undefined;
}
