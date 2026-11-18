import type http from "node:http";
import type { Duplex } from "node:stream";

import type {
  ErrorRequestHandler,
  NextFunction,
  Request,
  Response,
} from "express";

/**
 * Who may talk to `cn serve`, beyond the Host and Origin checks in
 * serve.helpers.ts. A token is optional on loopback and required off it, and
 * is only ever one the person chose with `--token` or CONTINUOUS_SERVE_TOKEN.
 */

export const MIN_TOKEN_LENGTH = 16;

export type ServeAuth =
  { mode: "none" } | { mode: "token"; token: string; source: "flag" | "env" };

export interface ServeAuthInput {
  host: string;
  token?: string;
  env?: NodeJS.ProcessEnv;
  loopback: (host: string) => boolean;
}

/**
 * The access mode these options ask for, or an error text when the server
 * must not start with them. A token is the person's choice: on loopback none
 * is required and none is made up. Off loopback one is required.
 */
export function resolveServeAuth(
  input: ServeAuthInput,
): { auth: ServeAuth } | { problem: string } {
  const env = input.env ?? process.env;
  const flag = input.token?.trim();
  const fromEnv = env.CONTINUOUS_SERVE_TOKEN?.trim();
  const explicit = flag || fromEnv;
  if (!explicit) {
    if (input.loopback(input.host)) return { auth: { mode: "none" } };
    return {
      problem: `--host ${input.host} listens beyond this computer, so a token is required. Pass --token <at least ${MIN_TOKEN_LENGTH} characters> or set CONTINUOUS_SERVE_TOKEN, or use --host 127.0.0.1.`,
    };
  }
  if (explicit.length < MIN_TOKEN_LENGTH) {
    return {
      problem: `The serve token (${flag ? "--token" : "CONTINUOUS_SERVE_TOKEN"}) must be at least ${MIN_TOKEN_LENGTH} characters. Set a longer one${input.loopback(input.host) ? ", or leave it out (loopback needs none)" : ""}.`,
    };
  }
  return {
    auth: { mode: "token", token: explicit, source: flag ? "flag" : "env" },
  };
}

/** A fixed-window counter per key. */
export class WindowCounter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Count one event; false when the key is over its limit for the window. */
  hit(key: string): boolean {
    const t = this.now();
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) {
      if (this.hits.size > 1000) this.hits.clear();
      entry = { count: 0, resetAt: t + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  /** Whether the key is already over its limit, without counting. */
  blocked(key: string): boolean {
    const entry = this.hits.get(key);
    return !!entry && entry.resetAt > this.now() && entry.count > this.limit;
  }
}

/** The largest request body: messages and approvals are small. */
export const MAX_BODY_BYTES = "1mb";
export const MAX_REQUESTS_PER_MINUTE = 1200;
export const MAX_FAILED_AUTH_PER_MINUTE = 20;

/** Per-address request limit. */
export function rateLimitMiddleware(
  limiter: WindowCounter = new WindowCounter(MAX_REQUESTS_PER_MINUTE, 60_000),
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (limiter.hit(req.socket.remoteAddress ?? "unknown")) {
      next();
      return;
    }
    res.status(429).json({ error: "Too many requests." });
  };
}

/**
 * Refuse every protocol upgrade. The server has no WebSocket route; a page
 * that tries one (from any origin) is told no instead of left hanging.
 */
export function refuseUpgrades(server: http.Server): void {
  server.on("upgrade", (_req: http.IncomingMessage, socket: Duplex) => {
    socket.end(
      "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
  });
}

/** Body-parser failures as JSON: 413 for a body over the limit, 400 for bad JSON. */
export const jsonErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const status = Number(err?.status ?? err?.statusCode);
  if (status === 413) {
    res.status(413).json({ error: "The request body is too large." });
  } else if (status === 400) {
    res.status(400).json({ error: "The request body is not valid JSON." });
  } else {
    res.status(500).json({ error: "The server could not handle the request." });
  }
};
