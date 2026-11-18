import {
  maskArgsForDisplay,
  maskCommandForDisplay,
} from "core/tools/permissions/displayMask";
import { describeInterpreters } from "core/tools/permissions/shellContext";

/**
 * What a person is shown about a tool call that waits for approval (or was
 * refused): the kind of action in plain words, the exact payload and the
 * paths it names. Built only from the call's own name and arguments, and
 * every string is masked for display first. Display only: the call itself
 * is made with the real arguments.
 */
export interface ActionField {
  label: string;
  value: string;
}

export interface ActionBlock {
  /** "Command", "Changes", "Contents", "Arguments" */
  label: string;
  /** The whole text, never cut. The view decides how much of it is in sight. */
  text: string;
}

export interface ActionSummary {
  /** The kind of action in plain words, e.g. "Run terminal command". */
  kind: string;
  fields: ActionField[];
  block?: ActionBlock;
  /** Paths the call names, as the model wrote them. */
  paths: string[];
}

/** The group name core gives to its own tools; every other group is an MCP server. */
const BUILT_IN_GROUP = "Built-In";

type Args = Record<string, unknown>;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

/** A URL for display: the credentials in it never appear, then the usual masking. */
export function maskUrlForDisplay(url: string): string {
  const noUserinfo = url.replace(
    /^([a-z][a-z0-9+.-]*:\/\/)[^/?#\s]*@/i,
    "$1***@",
  );
  return maskCommandForDisplay(noUserinfo);
}

/**
 * The interpreters a command hands its text to when that is not simply the
 * terminal's own shell: `bash -c`, `cmd /c`, `wsl`, `ssh host`, a script file.
 * Each has its own quoting and separators, so the card names them. Read from
 * the real command, shown masked. Undefined for an ordinary command.
 */
export function runsThrough(command: string): string | undefined {
  // The webview does not know the terminal's shell: only what the command
  // itself launches is named
  const found = describeInterpreters(command, undefined);
  if (!found) return undefined;
  const text = maskCommandForDisplay(found.text);
  if (found.hidden) {
    return `${text}. What that runs is not all written in this command.`;
  }
  return found.uncertain
    ? `${text}. Which shell reads it there is not known here.`
    : text;
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(maskArgsForDisplay(value), null, 2) ?? "";
  } catch {
    return String(value);
  }
}

function lines(prefix: string, text: string): string {
  return text
    .split("\n")
    .map((l) => `${prefix} ${l}`)
    .join("\n");
}

function replacement(oldText: string, newText: string): string {
  return `${lines("-", oldText)}\n${lines("+", newText)}`;
}

function editsText(edits: unknown): string {
  if (!Array.isArray(edits)) return pretty(edits);
  return edits
    .map((e, i) => {
      const o = (e ?? {}) as Args;
      return `@@ edit ${i + 1}${o.replace_all ? " (every match)" : ""}\n${replacement(
        String(o.old_string ?? ""),
        String(o.new_string ?? ""),
      )}`;
    })
    .join("\n");
}

function pathsOf(args: Args): string[] {
  const out: string[] = [];
  for (const key of [
    "filepath",
    "file_path",
    "filePath",
    "path",
    "dirPath",
    "dirpath",
    "directory",
    "cwd",
    "workdir",
  ]) {
    const v = str(args[key]);
    if (v) out.push(v);
  }
  for (const key of ["paths", "filepaths", "files"]) {
    const v = args[key];
    if (Array.isArray(v)) {
      for (const p of v) {
        if (typeof p === "string" && p) out.push(p);
      }
    }
  }
  return [...new Set(out.map((p) => maskCommandForDisplay(p)))];
}

interface ToolLike {
  group?: string;
  displayTitle?: string;
  originalFunctionName?: string;
}

