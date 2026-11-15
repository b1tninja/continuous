import type { ProviderSetupConnection } from "core/config/providerSetup";
import { isOpenAICloud } from "../../../components/ProviderSetup/providerSetupUtils";
import { providerLabel } from "../../../util/missingSecrets";
import {
  providers,
  type ProviderInfo,
} from "../../AddNewModel/configs/providers";

/**
 * Texts for one provider connection on the Providers page. Every one is
 * built from the setup info, which carries key names and where a key is
 * kept, never a key.
 */

const isBedrock = (provider: string) =>
  provider === "bedrock" || provider === "bedrock-mantle";

/** The setup flow's entry for a connection: an "openai" one elsewhere is a local server. */
export function providerInfoFor(
  c: Pick<ProviderSetupConnection, "provider" | "connection">,
): ProviderInfo | undefined {
  if (
    c.provider === "openai" &&
    c.connection.apiBase &&
    !isOpenAICloud(c.connection.apiBase)
  ) {
    return providers["openai-compatible"];
  }
  return providers[c.provider];
}

export function providerTitle(
  c: Pick<ProviderSetupConnection, "provider" | "connection">,
): string {
  return providerInfoFor(c)?.title ?? providerLabel(c.provider);
}

/** Account, endpoint and region; empty for a provider's default endpoint. */
export function connectionLabel(c: ProviderSetupConnection): string {
  return [
    c.account ? `Account ${c.account}` : undefined,
    c.connection.apiBase,
    c.connection.region,
  ]
    .filter(Boolean)
    .join(" · ");
}

export type AuthTone = "ok" | "warning";

/** How the connection signs in, and whether that needs attention. */
export function authLabel(c: ProviderSetupConnection): {
  text: string;
  tone: AuthTone;
} {
  const { key } = c;
  if (key.state === "secret") {
    const name = key.secretName ?? "a secret";
    if (key.storedIn?.secure) {
      return { text: `Key ${name} in secure storage`, tone: "ok" };
    }
    if (key.storedIn?.env) {
      return { text: `Key ${name} in ~/.continuous/.env`, tone: "ok" };
    }
    if (key.storedIn) {
      // Neither store has it: an environment variable, or nothing at all.
      return {
        text: `Key ${name} from the environment (not in secure storage or ~/.continuous/.env)`,
        tone: "warning",
      };
    }
    return { text: `Key ${name}`, tone: "ok" };
  }
  if (key.state === "inline") {
    return {
      text: c.account
        ? "Key in plain text in providers.yaml"
        : "Key in plain text in config.yaml",
      tone: "warning",
    };
  }
  if (isBedrock(c.provider)) {
    return {
      text: c.connection.profile
        ? `AWS profile ${c.connection.profile}`
        : "AWS default credentials (environment, SSO or ~/.aws)",
      tone: "ok",
    };
  }
  return { text: "No key", tone: "ok" };
}

export function modelCountLabel(c: ProviderSetupConnection): string {
  const n = c.models.length;
  return `${n} model${n === 1 ? "" : "s"} enabled`;
}

/** What Remove does, said before anything is changed. */
export function removeConfirmText(c: ProviderSetupConnection): string {
  const n = c.models.length;
  const names = c.models.map((m) => m.name).join(", ");
  const what = `${n} model${n === 1 ? "" : "s"}${names ? ` (${names})` : ""}`;
  const where = connectionLabel(c);
  const sentences = [
    `Remove ${providerTitle(c)}${where ? ` (${where})` : ""}?`,
    `This takes its ${what} out of config.yaml and out of the mode model lists.`,
  ];
  if (c.account) {
    sentences.push(
      `The account ${c.account} in ~/.continuous/providers.yaml and its catalog models stay; delete the account under Provider accounts.`,
    );
  }
  const { key } = c;
  if (key.state === "secret" && key.secretName) {
    const kept = [
      key.storedIn?.secure ? "secure storage" : undefined,
      key.storedIn?.env ? "~/.continuous/.env" : undefined,
    ].filter(Boolean);
    sentences.push(
      kept.length > 0
        ? `Stored keys are not deleted: ${key.secretName} stays in ${kept.join(" and ")}.`
        : `Stored keys are not deleted.`,
    );
  } else if (key.state === "inline") {
    sentences.push(
      c.account
        ? "The account's key in providers.yaml stays."
        : "The key written in plain text on these models is removed with them.",
    );
  }
  return sentences.join(" ");
}
