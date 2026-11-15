import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

import { parseMarkdownRule, RuleObject } from "@continuedev/config-yaml";
import { CLI_TURN_TOOL_NAMES } from "core/llm/prompts/turns.js";
import {
  actTurnTextFor,
  planTurnTextFor,
  type PromptChoice,
} from "core/llm/prompts/usePrompts.js";

import {
  attributionInstructions,
  loadAttributionSettings,
} from "./attribution.js";
import { processRule } from "./hubLoader.js";
import { AGENT_FILES, rulesDirs } from "./instructionFiles.js";
import { PermissionMode } from "./permissions/types.js";
import { isSafeMode } from "./safeMode.js";
import { serviceContainer } from "./services/ServiceContainer.js";
import { ConfigServiceState, SERVICE_NAMES } from "./services/types.js";
import { SYSTEM_MARKERS } from "./systemMessageMarkers.js";

/** Longest wait for `git rev-parse`; a hung git reads as "not a repo". */
export const GIT_CHECK_TIMEOUT_MS = 5000;

/**
 * Check if a directory is a git repository
 */
function isGitRepo(cwd: string): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", {
      stdio: "ignore",
      cwd,
      timeout: GIT_CHECK_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

// The folder the preamble describes is the one the process started in, as it
// was when the preamble was built at module load. Reading process.cwd() here
// costs nothing; the git check is deferred to the first prompt, so --help and
// other commands that never build a prompt start no git process. The review
// and loop workers and ACP change folder before their first prompt, so the
// check runs against this folder, not the current one, and the text is the
// same as before.
const startupCwd = process.cwd();
let cachedBaseSystemMessage: string | undefined;

// The CLI's preamble. The turn's own instructions (act or plan) are shared
// with the IDE and appended by constructSystemMessage; see
// core/llm/prompts/turns.ts and plans/policy-areas.md.
//
// Only facts that are the same for every run in this folder go here, so the
// cached prefix matches across sessions. The date and the git status change
// between runs and travel in the first user message of each request instead
// (src/environmentContext.ts).
export function getBaseSystemMessage(): string {
  cachedBaseSystemMessage ??= `You are an agent in the Continuous CLI. Your replies are shown in a terminal: be concise and direct, and show file names and code only where they help.
Here is useful information about the environment you are running in:
<env>
Working directory: ${startupCwd}
Is directory a git repo: ${isGitRepo(startupCwd)}
Platform: ${process.platform}
</env>

Today's date and the git status of the working tree are in a <context name="environment"> block in the first user message.`;
  return cachedBaseSystemMessage;
}

async function getConfigYamlRules(): Promise<string[]> {
  const configState = await serviceContainer.get<ConfigServiceState>(
    SERVICE_NAMES.CONFIG,
  );
  if (configState.config?.rules) {
    // Extract systemMessage from the config if it exists
    const rules = configState.config.rules;
    return rules
      .map((rule) => {
        return typeof rule === "string" ? rule : rule?.rule;
      })
      .filter((rule): rule is string => !!rule);
  }

  return [];
}

function getRuleNameFromPath(filePath: string): string {
  const segments = filePath.split(/[/\\]/);
  const lastTwoParts = segments.slice(-2);
  return lastTwoParts.filter(Boolean).join("/").replace(/\.md$/, "");
}

/**
 * Scan .continue/rules/ directories for markdown rule files and return the rules with metadata that should be always-applied
 */
export function loadMarkdownRulesWithMetadata(): RuleObject[] {
  const rules: RuleObject[] = [];
  // --safe: no rules folder is read
  if (isSafeMode()) return rules;

  for (const dir of rulesDirs()) {
    if (!fs.existsSync(dir)) continue;

    let files: string[];
    try {
      files = fs.readdirSync(dir, { recursive: true }) as string[];
    } catch {
      continue;
    }

    for (const file of files) {
      if (!String(file).endsWith(".md")) continue;

      const filePath = path.join(dir, String(file));
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
      } catch {
        continue;
      }

      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const { frontmatter, markdown } = parseMarkdownRule(content);

        if (frontmatter.invokable) continue;

        const isAlwaysApply =
          frontmatter.alwaysApply === true ||
          (frontmatter.alwaysApply === undefined &&
            !frontmatter.globs &&
            !frontmatter.regex);

        if (isAlwaysApply && markdown.trim()) {
          const ruleName =
            frontmatter.name || getRuleNameFromPath(String(file));
          rules.push({
            name: ruleName,
            rule: markdown,
            description: frontmatter.description,
            globs: frontmatter.globs,
            regex: frontmatter.regex,
            alwaysApply: true,
            sourceFile: filePath,
          });
        }
      } catch {
        // Skip files that can't be read or parsed
      }
    }
  }

  return rules;
}

