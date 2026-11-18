import * as fs from "fs";

import { validateMultiEdit } from "core/edit/searchAndReplace/multiEditValidation.js";
import { executeMultiFindAndReplace } from "core/edit/searchAndReplace/performReplace.js";
import { writeFileAtomicSync } from "core/util/atomicWrite.js";
import { ContinueError, ContinueErrorReason } from "core/util/errors.js";

import {
  checkpointAfterWrite,
  checkpointBeforeWrite,
} from "../checkpoints/sessionCheckpoints.js";
import { telemetryService } from "../telemetry/telemetryService.js";
import {
  calculateLinesOfCodeDiff,
  getLanguageFromFilePath,
} from "../telemetry/utils.js";

import { editTool, validateAndResolveFilePath } from "./edit.js";
import { readFileTool } from "./readFile.js";
import { Tool } from "./types.js";
import { wroteOutsideResult } from "./workspaceBoundary.js";
import { generateDiff } from "./writeFile.js";

export interface EditOperation {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface MultiEditArgs {
  file_path: string;
  edits: EditOperation[];
}

export const multiEditTool: Tool = {
  name: "MultiEdit",
  displayName: "MultiEdit",
  readonly: false,
  isBuiltIn: true,
  description: `Make several find-and-replace edits to one existing file in a single call. Prefer this over ${editTool.name} for multiple edits to the same file, and put every change to the file in this one call: files can change between calls (users, linters).

- Edits apply in the order given, each to the result of the previous one, and atomically: if any edit fails, none is applied.
- old_string must match the file exactly, including whitespace, and must differ from new_string. Set replace_all to change every match (for example a rename). An empty old_string inserts at the beginning of the file.
- Use ${readFileTool.name} on the file first; the call fails if you have not read it in this session.
- The file must already exist; this tool cannot create files.
- file_path is absolute (preferred) or relative to the working directory.`,
  parameters: {
    type: "object",
    required: ["file_path", "edits"],
    properties: {
      file_path: {
        type: "string",
        description:
          "Absolute or relative path to the file to modify. Absolute preferred",
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
  preprocess: async (args) => {
    const { resolvedPath, outsidePreview } = validateAndResolveFilePath(
      args,
      multiEditTool.name,
    );

    const { edits } = validateMultiEdit(args);

    const currentContent = fs.readFileSync(resolvedPath, "utf-8");
    const newContent = executeMultiFindAndReplace(currentContent, edits);

    // Generate diff for preview
    const diff = generateDiff(currentContent, newContent, resolvedPath);

    return {
      args: {
        file_path: resolvedPath,
        newContent,
        originalContent: currentContent,
        editCount: edits.length,
      },
      preview: [
        ...outsidePreview,
        {
          type: "text",
          content: `Will apply ${edits.length} edit${edits.length === 1 ? "" : "s"} to ${resolvedPath}:`,
        },
        {
          type: "diff",
          content: diff,
        },
      ],
    };
  },
  run: async (args: {
    file_path: string;
    newContent: string;
    originalContent: string;
    editCount: number;
  }) => {
    try {
      // Snapshot first, so /rewind can put the file back (checkpoints/)
      checkpointBeforeWrite(args.file_path);
      writeFileAtomicSync(args.file_path, args.newContent);
      checkpointAfterWrite(args.file_path, args.newContent);

      // Get lines for telemetry
      const { added, removed } = calculateLinesOfCodeDiff(
        args.originalContent,
        args.newContent,
      );
      const language = getLanguageFromFilePath(args.file_path);

      if (added > 0) {
        telemetryService.recordLinesOfCodeModified("added", added, language);
      }
      if (removed > 0) {
        telemetryService.recordLinesOfCodeModified(
          "removed",
          removed,
          language,
        );
      }

      // Generate diff for result display
      const diff = generateDiff(
        args.originalContent,
        args.newContent,
        args.file_path,
      );

      return `Successfully edited ${args.file_path} with ${args.editCount} edit${args.editCount === 1 ? "" : "s"}\nDiff:\n${diff}${wroteOutsideResult(args.file_path)}`;
    } catch (error) {
      if (error instanceof ContinueError) {
        throw error;
      }
      throw new ContinueError(
        ContinueErrorReason.FileWriteError,
        `Error: failed to edit ${args.file_path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  },
};
