import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * How an AWS profile signs in, read from the names of the keys in its
 * section of the shared config file (`AWS_CONFIG_FILE`, else
 * `~/.aws/config`). Only key names are looked at, never a value, and
 * `~/.aws/credentials` is never opened: a profile with no sign-in keys in
 * the config file (or no section there) is reported as "credentialsFile",
 * its keys being expected in ~/.aws/credentials.
 *
 * The order is the AWS SDK's own (`@aws-sdk/credential-provider-ini`):
 * assumed role, static keys, web identity, credential process, SSO.
 */
export type AwsProfileKind =
  | "sso"
  | "process"
  | "assumeRole"
  | "webIdentity"
  /** aws_access_key_id in the config file itself */
  | "static"
  /** No sign-in keys in the config file: static keys in ~/.aws/credentials */
  | "credentialsFile";

export function awsConfigFilePath(env = process.env): string {
  return env.AWS_CONFIG_FILE || path.join(os.homedir(), ".aws", "config");
}

/** The key names of one profile's section; undefined when there is none. */
export function profileKeyNames(
  text: string,
  profile: string,
): Set<string> | undefined {
  const wanted = profile === "default" ? ["default", "profile default"] : [];
  wanted.push(`profile ${profile}`);
  let keys: Set<string> | undefined;
  let inSection = false;
  for (const raw of text.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]*)\]/.exec(raw);
    if (header) {
      const name = header[1].trim().replace(/\s+/g, " ");
      inSection = wanted.includes(name);
      if (inSection) keys ??= new Set();
      continue;
    }
    // Indented lines are the values of a nested key (`s3 =`), not keys
    if (!inSection || /^\s/.test(raw)) continue;
    const key = /^([A-Za-z0-9_.-]+)\s*=/.exec(raw);
    if (key) keys!.add(key[1].toLowerCase());
  }
  return keys;
}

export function kindOfKeys(keys: Set<string> | undefined): AwsProfileKind {
  const has = (k: string) => keys?.has(k) ?? false;
  if (has("role_arn") && (has("source_profile") || has("credential_source"))) {
    return "assumeRole";
  }
  if (has("aws_access_key_id")) return "static";
  if (has("role_arn") && has("web_identity_token_file")) return "webIdentity";
  if (has("credential_process")) return "process";
  if (
    ["sso_session", "sso_start_url", "sso_account_id", "sso_role_name"].some(
      has,
    )
  ) {
    return "sso";
  }
  return "credentialsFile";
}

/** The kind of `profile`, or undefined when the config file cannot be read. */
export function awsProfileKind(
  profile: string,
  configFile = awsConfigFilePath(),
): AwsProfileKind | undefined {
  let text: string;
  try {
    text = fs.readFileSync(configFile, "utf8");
  } catch (e) {
    // No config file at all: the profile can only be in ~/.aws/credentials
    return (e as NodeJS.ErrnoException)?.code === "ENOENT"
      ? "credentialsFile"
      : undefined;
  }
  return kindOfKeys(profileKeyNames(text, profile));
}

/**
 * Fills in `awsProfileKind` on each Bedrock connection that names a profile
 * (Settings > Providers). The config file is read once.
 */
export function annotateAwsProfileKinds<
  T extends {
    provider: string;
    connection: { profile?: string };
    awsProfileKind?: AwsProfileKind;
  },
>(connections: T[], configFile = awsConfigFilePath()): T[] {
  const named = connections.filter(
    (c) =>
      (c.provider === "bedrock" || c.provider === "bedrock-mantle") &&
      c.connection.profile,
  );
  if (named.length === 0) return connections;
  let text: string | undefined;
  let missing = false;
  try {
    text = fs.readFileSync(configFile, "utf8");
  } catch (e) {
    missing = (e as NodeJS.ErrnoException)?.code === "ENOENT";
  }
  return connections.map((c) => {
    if (!named.includes(c)) return c;
    if (text === undefined) {
      return missing ? { ...c, awsProfileKind: "credentialsFile" } : c;
    }
    return {
      ...c,
      awsProfileKind: kindOfKeys(profileKeyNames(text, c.connection.profile!)),
    };
  });
}
