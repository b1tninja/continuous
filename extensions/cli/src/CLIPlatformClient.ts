import * as fs from "node:fs";
import * as path from "node:path";

import {
  FQSN,
  PlatformClient,
  SecretResult,
  SecretType,
} from "@continuedev/config-yaml";
import * as dotenv from "dotenv";

import { env } from "./env.js";

/**
 * Resolves `${{ secrets.NAME }}` references from this machine only: the
 * process environment and the local .env files. Nothing is sent to a server.
 */
export class CLIPlatformClient implements PlatformClient {
  private findSecretInEnvFile(
    filePath: string,
    secretName: string,
  ): string | undefined {
    try {
      if (!fs.existsSync(filePath)) return undefined;

      const envContent = fs.readFileSync(filePath, "utf8");
      const env = dotenv.parse(envContent);
      return env[secretName];
    } catch (error) {
      console.warn(
        `Error reading .env file at ${filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    }
  }

  private findSecretInProcessEnv(fqsn: FQSN): SecretResult | undefined {
    const secretValue = process.env[fqsn.secretName];
    if (secretValue) {
      return {
        found: true,
        fqsn,
        value: secretValue,
        secretLocation: {
          secretName: fqsn.secretName,
          secretType: SecretType.LocalEnv,
        },
      };
    }
    return undefined;
  }

  private findSecretInLocalEnvFiles(fqsn: FQSN): SecretResult | undefined {
    // First check process.env (highest priority)
    const processEnvSecret = this.findSecretInProcessEnv(fqsn);
    if (processEnvSecret) {
      return processEnvSecret;
    }

    // Then check in priority order: ~/.continuous/.env, <workspace>/.continuous/.env, <workspace>/.continue/.env, <workspace>/.env
    const workspaceDir = process.cwd();
    const envPaths = [
      path.join(env.continueHome, ".env"),
      path.join(workspaceDir, ".continuous", ".env"),
      path.join(workspaceDir, ".continue", ".env"),
      path.join(workspaceDir, ".env"),
    ];

    for (const envPath of envPaths) {
      const secretValue = this.findSecretInEnvFile(envPath, fqsn.secretName);
      if (secretValue) {
        return {
          found: true,
          fqsn,
          value: secretValue,
          secretLocation: {
            secretName: fqsn.secretName,
            secretType: SecretType.LocalEnv,
          },
        };
      }
    }

    return undefined;
  }

  async resolveFQSNs(fqsns: FQSN[]): Promise<(SecretResult | undefined)[]> {
    if (fqsns.length === 0) {
      return [];
    }

    const results: (SecretResult | undefined)[] = new Array(fqsns.length).fill(
      undefined,
    );

    // Process environment first, then the local env files
    for (let i = 0; i < fqsns.length; i++) {
      const secretFromEnv = this.findSecretInLocalEnvFiles(fqsns[i]);
      if (secretFromEnv?.found) {
        results[i] = secretFromEnv;
      }
    }

    // Anything still unresolved stays undefined. Say so here, by name, because
    // the config loader only reports a missing secret much later and without
    // saying where to put it. Names only: values are never printed.
    const missing = Array.from(
      new Set(
        fqsns
          .filter((_, i) => results[i] === undefined)
          .map((f) => f.secretName),
      ),
    );
    if (missing.length > 0) {
      console.warn(
        `Secret${missing.length > 1 ? "s" : ""} not found locally: ${missing.join(", ")}. ` +
          `Set ${missing.length > 1 ? "each" : "it"} as an environment variable or in a .env file ` +
          `(${path.join(env.continueHome, ".env")}, .continuous/.env, .continue/.env or .env in the project). ` +
          `Secrets are never fetched from a server.`,
      );
    }

    return results;
  }
}
