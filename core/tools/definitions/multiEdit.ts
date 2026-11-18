import { Tool } from "../..";
import { validateMultiEdit } from "../../edit/searchAndReplace/multiEditValidation";
import { executeMultiFindAndReplace } from "../../edit/searchAndReplace/performReplace";
import { validateSearchAndReplaceFilepath } from "../../edit/searchAndReplace/validateArgs";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";
import { NO_PARALLEL_TOOL_CALLING_INSTRUCTION } from "./editFile";

export interface EditOperation {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface MultiEditArgs {
  filepath: string;
  edits: EditOperation[];
}

export const multiEditTool: Tool = {
  type: "function",
  displayTitle: "Multi Edit",
  wouldLikeTo: "edit {{{ filepath }}}",
  isCurrently: "editing {{{ filepath }}}",
  hasAlready: "edited {{{ filepath }}}",
  group: BUILT_IN_GROUP_NAME,
  readonly: false,
  isInstant: false,
  function: {
    name: BuiltInToolNames.MultiEdit,
    description: `Make several find-and-replace edits to one file in a single call. Put every change to the file in this one call: files can change between calls (users, linters).

- Edits apply in the order given, each to the result of the previous one, and atomically: if any edit fails, none is applied.
- old_string must match the file exactly, including whitespace, and must differ from new_string. Set replace_all to change every match (for example a rename).
- Use ${BuiltInToolNames.ReadFile} just before editing to see the current contents.
- ${NO_PARALLEL_TOOL_CALLING_INSTRUCTION}`,
    parameters: {
      type: "object",
      required: ["filepath", "edits"],
      properties: {
        filepath: {
          type: "string",
          description:
            "The path to the file to modify, relative to the root of the workspace",
        },
        edits: {
          type: "array",
          description:
            "Array of edit operations to perform sequentially on the file",
          items: {
            type: "object",
            required: ["old_string", "new_string"],
            properties: {
              old_string: {
                type: "string",
                description:
                  "The text to replace (exact match including whitespace/indentation)",
              },
              new_string: {
                type: "string",
                description:
                  "The text to replace it with. MUST be different than old_string.",
              },
              replace_all: {
                type: "boolean",
                description:
                  "Replace all occurrences of old_string (default false) in the file",
              },
            },
          },
        },
      },
    },
  },
  systemMessageDescription: {
    prefix: `To make multiple edits to a single file, use the ${BuiltInToolNames.MultiEdit} tool with a filepath (relative to the root of the workspace) and an array of edit operations.

  For example, you could respond with:`,
    exampleArgs: [
      ["filepath", "path/to/file.ts"],
      [
        "edits",
        `[
  { "old_string": "const oldVar = 'value'", "new_string": "const newVar = 'updated'" },
  { "old_string": "oldFunction()", "new_string": "newFunction()", "replace_all": true }
]`,
      ],
    ],
  },
  defaultToolPolicy: "allowedWithPermission",
  preprocessArgs: async (args, extras) => {
    const { edits } = validateMultiEdit(args);
    const fileUri = await validateSearchAndReplaceFilepath(
      args.filepath,
      extras.ide,
      { allowOutside: extras.allowOutsideWorkspace },
    );

    const editingFileContents = await extras.ide.readFile(fileUri);
    const newFileContents = executeMultiFindAndReplace(
      editingFileContents,
      edits,
    );

    return {
      ...args,
      fileUri,
      editingFileContents,
      newFileContents,
    };
  },
};
