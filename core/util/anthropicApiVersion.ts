/**
 * The `anthropic-version` header values this codebase sends (K23,
 * plans/decisions-2026-11-15.md).
 *
 * - The models list and per-model lookup (`GET /v1/models`, `GET
 *   /v1/models/{id}`) send the newer version: on those endpoints it changes no
 *   request shape and returns the lifecycle fields. A service that refuses it
 *   with a 400 is asked again with the older one.
 * - Messages stays on 2023-06-01. Version 2026-10-21 removes `temperature`,
 *   `top_p` and `top_k` from Messages (a 400 on every model), so the Messages
 *   path moves only once the sampling guard covers every route. The Messages
 *   header itself is set in packages/openai-adapters/src/apis/AnthropicUtils.ts
 *   (`getAnthropicHeaders`); keep the two in step.
 */
export const ANTHROPIC_LIST_VERSION = "2026-10-21";
export const ANTHROPIC_MESSAGES_VERSION = "2023-06-01";
/** What a list call falls back to when the newer version gets a 400. */
export const ANTHROPIC_FALLBACK_VERSION = ANTHROPIC_MESSAGES_VERSION;