export function describeAction(
  toolName: string,
  rawArgs: unknown,
  tool?: ToolLike,
): ActionSummary {
  const args: Args =
    rawArgs && typeof rawArgs === "object" ? (rawArgs as Args) : {};
  const fields: ActionField[] = [];
  const paths = pathsOf(args);
  const file = (label = "File") => {
    const p = str(args.filepath) ?? str(args.file_path) ?? str(args.path);
    if (p) fields.push({ label, value: maskCommandForDisplay(p) });
  };
  const without = (keys: string[]) => {
    const rest = { ...args };
    for (const k of keys) delete rest[k];
    return rest;
  };

  const isMcp = !!tool?.group && tool.group !== BUILT_IN_GROUP;
  if (isMcp) {
    const name = tool?.originalFunctionName ?? toolName;
    return {
      kind: `Call MCP tool ${tool?.group}/${name}`,
      fields,
      block:
        Object.keys(args).length > 0
          ? { label: "Arguments", text: pretty(args) }
          : undefined,
      paths,
    };
  }

  switch (toolName) {
    case "run_terminal_command": {
      const cwd = str(args.cwd) ?? str(args.workdir) ?? str(args.directory);
      if (cwd) {
        fields.push({
          label: "Working directory",
          value: maskCommandForDisplay(cwd),
        });
      }
      if (args.waitForCompletion === false) {
        fields.push({ label: "Runs", value: "in the background" });
      }
      const through = runsThrough(String(args.command ?? ""));
      if (through) fields.push({ label: "Runs through", value: through });
      return {
        kind: "Run terminal command",
        fields,
        block: {
          label: "Command",
          text: maskCommandForDisplay(String(args.command ?? "")),
        },
        paths: paths.filter(
          (p) => p !== maskCommandForDisplay(cwd ?? "\u0000"),
        ),
      };
    }
    case "edit_existing_file":
      file();
      return {
        kind: "Edit file",
        fields,
        block: {
          label: "Changes",
          text: maskCommandForDisplay(String(args.changes ?? "")),
        },
        paths: [],
      };
    case "multi_edit":
      file();
      return {
        kind: "Edit file",
        fields,
        block: {
          label: "Changes",
          text: maskCommandForDisplay(editsText(args.edits)),
        },
        paths: [],
      };
    case "single_find_and_replace":
      file();
      return {
        kind: "Edit file",
        fields,
        block: {
          label: "Changes",
          text: maskCommandForDisplay(
            replacement(
              String(args.old_string ?? ""),
              String(args.new_string ?? ""),
            ),
          ),
        },
        paths: [],
      };
    case "create_new_file":
      file();
      return {
        kind: "Write file",
        fields,
        block: {
          label: "Contents",
          text: maskCommandForDisplay(String(args.contents ?? "")),
        },
        paths: [],
      };
    case "read_file":
    case "read_file_range":
    case "read_currently_open_file":
      file();
      if (args.startLine !== undefined || args.endLine !== undefined) {
        fields.push({
          label: "Lines",
          value: `${String(args.startLine ?? "start")} to ${String(args.endLine ?? "end")}`,
        });
      }
      return { kind: "Read file", fields, paths: [] };
    case "ls": {
      const dir = str(args.dirPath) ?? str(args.dirpath);
      fields.push({
        label: "Directory",
        value: dir ? maskCommandForDisplay(dir) : "the workspace folder",
      });
      if (args.recursive) fields.push({ label: "Recursive", value: "yes" });
      return { kind: "List directory", fields, paths: [] };
    }
    case "fetch_url_content": {
      const url = str(args.url) ?? "";
      return {
        kind: "Fetch URL",
        fields: [{ label: "URL", value: maskUrlForDisplay(url) }],
        paths: [],
      };
    }
    case "grep_search":
    case "file_glob_search":
    case "search_web": {
      const rest = Object.entries(without(["path", "dirPath"])).map(
        ([k, v]) => ({
          label: k,
          value: maskCommandForDisplay(
            typeof v === "string" ? v : JSON.stringify(v),
          ),
        }),
      );
      return {
        kind: toolName === "search_web" ? "Search the web" : "Search files",
        fields: rest,
        paths,
      };
    }
    case "subagent": {
      const rest = Object.keys(args).length
        ? { label: "Task", text: pretty(args) }
        : undefined;
      return { kind: "Delegate to agent", fields, block: rest, paths };
    }
    default:
      return {
        kind: `Call tool ${tool?.displayTitle ?? toolName}`,
        fields,
        block:
          Object.keys(args).length > 0
            ? { label: "Arguments", text: pretty(args) }
            : undefined,
        paths,
      };
  }
}
