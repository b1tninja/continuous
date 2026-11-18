import {
  ConfigValidationError,
  markdownToRule,
} from "@continuedev/config-yaml";
import { IDE, RuleWithSource } from "../..";
import { PROMPTS_DIR_NAME, RULES_DIR_NAME } from "../../promptFiles";
import { joinPathsToUri } from "../../util/uri";
import { getAllDotContinueDefinitionFiles } from "../loadLocalAssistants";
import {
  agentFilesWithheld,
  guardInstructionFile,
  type InstructionFileNotice,
  recordInstructionFilesState,
} from "./instructionFiles";

export const SUPPORTED_AGENT_FILES = ["AGENTS.md", "AGENT.md", "CLAUDE.md"];
/**
 * Loads rules from markdown files in the .continuous/rules and .continuous/prompts directories
 * and agent files (AGENTS.md, AGENT.md, CLAUDE.md) at workspace root.
 *
 * Every file goes through `guardInstructionFile` (hidden characters removed,
 * a secret warned about, cut at 32 KiB). In a workspace the IDE does not
 * trust, the agent file is not read until the person chooses Load
 * (`instructionFiles.ts`). What was withheld and what the person is told are
 * recorded for the webview (`instructionFiles/state`).
 */
export async function loadMarkdownRules(ide: IDE): Promise<{
  rules: RuleWithSource[];
  errors: ConfigValidationError[];
}> {
  const errors: ConfigValidationError[] = [];
  const rules: RuleWithSource[] = [];
  const notices: InstructionFileNotice[] = [];
  const withheld: string[] = [];

  // First, try to load agent files from workspace root
  const workspaceDirs = await ide.getWorkspaceDirs();

  for (const workspaceDir of workspaceDirs) {
    let agentFileFound = false;
    for (const fileName of SUPPORTED_AGENT_FILES) {
      try {
        const agentFileUri = joinPathsToUri(workspaceDir, fileName);
        const exists = await ide.fileExists(agentFileUri);
        if (exists) {
          if (agentFilesWithheld()) {
            // Restricted Mode: named for the Load offer, never read
            withheld.push(agentFileUri);
            agentFileFound = true;
            break;
          }
          const guarded = guardInstructionFile(
            agentFileUri,
            await ide.readFile(agentFileUri),
          );
          notices.push(...guarded.notices);

          const rule = markdownToRule(guarded.content, {
            uriType: "file",
            fileUri: agentFileUri,
          });
          rules.push({
            ...rule,
            source: "agentFile",
            sourceFile: agentFileUri,
            alwaysApply: true,
          });
          agentFileFound = true;
          break; // Use the first found agent file in this workspace
        }
      } catch (e) {
        // File doesn't exist or can't be read, continue to next file
      }
    }
    if (agentFileFound) {
      break; // Use agent file from first workspace that has one
    }
  }

  // Load markdown files from both .continuous/rules and .continuous/prompts
  const dirsToCheck = [RULES_DIR_NAME, PROMPTS_DIR_NAME] as const;

  for (const dirName of dirsToCheck) {
    try {
      const markdownFiles = await getAllDotContinueDefinitionFiles(
        ide,
        {
          includeGlobal: true,
          includeWorkspace: true,
          fileExtType: "markdown",
        },
        dirName,
      );

      // Filter to just .md files
      const mdFiles = markdownFiles.filter((file) => file.path.endsWith(".md"));

      // Process each markdown file
      for (const file of mdFiles) {
        try {
          const guarded = guardInstructionFile(file.path, file.content);
          const rule = markdownToRule(guarded.content, {
            uriType: "file",
            fileUri: file.path,
          });
          if (!rule.invokable) {
            notices.push(...guarded.notices);
            rules.push({
              ...rule,
              source: "rules-block",
              sourceFile: file.path,
            });
          }
        } catch (e) {
          errors.push({
            fatal: false,
            message: `Failed to parse markdown rule file ${file.path}: ${e instanceof Error ? e.message : e}`,
          });
        }
      }
    } catch (e) {
      errors.push({
        fatal: false,
        message: `Error loading markdown rule files from ${dirName}: ${e instanceof Error ? e.message : e}`,
      });
    }
  }

  recordInstructionFilesState({ withheld, notices });
  return { rules, errors };
}
