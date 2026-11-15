import fs from "fs";
import path from "path";

import { writeFileAtomicSync } from "core/util/atomicWrite.js";
import YAML from "yaml";

import { logger } from "../util/logger.js";

import {
  PERMISSIONS_YAML_PATH,
  permissionsYamlProblem,
} from "./permissionsYamlLoader.js";

/**
 * Generates a policy rule for a given tool call
 * For most tools, returns the display name (e.g., "Read", "Write")
 * For the Bash tool, the exact command: "yes to this" must never become "yes
 * to anything starting with rm"
 */
export function generatePolicyRule(toolName: string, toolArgs: any): string {
  const normalizedName = toolName;

  // For Bash tool, create command-specific policies
  if (normalizedName === "Bash" && toolArgs?.command) {
    const command = toolArgs.command.trim();
    if (command) return `Bash(${command})`;
  }

  // For all other tools, return the display name
  return normalizedName;
}

const NEW_FILE_HEADER = `# Continue CLI Permissions Configuration
# This file is managed by the Continue CLI and should not be edited manually.
# Use the TUI to modify permissions interactively.

`;

/**
 * Thrown when a rule was not saved because permissions.yaml exists and does
 * not load. The message is a complete sentence for the person and names the
 * file; it never holds the file's contents.
 */
export class PolicyFileNotLoadedError extends Error {
  constructor(
    readonly file: string,
    readonly problem: string,
  ) {
    super(
      `Not saved: ${file} ${problem}, and writing now would replace it. Fix the file, then choose "always allow" again.`,
    );
    this.name = "PolicyFileNotLoadedError";
  }
}

/**
 * The line shown in the chat when "always allow" could not save its rule.
 * The call in hand is still allowed once.
 */
export function policySaveFailureNotice(error: unknown): string {
  const allowedOnce = "This call was allowed once; you will be asked again.";
  if (error instanceof PolicyFileNotLoadedError) {
    return `${error.message} ${allowedOnce}`;
  }
  const reason = error instanceof Error ? error.message : String(error);
  return `Not saved: the "always allow" rule could not be written (${reason}). ${allowedOnce}`;
}

/** The first line of a YAML parser message: the rest quotes the file. */
function firstLine(message: string): string {
  return message.split("\n")[0].trim().replace(/:$/, "");
}

/**
 * `text` with `policyRule` in its `allow` list, or undefined when the rule is
 * already there. The YAML document is edited, not rebuilt from the parsed
 * object, so everything else in the file is kept as written: comments, key
 * order, the policy levels, `floor:` and any key this build does
 * not know. Throws PolicyFileNotLoadedError for a file that does not load.
 */
export function addAllowRuleToYamlText(
  text: string,
  policyRule: string,
  file: string,
): string | undefined {
  const doc = YAML.parseDocument(text);
  if (doc.errors.length > 0) {
    throw new PolicyFileNotLoadedError(
      file,
      `is not valid YAML (${firstLine(doc.errors[0].message)})`,
    );
  }
  const problem = permissionsYamlProblem(doc.toJS());
  if (problem) throw new PolicyFileNotLoadedError(file, problem);

  const allow = doc.get("allow", true);
  if (YAML.isSeq(allow)) {
    const present = allow.items.some(
      (item) => (YAML.isScalar(item) ? item.value : item) === policyRule,
    );
    if (present) return undefined;
    // `allow: []` is written in flow style; a list with entries reads
    // better one rule per line.
    if (allow.items.length === 0) allow.flow = false;
    allow.add(doc.createNode(policyRule));
  } else {
    // No `allow` key, `allow:` with nothing after it, or a file that is
    // empty or holds only comments (the document then gets its mapping)
    doc.set("allow", [policyRule]);
  }
  return doc.toString();
}

/**
 * Adds a policy rule to the permissions.yaml file.
 *
 * A file that exists and does not load is never written: rebuilding it from
 * nothing would drop the `floor:` rules, the Never rules, the levels and the
 * comments. The write is a temp file and a rename.
 */
export async function addPolicyToYaml(
  policyRule: string,
  file: string = PERMISSIONS_YAML_PATH,
): Promise<void> {
  try {
    let existing: string | undefined;
    try {
      existing = fs.readFileSync(file, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new PolicyFileNotLoadedError(
          file,
          `could not be read (${(error as NodeJS.ErrnoException).code ?? "error"})`,
        );
      }
    }

    const next =
      existing === undefined
        ? NEW_FILE_HEADER + YAML.stringify({ allow: [policyRule] })
        : addAllowRuleToYamlText(existing, policyRule, file);
    if (next === undefined) {
      logger.debug(`Policy rule already exists: ${policyRule}`);
      return;
    }

    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomicSync(file, next);
    logger.info(`Added policy rule to permissions.yaml: ${policyRule}`);
  } catch (error) {
    logger.error("Failed to add policy to permissions.yaml", {
      error,
      policyRule,
    });
    throw error;
  }
}
