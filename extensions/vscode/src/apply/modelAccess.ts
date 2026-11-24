/**
 * Whether an error from a model says the account may not use it: a provider
 * refusal, a missing grant, a bad or missing key. Retrying the same model
 * meets the same answer, so the apply step uses another one (ApplyManager).
 * Anything else (a timeout, a rate limit, bad output) is not this and is left
 * to fail as it did.
 */
const ACCESS_ERROR =
  /\b(refused us|has not been given access|not been granted access|not available for this account|access ?denied|accessdeniedexception|not authorized|unauthorized|forbidden|invalid api key|invalid x-api-key|incorrect api key|authentication (failed|error)|permission denied|model[_ ]not[_ ]found|status code:? ?(401|403)|http (401|403))\b/i;

export function isModelAccessError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return ACCESS_ERROR.test(message);
}
