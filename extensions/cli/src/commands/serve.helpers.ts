import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

import chalk from "chalk";
import type { ChatHistoryItem, Session, ToolStatus } from "core/index.js";
import { createHistoryItem } from "core/util/messageConversion.js";
import type { Express, NextFunction, Request, Response } from "express";

import { runTurnWithStopHooks } from "../hooks/lifecycleHooks.js";
import {
  describePromptBlocked,
  runUserPromptSubmitHooks,
} from "../hooks/promptHook.js";
import { withLoopSteering } from "../loop/loopSession.js";
import { services } from "../services/index.js";
import {
  mergeQueuedMessages,
  MessageQueue,
  messageQueue,
} from "../stream/messageQueue.js";
import { streamChatResponse } from "../stream/streamChatResponse.js";
import { StreamCallbacks } from "../stream/streamChatResponse.types.js";
import { logger } from "../util/logger.js";

import {
  MAX_FAILED_AUTH_PER_MINUTE,
  rateLimitMiddleware,
  WindowCounter,
} from "./serve.auth.js";

/**
 * Where `cn serve` listens, and who may talk to it (plans/policy-areas.md,
 * "cn serve"). The server takes messages, approvals and loop answers, and
 * will take the policy levels, so anything that can reach the port can act
 * as the person. It listens on loopback unless `--host` says otherwise.
 * A bearer token is optional on loopback and required off it; when one is
 * given every request carries it, in the Authorization header and nowhere else. The Host
 * header must name the interface the server is bound to, and a request that
 * carries an Origin header is refused unless `--allow-origin` lists it.
 */

export const DEFAULT_SERVE_HOST = "127.0.0.1";

/** True for an address only this computer can reach. */
export function isLoopbackHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h === "::1" ||
    h === "0:0:0:0:0:0:0:1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
  );
}

/** The host from a Host header, without a port and without IPv6 brackets. */
export function hostHeaderName(hostHeader: string | undefined): string {
  const raw = (hostHeader ?? "").trim();
  if (!raw) return "";
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(raw);
  if (bracketed) return bracketed[1];
  // A single colon is host:port. More than one is an IPv6 address.
  const port = /:(\d+)$/.exec(raw);
  if (port && raw.indexOf(":") === raw.lastIndexOf(":")) {
    return raw.slice(0, -port[0].length);
  }
  return raw;
}

/** The port in a Host header, when it names one. */
export function hostHeaderPort(
  hostHeader: string | undefined,
): string | undefined {
  const raw = (hostHeader ?? "").trim();
  const bracketed = /^\[[^\]]+\]:(\d+)$/.exec(raw);
  if (bracketed) return bracketed[1];
  return /^[^:]+:(\d+)$/.exec(raw)?.[1];
}

const UNSPECIFIED_HOSTS = new Set(["0.0.0.0", "::", "0:0:0:0:0:0:0:0"]);

/**
 * Whether this request's Host header is the interface the server bound, and
 * the port when it names one. On loopback, only a loopback name or address
 * is accepted.
 */
export function hostHeaderAllowed(
  hostHeader: string | undefined,
  boundHost: string,
  port?: number,
): boolean {
  const presented = hostHeaderName(hostHeader);
  if (!presented) return false;
  const presentedPort = hostHeaderPort(hostHeader);
  if (port !== undefined && presentedPort && presentedPort !== String(port)) {
    return false;
  }
  if (isLoopbackHost(boundHost)) return isLoopbackHost(presented);
  const bound = boundHost
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (UNSPECIFIED_HOSTS.has(bound)) return true;
  return presented.toLowerCase() === bound;
}

/** An origin as it is compared: lower case, no trailing slash. */
function normalizeOrigin(origin: string): string {
  return origin.trim().toLowerCase().replace(/\/+$/, "");
}

/** Whether `--allow-origin` may list this value. No wildcard, no "null". */
export function validAllowedOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.host;
  } catch {
    return false;
  }
}

/**
 * A browser sends Origin; curl and other local clients do not. An Origin is
 * accepted only when it is on the allowlist exactly.
 */
export function originHeaderAllowed(
  origin: string | undefined,
  allowed: readonly string[] = [],
): boolean {
  if (origin === undefined || origin.trim() === "") return true;
  const wanted = normalizeOrigin(origin);
  return allowed.some((a) => normalizeOrigin(a) === wanted);
}

export interface ServeRequestProblem {
  status: 403;
  error: string;
}

/**
 * Why this request must be refused before it is authenticated, or undefined
 * when the Host and Origin headers are acceptable.
 */
