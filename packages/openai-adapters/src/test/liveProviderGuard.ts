import os from "os";
import path from "path";

/**
 * Live provider tests call a paid model API. A credential in the environment is
 * not consent to that: a developer's shell often has ANTHROPIC_API_KEY or AWS
 * credentials set for other reasons. These tests run only when
 * RUN_LIVE_PROVIDER_TESTS=1 is set as well.
 *
 * Without that flag, the setup files remove provider credentials from
 * process.env before any test file loads. A live test that forgot to check
 * the flag then finds no key and fails or skips; it cannot spend money.
 *
 * The same guard is copied in core/test/liveProviderGuard.ts,
 * packages/openai-adapters/src/test/liveProviderGuard.ts and
 * extensions/cli/src/test-helpers/liveProviderGuard.ts; keep them in step.
 */
export const LIVE_PROVIDER_FLAG = "RUN_LIVE_PROVIDER_TESTS";

/** Anything named *_API_KEY: ANTHROPIC_API_KEY, OPENAI_API_KEY, TURNS_EVAL_API_KEY... */
const API_KEY_NAME = /(^|_)API_KEY$/i;

/** Credentials whose names do not end in _API_KEY. */
const OTHER_CREDENTIALS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_ROLE_ARN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "REVIEWER_PROBE_CREDENTIAL",
];

export function liveProviderTestsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[LIVE_PROVIDER_FLAG] === "1";
}

/** A provider key for a live test: undefined unless live tests were asked for. */
export function liveKey(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return liveProviderTestsEnabled(env) ? env[name] : undefined;
}

/**
 * Why a live suite is skipped, or undefined when it may run. Put the reason in
 * the suite title so a skipped run says what it would take to run it.
 */
export function liveProviderSkipReason(
  keys: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!liveProviderTestsEnabled(env)) {
    return `set ${LIVE_PROVIDER_FLAG}=1 to call the real API`;
  }
  const missing = keys.filter((k) => !env[k]);
  return missing.length ? `${missing.join(", ")} not set` : undefined;
}

/**
 * Unless live tests were asked for, delete provider credentials from env and
 * point the AWS SDK's shared config and credentials files at a path that does
 * not exist, so the default chain cannot find ~/.aws either. Returns the names
 * removed (never the values).
 */
export function scrubProviderCredentials(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (liveProviderTestsEnabled(env)) return [];
  const removed: string[] = [];
  for (const name of Object.keys(env)) {
    if (
      API_KEY_NAME.test(name) ||
      OTHER_CREDENTIALS.includes(name.toUpperCase())
    ) {
      delete env[name];
      removed.push(name);
    }
  }
  const nowhere = path.join(os.tmpdir(), "continuous-no-provider-credentials");
  env.AWS_CONFIG_FILE = path.join(nowhere, "config");
  env.AWS_SHARED_CREDENTIALS_FILE = path.join(nowhere, "credentials");
  env.AWS_EC2_METADATA_DISABLED = "true";
  // gcp-metadata (google-auth-library) must not probe the GCE metadata server
  env.METADATA_SERVER_DETECTION = "none";
  return removed;
}

/** For global setup: scrub once and say so on stderr. */
export function scrubProviderCredentialsAndReport(): void {
  const removed = scrubProviderCredentials();
  if (removed.length) {
    process.stderr.write(
      `[live-provider-guard] ${LIVE_PROVIDER_FLAG} is not 1: removed ${removed.join(", ")} from the test environment\n`,
    );
  }
}
