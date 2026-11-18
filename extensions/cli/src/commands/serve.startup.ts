import chalk from "chalk";

import { setApprovalsAnsweredWithoutAuth } from "../audit/cliAudit.js";

import { resolveServeAuth, type ServeAuth } from "./serve.auth.js";
import {
  DEFAULT_SERVE_HOST,
  isLoopbackHost,
  validAllowedOrigin,
} from "./serve.helpers.js";

export interface ServeAccess {
  host: string;
  auth: ServeAuth;
  /** The bearer token, absent when no token was given (loopback only) */
  token: string | undefined;
  allowedOrigins: string[];
}

/**
 * Work out who may reach the server from the options and tell the audit whether approvals arrive
 * authenticated. Throws a message when the options are not allowed.
 */
export function prepareServeAccess(options: {
  host?: string;
  token?: string;
  allowOrigin?: string[];
}): ServeAccess {
  const host = options.host ?? DEFAULT_SERVE_HOST;
  const resolved = resolveServeAuth({
    host,
    token: options.token,
    loopback: isLoopbackHost,
  });
  if ("problem" in resolved) throw new Error(resolved.problem);
  const { auth } = resolved;
  const allowedOrigins = (options.allowOrigin ?? []).map((o) => o.trim());
  const badOrigin = allowedOrigins.find((o) => !validAllowedOrigin(o));
  if (badOrigin !== undefined) {
    throw new Error(
      `--allow-origin takes an exact http(s) origin such as http://localhost:3000, not "${badOrigin}".`,
    );
  }
  setApprovalsAnsweredWithoutAuth(auth.mode === "none");
  return {
    host,
    auth,
    token: auth.mode === "token" ? auth.token : undefined,
    allowedOrigins,
  };
}

export interface ServeBanner {
  host: string;
  port: number;
  auth: ServeAuth;
  allowedOrigins: readonly string[];
  timeoutSeconds: number;
}

/** The warnings for the options that weaken the server. Plain text, no token. */
export function serveWarnings(b: Pick<ServeBanner, "host" | "auth">): string[] {
  const out: string[] = [];
  if (!isLoopbackHost(b.host)) {
    out.push(
      `WARNING: listening on ${b.host}, beyond this computer. Anyone who can reach this port and holds the token can run commands as you. Use it only on a network you trust, and prefer an SSH tunnel to loopback.`,
    );
  }
  if (b.auth.mode === "none") {
    out.push(
      "No access token: any program running as any user on this computer can reach this server. Pass --token to require one. Approvals that arrive over it are recorded as the system's, not the person's.",
    );
  }
  return out;
}

/**
 * The start-up text. A token given with --token or the environment is never
 * echoed.
 */
export function printServeBanner(b: ServeBanner): void {
  console.log(chalk.green(`Server started on http://${b.host}:${b.port}`));
  for (const warning of serveWarnings(b)) console.log(chalk.red(warning));
  if (b.auth.mode === "token") {
    console.log(
      chalk.dim("  Every request needs: Authorization: Bearer <token>"),
    );
  } else {
    console.log(
      chalk.dim(
        "  No access token: only this computer can reach it. Pass --token to require one",
      ),
    );
  }
  if (b.allowedOrigins.length) {
    console.log(chalk.dim(`  Allowed origins: ${b.allowedOrigins.join(", ")}`));
  }
  console.log(chalk.dim("Endpoints:"));
  console.log(chalk.dim("  GET  /state      - Get current agent state"));
  console.log(
    chalk.dim(
      "  POST /message    - Send a message (body: { message: string, steer?: boolean })",
    ),
  );
  console.log(
    chalk.dim(
      "                     or answer the loop (body: { loopAnswer: { questionId?, itemId?, text, ... } }, loopAction?, loopAutonomy?)",
    ),
  );
  console.log(
    chalk.dim(
      "  POST /permission - Approve/reject tool (body: { requestId, approved })",
    ),
  );
  console.log(chalk.dim("  POST /pause      - Pause the current agent run"));
  console.log(
    chalk.dim("  GET  /diff       - Get git diff against main branch"),
  );
  console.log(
    chalk.dim("  POST /exit       - Gracefully shut down the server"),
  );
  console.log(
    chalk.dim(
      `\nServer will shut down after ${b.timeoutSeconds} seconds of inactivity`,
    ),
  );
}

/** Exit status for a serve option that is not allowed (a usage error, as in `secrets`) */
export const SERVE_REFUSED_EXIT_CODE = 2;

/**
 * prepareServeAccess, but a refusal ends the process the way a CLI should:
 * one line on stderr saying what was refused and how to fix it, exit status 2.
 * The message never carries a token value.
 */
export function prepareServeAccessOrExit(
  options: Parameters<typeof prepareServeAccess>[0],
): ServeAccess {
  try {
    return prepareServeAccess(options);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `continuous serve: refused to start. ${reason.replace(/\s+/g, " ")}` +
        "\n",
    );
    process.exit(SERVE_REFUSED_EXIT_CODE);
  }
}
