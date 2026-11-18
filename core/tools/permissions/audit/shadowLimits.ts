/**
 * The limits of the shadow reviewer's settings (ROADMAP B67), apart from the
 * code that reads and writes the file so the Settings page can import them
 * without pulling in node modules.
 */
export const DEFAULT_SHADOW_TIMEOUT_MS = 5000;
/** A shadow review is never worth holding anything up for */
export const MAX_SHADOW_TIMEOUT_MS = 15_000;
export const MIN_SHADOW_TIMEOUT_MS = 500;
export const MAX_SHADOW_BUDGET_USD = 100;
