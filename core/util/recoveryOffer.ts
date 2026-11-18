/**
 * The "Turn on recovery" offer on a Test connection result (ROADMAP Q50): shown
 * only when the probe saw the model write a tool call as text in a markup the
 * recovery can read, the provider's path recovers text at all, and the server
 * does not parse calls itself. It only ever offers: setting `toolDialect` is
 * the person's own decision, written to their own config.yaml after a native
 * confirmation (GUI) or pasted by hand (CLI).
 */
import type { OpenAICompatProbe } from "./openaiCompatTest.js";
import { providerRecoversText } from "./toolDialectLeak.js";

export interface RecoveryOffer {
  dialect: string;
}

export function recoveryOffer(
  probe: OpenAICompatProbe | undefined,
  provider: string,
  surface: "ide" | "cli",
): RecoveryOffer | undefined {
  if (!probe || probe.kind !== "text" || probe.serverParses) return undefined;
  if (!probe.recoveryDialect || !providerRecoversText(provider, surface)) {
    return undefined;
  }
  return { dialect: probe.recoveryDialect };
}

/** A copyable config.yaml fragment; the model entry is the one to edit. */
export function recoverySnippet(
  provider: string,
  model: string,
  dialect: string,
): string[] {
  return [
    "models:",
    `  - name: ${JSON.stringify(model)}`,
    `    provider: ${provider}`,
    `    model: ${JSON.stringify(model)}`,
    `    toolDialect: ${dialect}`,
  ];
}

/** The text the native confirmation shows. */
export function recoveryConfirmText(model: string, dialect: string): string {
  return `Turn on tool-call recovery for "${model}"? This sets toolDialect: ${dialect} on that model in your config.yaml, so tool calls it writes as text in that format are run.`;
}