export function serveRequestProblem(
  headers: { host?: string; origin?: string; secFetchSite?: string },
  boundHost: string,
  options: { port?: number; allowedOrigins?: readonly string[] } = {},
): ServeRequestProblem | undefined {
  if (!hostHeaderAllowed(headers.host, boundHost, options.port)) {
    return {
      status: 403,
      error: isLoopbackHost(boundHost)
        ? "The Host header must be the loopback name or address this server is bound to."
        : "The Host header must match the address this server is bound to.",
    };
  }
  if (!originHeaderAllowed(headers.origin, options.allowedOrigins)) {
    return {
      status: 403,
      error:
        "Requests that carry an Origin header are refused unless the origin is allowed with --allow-origin.",
    };
  }
  // A browser says how the request relates to the page that made it. "none"
  // is the person typing the address; anything else is a page, so refuse. No
  // header at all is a client that is not a browser (curl, Node, the TUI).
  const site = headers.secFetchSite?.trim();
  if (site !== undefined && site.toLowerCase() !== "none") {
    return {
      status: 403,
      error: "Requests made by a web page (Sec-Fetch-Site) are refused.",
    };
  }
  return undefined;
}

/** Methods that carry no body the server reads */
const BODYLESS_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * 415 when a request that carries a body is not JSON. A cross-site form or a
 * text/plain fetch is a "simple" request a page can send without a preflight;
 * refusing every non-JSON body closes that. A POST with no body (/pause,
 * /exit) needs no content type.
 */
export function bodyContentTypeProblem(req: {
  method: string;
  headers: IncomingHttpHeaders;
}): { status: 415; error: string } | undefined {
  if (BODYLESS_METHODS.has(req.method.toUpperCase())) return undefined;
  const length = Number(req.headers["content-length"] ?? 0);
  const chunked = req.headers["transfer-encoding"] !== undefined;
  if (!(length > 0) && !chunked) return undefined;
  const type = (headerValue(req.headers["content-type"]) ?? "")
    .trim()
    .toLowerCase();
  if (type.startsWith("application/json")) return undefined;
  return {
    status: 415,
    error: "A request body must be sent as application/json.",
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(", ") : value;
}

export interface ServeGuardOptions {
  boundHost: string;
  /** The bearer token; undefined when none was given (loopback only) */
  token: string | undefined;
  port?: number;
  allowedOrigins?: readonly string[];
}

/**
 * Refuse a request whose Host is not the bound address or whose Origin is not
 * allowed, limit the request rate per address, then require the bearer token.
 */
export function installServeGuards(
  app: Express,
  options: ServeGuardOptions,
): void {
  const { boundHost, token, port, allowedOrigins = [] } = options;
  app.disable("x-powered-by");
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = headerValue(req.headers.origin);
    const problem = serveRequestProblem(
      {
        host: headerValue(req.headers.host),
        origin,
        secFetchSite: headerValue(req.headers["sec-fetch-site"]),
      },
      boundHost,
      { port, allowedOrigins },
    );
    if (problem) {
      res.status(problem.status).json({ error: problem.error });
      return;
    }
    const bodyProblem = bodyContentTypeProblem(req);
    if (bodyProblem) {
      res.status(bodyProblem.status).json({ error: bodyProblem.error });
      return;
    }
    // An allowed origin gets its own name back, never a wildcard. The
    // preflight carries no Authorization header, so it is answered here.
    if (origin?.trim()) {
      res.setHeader("Access-Control-Allow-Origin", origin.trim());
      res.setHeader("Vary", "Origin");
      if (req.method === "OPTIONS") {
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Authorization, Content-Type",
        );
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.status(204).end();
        return;
      }
    }
    next();
  });
  app.use(rateLimitMiddleware());
  if (token) app.use(bearerTokenMiddleware(token));
}

/** Whether a request's Authorization header carries the token, compared in constant time. */
export function authorizeRequest(
  authorization: string | undefined,
  token: string,
): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
  if (!match) return false;
  const given = Buffer.from(match[1].trim());
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Express middleware: every request must carry the token in the
 * Authorization header. A token in the query string is never read (URLs end
 * up in logs). An address that keeps failing is held off with 429.
 */
export function bearerTokenMiddleware(
  token: string,
  failures: WindowCounter = new WindowCounter(
    MAX_FAILED_AUTH_PER_MINUTE,
    60_000,
  ),
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const who = req.socket.remoteAddress ?? "unknown";
    if (failures.blocked(who)) {
      res.status(429).json({ error: "Too many failed attempts." });
      return;
    }
    if (authorizeRequest(req.header("authorization"), token)) {
      next();
      return;
    }
    failures.hit(who);
    res.status(401).set("WWW-Authenticate", "Bearer").json({
      error: "A bearer token is required in the Authorization header.",
    });
  };
}

/**
 * Remove partial assistant message if the last message is an empty assistant message.
 * Used when a response is interrupted.
 */
export function removePartialAssistantMessage(
  sessionHistory: ChatHistoryItem[],
): void {
  try {
    const svcHistory = services.chatHistory.getHistory();
    const last = svcHistory[svcHistory.length - 1];
    if (last && last.message.role === "assistant" && !last.message.content) {
      services.chatHistory.setHistory(svcHistory.slice(0, -1));
    }
  } catch {
    const lastMessage = sessionHistory[sessionHistory.length - 1];
    if (
      lastMessage &&
      lastMessage.message.role === "assistant" &&
      !lastMessage.message.content
    ) {
      sessionHistory.pop();
    }
  }
}

/**
 * The tool-boundary callback for serve: when a client steered (POST /message
 * with `steer: true`), take the queued plain messages, run them through the
 * UserPromptSubmit hooks as the end of a turn would, and return them as one
 * user message to append after the tool results. A blocked message is
 * answered with a system message, so whoever watches the session sees why.
 */
