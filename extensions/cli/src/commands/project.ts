/**
 * `continuous project`: see which configuration this folder ships, and grant
 * or withdraw trust for it. Trust is recorded against the files as they are
 * now, so editing them asks again. The same record is what the VS Code
 * extension reads.
 */

import * as readline from "node:readline/promises";

import {
  inspectProjectConfig,
  revokeProjectConfig,
  trustProjectScopes,
} from "core/config/projectTrust.js";
import type { ProjectScopeStatus } from "core/config/projectTrust.js";

import { auditTrust } from "../permissions/policyAudit.js";

export interface ProjectCommandOptions {
  /** Skip the question; for scripts. */
  yes?: boolean;
}

function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function describe(cwd: string, scopes: ProjectScopeStatus[]): void {
  out(`Project configuration in ${cwd}:`);
  for (const scope of scopes) {
    out(
      `  ${scope.scope}: ${scope.trusted ? "trusted" : "not trusted"} (${scope.files.length} file${scope.files.length === 1 ? "" : "s"})`,
    );
    for (const line of scope.lines) out(`    ${line}`);
  }
  out();
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** Returns the process exit code. */
export async function projectCommand(
  action: string | undefined,
  options: ProjectCommandOptions = {},
  cwd: string = process.cwd(),
): Promise<number> {
  const scopes = inspectProjectConfig(cwd);

  switch (action ?? "list") {
    case "list": {
      if (scopes.length === 0) {
        out("This project defines no Continuous configuration to trust.");
        return 0;
      }
      describe(cwd, scopes);
      out(
        scopes.every((scope) => scope.trusted)
          ? "Trusted: this project's Continuous configuration is used."
          : "Not trusted: it is not applied. Review it, then run `continuous project trust`.",
      );
      return 0;
    }

    case "trust": {
      if (scopes.length === 0) {
        out("This project defines no Continuous configuration to trust.");
        return 0;
      }
      describe(cwd, scopes);
      out(
        "Trusting lets these files start programs, send data, and supply accounts. Your own configuration keeps any name it already uses.",
      );
      if (!options.yes) {
        if (!(await confirm("Trust them? [y/N] "))) {
          out(
            process.stdin.isTTY
              ? "Not trusted."
              : "Not trusted. There is no terminal to ask on; review the list above and pass --yes to trust it.",
          );
          return 1;
        }
      }
      try {
        const fingerprints: Record<string, string> = {};
        for (const scope of scopes)
          fingerprints[scope.scope] = scope.fingerprint;
        trustProjectScopes(cwd, fingerprints);
        auditTrust("project-trust", "grant", cwd, {
          source: "cli-command",
          confirmed: options.yes ? "flag" : "prompt",
          scopes: Object.keys(fingerprints),
        });
      } catch (error) {
        process.stderr.write(
          `${error instanceof Error ? error.message : String(error)}\n`,
        );
        return 1;
      }
      out("Trusted. Changing these files will ask again.");
      return 0;
    }

    case "revoke": {
      const removed = revokeProjectConfig(cwd);
      if (removed) {
        auditTrust("project-trust", "revoke", cwd, { source: "cli-command" });
      }
      out(
        removed
          ? "Trust removed. This project's Continuous configuration is not applied."
          : "This project was not trusted.",
      );
      return 0;
    }

    default:
      process.stderr.write(
        `Unknown action '${action}'. Use list, trust or revoke.\n`,
      );
      return 1;
  }
}
