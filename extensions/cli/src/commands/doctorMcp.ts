/**
 * The `mcpServers` entries of a config.yaml, checked one by one for
 * `continuous doctor config`. Shows each entry's name, transport, program
 * file name or URL host, and the NAMES of the variables it sets: never an
 * argument, a header or a value.
 */

import { isMapping, type FileProblem } from "./doctorFiles.js";

export interface McpServerCheck {
  /** The entry's name, or `#<index>` when it has none. */
  name: string;
  transport: "stdio" | "sse" | "streamable-http" | "block" | "unknown";
  /** The program's file name, or the URL's scheme and host. Never arguments. */
  target?: string;
  /** NAMES of the environment variables the entry sets. */
  envNames: string[];
  state: "ok" | "broken";
  errors: FileProblem[];
}

function urlTarget(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return `${url.protocol}//${url.host}`;
  } catch {
    return undefined;
  }
}

/** The `mcpServers` entries of a parsed config.yaml, checked one by one. */
export function checkMcpServers(config: unknown): McpServerCheck[] {
  const servers = isMapping(config) ? config.mcpServers : undefined;
  if (!Array.isArray(servers)) return [];
  const seen = new Set<string>();
  return servers.map((entry, index): McpServerCheck => {
    const key = `mcpServers.${index}`;
    if (!isMapping(entry)) {
      return {
        name: `#${index}`,
        transport: "unknown",
        envNames: [],
        state: "broken",
        errors: [{ message: "must be an object", key }],
      };
    }
    if (typeof entry.uses === "string") {
      return {
        name: `#${index}`,
        transport: "block",
        envNames: [],
        state: "ok",
        errors: [],
      };
    }
    const errors: FileProblem[] = [];
    const name =
      typeof entry.name === "string" && entry.name.trim()
        ? entry.name
        : `#${index}`;
    if (name.startsWith("#")) errors.push({ message: "needs a name", key });
    else if (seen.has(name)) {
      errors.push({ message: "the name is used by an earlier server", key });
    }
    seen.add(name);

    const envNames = isMapping(entry.env) ? Object.keys(entry.env).sort() : [];
    const hasCommand = typeof entry.command === "string" && !!entry.command;
    const hasUrl = typeof entry.url === "string" && !!entry.url;
    let transport: McpServerCheck["transport"] = "unknown";
    let target: string | undefined;
    if (hasCommand && hasUrl) {
      errors.push({ message: "has both a command and a url; use one", key });
    } else if (hasCommand) {
      transport = "stdio";
      target = String(entry.command).split(/[\\/]/).pop();
      if (entry.type !== undefined && entry.type !== "stdio") {
        errors.push({
          message: "a command needs type stdio",
          key: `${key}.type`,
        });
      }
      if (
        entry.args !== undefined &&
        !(
          Array.isArray(entry.args) &&
          entry.args.every((a) => typeof a === "string")
        )
      ) {
        errors.push({
          message: "must be a list of strings",
          key: `${key}.args`,
        });
      }
    } else if (hasUrl) {
      transport = entry.type === "sse" ? "sse" : "streamable-http";
      target = urlTarget(String(entry.url));
      if (!target) {
        errors.push({
          message: "is not an http or https address",
          key: `${key}.url`,
        });
      }
      if (entry.type === "stdio") {
        errors.push({
          message: "a url cannot have type stdio",
          key: `${key}.type`,
        });
      }
    } else {
      errors.push({ message: "needs a command or a url", key });
    }
    return {
      name,
      transport,
      ...(target ? { target } : {}),
      envNames,
      state: errors.length ? "broken" : "ok",
      errors,
    };
  });
}