export async function buildServeSteeringMessage(
  queue: MessageQueue = messageQueue,
): Promise<ChatHistoryItem | undefined> {
  const merged = mergeQueuedMessages(queue.takeSteerMessages());
  if (!merged) return undefined;

  const promptHook = await runUserPromptSubmitHooks(merged.message);
  if (promptHook.blockedReason) {
    try {
      services.chatHistory.addSystemMessage(
        describePromptBlocked(promptHook.blockedReason),
      );
    } catch {
      logger.warn(`A hook blocked a message: ${promptHook.blockedReason}`);
    }
    return undefined;
  }
  return createHistoryItem({ role: "user", content: promptHook.prompt }, []);
}

// Modified version of streamChatResponse that supports interruption
export async function streamChatResponseWithInterruption(
  state: ServerState,
  llmApi: any,
  abortController: AbortController,
  shouldInterrupt: () => boolean,
): Promise<string> {
  // Import the original streamChatResponse logic but add interruption checks
  // Create a wrapper that checks for interruption
  const originalSignal = abortController.signal;
  const checkInterruption = () => {
    if (shouldInterrupt() && !originalSignal.aborted) {
      abortController.abort();
    }
  };

  // Set up periodic interruption checks
  const interruptionChecker = setInterval(checkInterruption, 100);

  // Create callbacks to capture tool events
  const callbacks: StreamCallbacks = {
    onContent: (_: string) => {
      // onContent is empty - doesn't update history during streaming
      // This is just for real-time display purposes
    },
    onContentComplete: (_: string) => {
      // Note: streamChatResponse already adds messages to history via handleToolCalls
      // so we don't need to add them here - this callback is just for notification
      // that content streaming is complete
    },
    onToolStart: (__: string, _?: any) => {
      // Note: handleToolCalls already adds the tool call message to history
      // This callback is just for notification/UI updates
      // The tool call state is already created and added by handleToolCalls
    },
    onToolResult: (_result: string, _toolName: string, _status: ToolStatus) => {
      // No-op when using ChatHistoryService; it updates tool states/results
    },
    onToolError: (_error: string, _toolName?: string) => {
      // No-op; errors are added to history via handleToolCalls flow
    },
    onToolPermissionRequest: (
      toolName: string,
      toolArgs: any,
      requestId: string,
      toolCallPreview?: any[],
    ) => {
      // Set pending permission state
      state.pendingPermission = {
        toolName,
        toolArgs,
        requestId,
        timestamp: Date.now(),
        toolCallPreview,
      };

      // Add a system message indicating permission is needed via service
      try {
        services.chatHistory.addSystemMessage(
          `WARNING: Tool ${toolName} requires permission`,
        );
      } catch (err) {
        // Do not mutate session history; ChatHistoryService is the source of truth
        logger.error(
          "Failed to add system message via ChatHistoryService",
          err,
          { context: "onToolPermissionRequest", toolName, requestId },
        );
      }

      // Don't wait here - the streamChatResponse will handle waiting
    },
    onSystemMessage: (message: string) => {
      try {
        services.chatHistory.addSystemMessage(message);
      } catch (err) {
        // Do not mutate session history; ChatHistoryService is the source of truth
        logger.error(
          "Failed to add system message via ChatHistoryService",
          err,
          { context: "onSystemMessage" },
        );
      }
    },
    // Steering: a message posted with `steer: true` while this run works is
    // delivered here, between the tool results and the next model request.
    // Loop mode's answers for the running item go in at the same boundary.
    onToolBoundary: withLoopSteering(() => buildServeSteeringMessage()),
    // A notice for whoever watches the server (a reply cut off at the output
    // limit, say): the TUI puts it on its status line, serve logs it.
    onStatusMessage: (message: string) => {
      logger.info(chalk.yellow(message));
    },
  };

  try {
    // A Stop hook that blocks sends the agent back to work, up to three
    // times for this message (D4)
    const response = await runTurnWithStopHooks({
      runTurn: async () =>
        (await streamChatResponse(
          state.session.history,
          state.model,
          llmApi,
          abortController,
          callbacks,
        )) || undefined,
      addUserMessage: (text) => services.chatHistory.addUserMessage(text),
      notice: (text) => {
        logger.info(chalk.yellow(text));
        try {
          services.chatHistory.addSystemMessage(text);
        } catch (err) {
          logger.error("Failed to add the Stop hook notice", err);
        }
      },
      cancelled: () => abortController.signal.aborted,
    });
    return response || "";
  } finally {
    clearInterval(interruptionChecker);
  }
}

export interface PendingPermission {
  toolName: string;
  toolArgs: any;
  requestId: string;
  timestamp: number;
  toolCallPreview?: any[];
}

export interface ServerState {
  session: Session;
  config: any;
  model: any;
  isProcessing: boolean;
  lastActivity: number;
  currentAbortController: AbortController | null;
  serverRunning: boolean;
  pendingPermission: PendingPermission | null;
  systemMessage?: string;
}
