import { ToolPolicy } from "@continuedev/terminal-security";
import { Tool } from "../..";
import { ResolvedPath, resolveInputPath } from "../../util/pathResolver";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";
import {
  evaluateFileAccessPolicy,
  type ToolPolicyContext,
} from "../policies/fileAccess";

export const readCurrentlyOpenFileTool: Tool = {
  type: "function",
  displayTitle: "Read Currently Open File",
  wouldLikeTo: "read the current file",
  isCurrently: "reading the current file",
  hasAlready: "read the current file",
  readonly: true,
  isInstant: true,
  group: BUILT_IN_GROUP_NAME,
  function: {
    name: BuiltInToolNames.ReadCurrentlyOpenFile,
    description:
      "Read the currently open file in the IDE. If the user seems to be referring to a file that you can't see, or is requesting an action on content that seems missing, try using this tool.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  defaultToolPolicy: "allowedWithPermission",
  preprocessArgs: async (_args, { ide }) => {
    const current = await ide.getCurrentFile();
    if (!current?.path) return { resolvedPath: null };
    return { resolvedPath: await resolveInputPath(ide, current.path) };
  },
  evaluateToolCallPolicy: (
    basePolicy: ToolPolicy,
    _: Record<string, unknown>,
    processedArgs?: Record<string, unknown>,
    context?: ToolPolicyContext,
  ): ToolPolicy => {
    const resolvedPath = processedArgs?.resolvedPath as
      ResolvedPath | null | undefined;
    if (!resolvedPath) return basePolicy;
    return evaluateFileAccessPolicy(
      basePolicy,
      resolvedPath.isWithinWorkspace,
      context,
    );
  },
  systemMessageDescription: {
    prefix: `To view the user's currently open file, use the ${BuiltInToolNames.ReadCurrentlyOpenFile} tool.
If the user is asking about a file and you don't see any code, use this to check the current file`,
  },
  toolCallIcon: "DocumentTextIcon",
};
