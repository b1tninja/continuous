import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  annotateAwsProfileKinds,
  awsConfigFilePath,
  awsProfileKind,
} from "./awsProfileKind";

const CONFIG = `
[default]
region = us-east-1

[profile work]
sso_session = corp
sso_account_id = 111122223333
sso_role_name = Dev
region = us-west-2

[sso-session corp]
sso_start_url = https://corp.awsapps.com/start
sso_region = us-east-1

[profile legacy-sso]
sso_start_url = https://corp.awsapps.com/start

[profile vault]
credential_process = /usr/local/bin/vault-aws --profile vault

[profile admin]
role_arn = arn:aws:iam::111122223333:role/Admin
source_profile = work

[profile ci]
role_arn = arn:aws:iam::111122223333:role/Ci
web_identity_token_file = /var/run/token

[profile keys]
aws_access_key_id = AKIAEXAMPLEEXAMPLE00
aws_secret_access_key = not-a-real-secret
s3 =
  role_arn = nested-is-not-a-key
`;

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "aws-kind-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  // The live-provider guard points this at a file that does not exist
  vi.stubEnv("AWS_CONFIG_FILE", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

function writeConfig(text: string) {
  fs.mkdirSync(path.join(home, ".aws"));
  fs.writeFileSync(path.join(home, ".aws", "config"), text);
}

describe("awsProfileKind", () => {
  it("reads ~/.aws/config of the home directory", () => {
    writeConfig(CONFIG);
    expect(awsConfigFilePath()).toBe(path.join(home, ".aws", "config"));
    expect(awsProfileKind("work")).toBe("sso");
    expect(awsProfileKind("legacy-sso")).toBe("sso");
    expect(awsProfileKind("vault")).toBe("process");
    expect(awsProfileKind("admin")).toBe("assumeRole");
    expect(awsProfileKind("ci")).toBe("webIdentity");
    expect(awsProfileKind("keys")).toBe("static");
  });

  it("expects the keys in ~/.aws/credentials for a profile without sign-in keys in the config, or not in it", () => {
    writeConfig(CONFIG);
    expect(awsProfileKind("default")).toBe("credentialsFile");
    expect(awsProfileKind("only-in-credentials")).toBe("credentialsFile");
  });

  it("does not take an [sso-session] section for a profile of that name", () => {
    writeConfig(CONFIG);
    expect(awsProfileKind("corp")).toBe("credentialsFile");
  });

  it("never opens ~/.aws/credentials", () => {
    writeConfig(CONFIG);
    fs.writeFileSync(
      path.join(home, ".aws", "credentials"),
      "[work]\ncredential_process = x\n",
    );
    const read = vi.spyOn(fs, "readFileSync");
    expect(awsProfileKind("work")).toBe("sso");
    expect(awsProfileKind("only-in-credentials")).toBe("credentialsFile");
    const files = read.mock.calls.map((c) => String(c[0]));
    expect(files.every((f) => !f.endsWith("credentials"))).toBe(true);
    read.mockRestore();
  });

  it("follows AWS_CONFIG_FILE", () => {
    const file = path.join(home, "elsewhere.ini");
    fs.writeFileSync(file, "[profile x]\ncredential_process = y\n");
    vi.stubEnv("AWS_CONFIG_FILE", file);
    expect(awsProfileKind("x")).toBe("process");
  });

  it("expects ~/.aws/credentials when there is no config file at all", () => {
    expect(awsProfileKind("work")).toBe("credentialsFile");
  });

  it("annotates only Bedrock connections that name a profile, reading the file once", () => {
    writeConfig(CONFIG);
    const read = vi.spyOn(fs, "readFileSync");
    const out = annotateAwsProfileKinds([
      { provider: "bedrock", connection: { profile: "work" } },
      { provider: "bedrock-mantle", connection: { profile: "vault" } },
      { provider: "bedrock", connection: { region: "us-east-1" } },
      { provider: "anthropic", connection: { profile: "work" } },
    ]);
    expect(out.map((c) => (c as any).awsProfileKind)).toEqual([
      "sso",
      "process",
      undefined,
      undefined,
    ]);
    expect(read).toHaveBeenCalledTimes(1);
    read.mockRestore();
  });

  it("leaves the kind out when the config file cannot be read", () => {
    fs.mkdirSync(path.join(home, ".aws", "config"), { recursive: true });
    const [c] = annotateAwsProfileKinds([
      { provider: "bedrock", connection: { profile: "work" } },
    ]);
    expect((c as any).awsProfileKind).toBeUndefined();
  });
});
