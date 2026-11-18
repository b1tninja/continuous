/**
 * Global configuration for tools system.
 * This stores command-line flags that affect tool availability.
 */

let betaSubagentToolEnabled = false;

export function setBetaSubagentToolEnabled(enabled: boolean): void {
  betaSubagentToolEnabled = enabled;
}

export function isBetaSubagentToolEnabled(): boolean {
  return betaSubagentToolEnabled;
}