/**
 * Load and construct a comprehensive system message with base message and rules section
 * @param additionalRules - Additional rules from --rule flags
 * @param format - Output format for headless mode
 * @param headless - Whether running in headless mode
 * @param mode - Current permission mode
 * @returns The comprehensive system message with base message and rules section
 */
/**
 * Which turn text to build: the model id the message is for (its prompt
 * profile picks the text) and, or, the prompt `modeModels.<use>.prompt`
 * chose for the turn. A bare string is the model id alone.
 */
export interface TurnPromptInput {
  model?: string;
  promptChoice?: PromptChoice;
}

export async function constructSystemMessage(
  mode: PermissionMode,
  additionalRules?: string[],
  format?: "json",
  headless?: boolean,
  turn?: string | TurnPromptInput,
): Promise<string> {
  const { model, promptChoice }: TurnPromptInput =
    typeof turn === "string" ? { model: turn } : (turn ?? {});
  let agentContent = "";

  try {
    // --safe: no agent file (AGENTS.md and the like) is read
    for (const fileName of isSafeMode() ? [] : AGENT_FILES) {
      const filePath = path.join(process.cwd(), fileName);

      if (fs.existsSync(filePath)) {
        agentContent = fs.readFileSync(filePath, "utf-8");
        break; // Use the first found agent file
      }
    }
  } catch (error) {
    // If there's any error reading the file, continue without agent content
    console.warn("Warning: Could not read agent configuration file:", error);
  }

  // Process additional rules from --rule flags
  const processedRules: string[] = [];
  if (additionalRules && additionalRules.length > 0) {
    for (const ruleSpec of additionalRules) {
      try {
        const processedRule = await processRule(ruleSpec);
        processedRules.push(processedRule);
      } catch (error: any) {
        console.warn(
          `Warning: Failed to process rule "${ruleSpec}": ${error.message}`,
        );
      }
    }
  }

  const configYamlRules = await getConfigYamlRules();
  processedRules.push(...configYamlRules);

  // Load markdown rules from .continue/rules/ directories
  const markdownRules = loadMarkdownRulesWithMetadata();
  // Deduplicate against already-loaded rules
  const existingRulesSet = new Set(processedRules);
  for (const rule of markdownRules) {
    if (!existingRulesSet.has(rule.rule)) {
      processedRules.push(rule.rule);
      existingRulesSet.add(rule.rule);
    }
  }

  // Construct the comprehensive system message
  let systemMessage = getBaseSystemMessage();

  // The turn's instructions: a plan turn in plan mode, an act turn otherwise.
  // The same texts serve the IDE, so the two surfaces cannot drift apart; the
  // use's prompt choice, else the model's prompt profile, picks the short
  // text for small models (Qwen) or a prompt block of the person's own.
  if (mode === "plan") {
    systemMessage += `${SYSTEM_MARKERS.plan}${planTurnTextFor(model, promptChoice, CLI_TURN_TOOL_NAMES)}\n</context>\n`;
  } else {
    systemMessage += `${SYSTEM_MARKERS.agent}${actTurnTextFor(model, promptChoice, CLI_TURN_TOOL_NAMES)}\n</context>\n`;
    // Attribution is opt-in: nothing is added unless the user's own settings ask.
    const attribution = attributionInstructions(loadAttributionSettings());
    if (attribution) {
      systemMessage += `${SYSTEM_MARKERS.commit}${attribution}</context>
`;
    }
  }

  // In headless mode, add instructions to be concise and only provide final answers
  if (headless) {
    systemMessage += `${SYSTEM_MARKERS.headless} Provide ONLY your final answer to the user's question. Do not include explanations, reasoning, or additional commentary unless specifically requested. Be direct and concise.`;
  }

  // Add JSON formatting instructions if format is json
  if (format === "json") {
    systemMessage += `${SYSTEM_MARKERS.json} Your final response MUST be valid JSON that can be parsed by JSON.parse(). The JSON should contain properties relevant to answer the user's question. You don't need to include any general "response" or "answer" field. Do not include any text before or after the JSON - the entire response must be parseable JSON.

Example response format:
{
  "property": "value"
}`;
  }

  // Add rules section if we have any rules or agent content
  if (agentContent || processedRules.length > 0) {
    systemMessage += SYSTEM_MARKERS.rules;

    if (agentContent) {
      systemMessage += `\n${agentContent}`;
    }

    // Add processed rules from --rule flags
    if (processedRules.length > 0) {
      const separator = agentContent ? "\n\n" : "\n";
      systemMessage += `${separator}${processedRules.join("\n\n")}`;
    }

    systemMessage += "\n</context>";
  }

  return systemMessage;
}
