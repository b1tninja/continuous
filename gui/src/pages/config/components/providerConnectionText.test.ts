import type { ProviderSetupConnection } from "core/config/providerSetup";
import { describe, expect, it } from "vitest";
import {
  authLabel,
  connectionLabel,
  removeConfirmText,
} from "./providerConnectionText";

const conn = (
  extra: Partial<ProviderSetupConnection> = {},
): ProviderSetupConnection => ({
  provider: "anthropic",
  connection: {},
  models: [{ name: "Opus", model: "claude-opus" }],
  key: { state: "none" },
  ...extra,
});

describe("authLabel", () => {
  it("names where a key is kept and flags a plaintext one", () => {
    expect(
      authLabel(
        conn({
          key: {
            state: "secret",
            secretName: "K",
            storedIn: { secure: false, env: true },
          },
        }),
      ),
    ).toEqual({ text: "Key K in ~/.continuous/.env", tone: "ok" });
    expect(authLabel(conn({ key: { state: "inline" } }))).toEqual({
      text: "Key in plain text in config.yaml",
      tone: "warning",
    });
    expect(
      authLabel(conn({ account: "a", key: { state: "inline" } })).text,
    ).toBe("Key in plain text in providers.yaml");
  });

  it("describes Bedrock sign-in by profile or the default chain, and a keyless server", () => {
    expect(authLabel(conn({ provider: "bedrock" })).text).toBe(
      "AWS default credentials (environment, SSO or ~/.aws)",
    );
    expect(
      authLabel(
        conn({ provider: "bedrock-mantle", connection: { profile: "p" } }),
      ).text,
    ).toBe("AWS profile p");
    expect(authLabel(conn({ provider: "ollama" })).text).toBe("No key");
  });

  it("says how the AWS profile signs in when core read it from ~/.aws/config", () => {
    const profile = (awsProfileKind: any) =>
      authLabel(
        conn({
          provider: "bedrock",
          connection: { profile: "work" },
          awsProfileKind,
        }),
      ).text;
    expect(profile("sso")).toBe("AWS SSO profile work");
    expect(profile("process")).toBe("AWS profile work (credential_process)");
    expect(profile("assumeRole")).toBe("AWS profile work (assumes a role)");
    expect(profile("webIdentity")).toBe(
      "AWS profile work (web identity token)",
    );
    expect(profile("static")).toBe(
      "AWS profile work (access keys in ~/.aws/config)",
    );
    expect(profile("credentialsFile")).toBe(
      "AWS profile work (access keys in ~/.aws/credentials)",
    );
    expect(profile(undefined)).toBe("AWS profile work");
  });
});

describe("connectionLabel", () => {
  it("joins account, endpoint and region and is empty for a default endpoint", () => {
    expect(connectionLabel(conn())).toBe("");
    expect(
      connectionLabel(
        conn({
          account: "work",
          connection: { apiBase: "https://x/v1", region: "eu-west-1" },
        }),
      ),
    ).toBe("Account work · https://x/v1 · eu-west-1");
  });
});

describe("removeConfirmText", () => {
  it("says a plaintext key on the models goes with them", () => {
    expect(removeConfirmText(conn({ key: { state: "inline" } }))).toBe(
      "Remove Anthropic? This takes its 1 model (Opus) out of config.yaml and out of the mode model lists. The key written in plain text on these models is removed with them.",
    );
  });

  it("never names a key value, only where a stored key stays", () => {
    const text = removeConfirmText(
      conn({
        key: {
          state: "secret",
          secretName: "K",
          storedIn: { secure: true, env: true },
        },
      }),
    );
    expect(text).toContain(
      "Stored keys are not deleted: K stays in secure storage and ~/.continuous/.env.",
    );
  });
});
