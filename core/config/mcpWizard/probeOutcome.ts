import type { McpProbeResult, ProbeHint } from "./probeMcpServer";

/*
  What the dialog says after "Test": the probe's answer in plain words. Pure
  and free of Node imports, so the webview uses it as it is.
*/

/** The answer of `mcp/probe`, as far as this file reads it. */
export type ProbeAnswer =
  | { ran: true; result: McpProbeResult }
  | { ran: false; reason: string; error: string; missing?: string[] };

export interface ProbeOutcome {
  tone: "success" | "warning" | "error";
  /** One sentence. */
  headline: string;
  /** More sentences, most useful first. */
  details: string[];
  /** The server's own name and version, when it connected. */
  server?: string;
  counts?: { tools: number; prompts: number; resources: number };
  toolNames: string[];
  /** Tools whose description reads like instructions to the model. */
  flaggedTools: string[];
  /** The last lines the server wrote before it stopped. */
  stderr: string[];
  /** Pages that help, opened by the person. */
  links: { text: string; href: string }[];
}

const seconds = (ms: number) => {
  const s = Math.round(ms / 100) / 10;
  return `${s} second${s === 1 ? "" : "s"}`;
};

const NOT_FOUND = new Set<ProbeHint["code"]>([
  "command-not-found",
  "install-node",
  "install-uv",
  "install-docker",
]);

/** `HTTP 404` and the like, from the error text. */
export function httpStatusIn(errors: string[]): number | undefined {
  for (const e of errors) {
    const m =
      /\bHTTP (\d{3})\b/i.exec(e) ??
      /\bstatus(?: code)?:? (\d{3})\b/i.exec(e) ??
      /\((\d{3})\)/.exec(e);
    if (m) {
      const n = Number(m[1]);
      if (n >= 300 && n <= 599) return n;
    }
  }
  return undefined;
}

const HTTP_MEANING: Record<number, string> = {
  401: "the server wants a key or a sign-in",
  403: "the server refused this key or account",
  404: "nothing answers at this address, so check the URL",
  405: "the address is not an MCP endpoint, so check the URL",
  429: "the server is limiting requests, so wait and try again",
  500: "the server had an error of its own",
  502: "a gateway in front of the server had an error",
  503: "the server is not available right now",
};

const empty = {
  toolNames: [] as string[],
  flaggedTools: [] as string[],
  stderr: [] as string[],
  links: [] as { text: string; href: string }[],
};

export function describeProbe(
  answer: ProbeAnswer,
  ctx: { command?: string } = {},
): ProbeOutcome {
  if (!answer.ran) {
    return {
      tone: answer.reason === "untrusted" ? "warning" : "error",
      headline: answer.error,
      details: answer.missing?.length
        ? [`Fill in: ${answer.missing.join(", ")}.`]
        : [],
      ...empty,
    };
  }
  const r = answer.result;
  const links = r.hints
    .filter((h) => h.link)
    .map((h) => ({ text: "How to install it", href: h.link! }));
  if (r.ok) {
    const counts = {
      tools: r.tools.length,
      prompts: r.prompts.length,
      resources: r.resources.length,
    };
    const flagged = r.tools
      .filter((t) => t.instructionLike.length > 0)
      .map((t) => t.name);
    return {
      tone: flagged.length ? "warning" : "success",
      headline: `Connected in ${seconds(r.durationMs)}.`,
      details: [
        ...r.hints.map((h) => h.text),
        ...(flagged.length
          ? [
              `Read ${flagged.length === 1 ? "this tool's description" : "these tools' descriptions"} before you approve: ${flagged.join(", ")}. The text reads like instructions to the model.`,
            ]
          : []),
      ],
      ...(r.server
        ? {
            server: r.server.version
              ? `${r.server.name} ${r.server.version}`
              : r.server.name,
          }
        : {}),
      counts,
      toolNames: r.tools.map((t) => t.name),
      flaggedTools: flagged,
      stderr: [],
      links,
    };
  }

  const details: string[] = [];
  let headline: string;
  const notFound = r.hints.find((h) => NOT_FOUND.has(h.code));
  const status = httpStatusIn(r.errors);
  if (r.status === "timeout") {
    headline = `Timed out after ${seconds(r.timeoutMs)}.`;
  } else if (notFound) {
    headline = ctx.command
      ? `Command not found: ${ctx.command}`
      : "The command was not found.";
    if (r.pathSearched?.length) {
      details.push(
        `Looked in the ${r.pathSearched.length} folder${r.pathSearched.length === 1 ? "" : "s"} of the PATH the editor has: ${r.pathSearched.join(", ")}`,
      );
    }
  } else if (r.needsSignIn) {
    headline = "The server answered, and it needs a key or a sign-in.";
  } else if (status !== undefined) {
    const meaning = HTTP_MEANING[status];
    headline = meaning
      ? `The server answered HTTP ${status}: ${meaning}.`
      : `The server answered HTTP ${status}.`;
  } else if (r.transport === "stdio") {
    headline = "The server started but did not connect.";
  } else {
    headline = "Could not connect to the server.";
  }
  for (const h of r.hints) details.push(h.text);
  // The raw error last: it is the least plain, and sometimes the only clue
  for (const e of r.errors) {
    const first = e.split("\n")[0].trim();
    if (first && !details.includes(first)) details.push(first);
  }
  return {
    tone: "error",
    headline,
    details,
    toolNames: [],
    flaggedTools: [],
    stderr: r.stderr.lines,
    links,
  };
}
