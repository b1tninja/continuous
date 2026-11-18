/**
 * Which Claude models refuse `temperature`, `top_p` and `top_k`.
 *
 * Source: https://platform.claude.com/docs/en/about-claude/model-deprecations
 * (read 2026-11-11, "API parameter deprecations"): the three are "removed in
 * API version 2026-10-21" (HTTP 400), and "earlier API versions return it
 * when set to a non-default value on Claude 4.7 and later models and Claude
 * Mythos Preview". We send a non-default value whenever the user sets one, so
 * the request is left without the three for those models. The same rows are
 * declared as the `samplingParams` surface fact (surfaceFacts.generated.json);
 * the test keeps this predicate and those rows in step.
 *
 * Pure and GUI-safe. A copy lives in
 * packages/openai-adapters/src/apis/anthropicSamplingGuard.ts: that package
 * cannot import from core, so edit both.
 */

/** `claude-opus-4-7`, `claude-sonnet-5`, `anthropic.claude-opus-4-8-v1:0`, `claude-4-7-opus`. */
const NAMED = /claude[-.](opus|sonnet|haiku)[-.](\d+)(?:[-.](\d{1,2})(?!\d))?/i;
const NUMBER_FIRST = /claude[-.](\d+)[-.](\d{1,2})[-.](?:opus|sonnet|haiku)/i;
const NEW_NAMES = /claude[-.](?:fable|mythos)/i;

export function claudeRefusesSampling(modelId: string | undefined): boolean {
  if (!modelId) return false;
  if (NEW_NAMES.test(modelId)) return true;
  let major: number;
  let minor: number;
  const named = NAMED.exec(modelId);
  const first = NUMBER_FIRST.exec(modelId);
  if (named) {
    major = Number(named[2]);
    minor = named[3] === undefined ? 0 : Number(named[3]);
  } else if (first) {
    major = Number(first[1]);
    minor = Number(first[2]);
  } else {
    return false;
  }
  return major > 4 || (major === 4 && minor >= 7);
}

/**
 * Whether to leave `temperature`, `top_p` and `top_k` out of a request. The
 * model's `omitSampling` setting wins when it is set: `true` omits them for
 * any model, `false` sends them even to a model the predicate says refuses
 * them (a proxy that maps the id, or a model released after this list). Unset
 * follows the predicate.
 */
export function omitsSampling(
  modelId: string | undefined,
  override?: boolean | null,
): boolean {
  if (override === true || override === false) return override;
  return claudeRefusesSampling(modelId);
}

const logged = new Set<string>();

/** Say once per model that the sampling fields were left out. */
export function noteSamplingOmitted(
  modelId: string | undefined,
  forced = false,
): void {
  if (!modelId || logged.has(modelId)) return;
  logged.add(modelId);
  if (forced) {
    console.debug(
      `Anthropic: omitSampling is set for ${modelId}; omitting temperature, top_p and top_k from the request`,
    );
    return;
  }
  console.debug(
    `Anthropic: ${modelId} refuses temperature, top_p and top_k; omitting them from the request`,
  );
}
