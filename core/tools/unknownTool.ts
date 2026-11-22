/**
 * A call to a tool that does not exist, on either surface. The result used to
 * be "Tool X not found" (the IDE wrapped it as "the arguments were invalid"),
 * with no list of the tools that do exist, so the next call was often the
 * same wrong name. Two things happen here instead:
 *
 * - A name the other surface uses for the same tool runs as that tool, when
 *   every argument sent has the same meaning there (`TOOL_NAME_PAIRS`).
 * - Any other name gets the list of the tools on offer.
 */

/** The most names a result lists; a session with many MCP tools has hundreds. */
export const MAX_LISTED_TOOLS = 40;

/**
 * The tool result for a name nothing answers to. `offered` is the names the
 * model was given for this request, in that order.
 */
export function unknownToolResult(
  name: string,
  offered: readonly string[],
): string {
  const lead = `There is no tool named ${name}.`;
  const names = [...new Set(offered)];
  if (names.length === 0) {
    return `${lead} No tools are available in this turn.`;
  }
  const listed = names.slice(0, MAX_LISTED_TOOLS).join(", ");
  const more = names.length - MAX_LISTED_TOOLS;
  return more > 0
    ? `${lead} The tools available are: ${listed}, and ${more} more.`
    : `${lead} The tools available are: ${listed}.`;
}

/**
 * One tool under its two names. `params` maps each CLI parameter to the IDE
 * parameter that means the same; a parameter only one side has is left out,
 * and a call that sends it is not treated as the other tool.
 */
export interface ToolNamePair {
  cli: string;
  ide: string;
  params: Readonly<Record<string, string>>;
}

/**
 * Pairs whose parameters map one to one. Not here, on purpose:
 * `Write`/`create_new_file` (Write replaces an existing file, create_new_file
 * refuses one and has `append`), `Edit`/`edit_existing_file` (old and new
 * text against a described change), `Diff`/`view_diff` (the CLI shows
 * unstaged changes of a path, the IDE the whole working diff).
 */
export const TOOL_NAME_PAIRS: readonly ToolNamePair[] = [
  // The same single path
  { cli: "Read", ide: "read_file", params: { filepath: "filepath" } },
  // The same command line and folder. `timeout` (CLI) and
  // `waitForCompletion` (IDE) have no counterpart
  {
    cli: "Bash",
    ide: "run_terminal_command",
    params: { command: "command", cwd: "cwd" },
  },
  // One directory, not recursive. `recursive` (IDE) has no counterpart
  { cli: "List", ide: "ls", params: { dirpath: "dirPath" } },
  // An exact-text replacement in one file
  {
    cli: "Edit",
    ide: "single_find_and_replace",
    params: {
      file_path: "filepath",
      old_string: "old_string",
      new_string: "new_string",
      replace_all: "replace_all",
    },
  },
  // The same list of replacements, with the same keys in each
  {
    cli: "MultiEdit",
    ide: "multi_edit",
    params: { file_path: "filepath", edits: "edits" },
  },
  // A ripgrep pattern over the workspace. `path` and `file_pattern` (CLI)
  // have no counterpart
  { cli: "Search", ide: "grep_search", params: { pattern: "query" } },
  { cli: "Fetch", ide: "fetch_url_content", params: { url: "url" } },
  { cli: "Skills", ide: "read_skill", params: { skill_name: "skillName" } },
  // The same schema on both sides
  {
    cli: "TaskList",
    ide: "task_list",
    params: { items: "items", reset: "reset" },
  },
];

/** A tool on offer, as much of it as an alias needs. */
export interface OfferedTool {
  name: string;
  /** The parameters its schema requires. */
  required?: readonly string[];
}

export interface ResolvedToolAlias {
  /** The offered tool the call runs as. */
  name: string;
  /** The arguments under that tool's parameter names. */
  args: Record<string, unknown>;
}

/**
 * The offered tool a call to an unknown name means, with its arguments
 * renamed, or undefined when the name is no alias here. Only for a name that
 * is not itself a tool. The call is not an alias when it sends an argument
 * the other tool has no parameter for, or lacks one that tool requires: the
 * model then gets the list instead of a call that runs with a different
 * meaning.
 */
export function resolveToolAlias(
  name: string,
  args: Record<string, unknown> | undefined,
  offered: readonly OfferedTool[],
): ResolvedToolAlias | undefined {
  for (const pair of TOOL_NAME_PAIRS) {
    const fromCli = pair.cli === name;
    if (!fromCli && pair.ide !== name) continue;
    const target = offered.find(
      (t) => t.name === (fromCli ? pair.ide : pair.cli),
    );
    if (!target) continue;
    const rename = new Map(
      Object.entries(pair.params).map(([cli, ide]) =>
        fromCli ? [cli, ide] : [ide, cli],
      ),
    );
    const mapped: Record<string, unknown> = {};
    let fits = true;
    for (const [key, value] of Object.entries(args ?? {})) {
      const to = rename.get(key);
      if (to === undefined) {
        fits = false;
        break;
      }
      mapped[to] = value;
    }
    if (!fits) continue;
    if ((target.required ?? []).some((p) => mapped[p] === undefined)) continue;
    return { name: target.name, args: mapped };
  }
  return undefined;
}
