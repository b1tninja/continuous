import type { ModelDescription } from "core";
import { DEFAULT_CONTEXT_LENGTH } from "core/llm/constants";

const SLIDER_MIN = 4_096;
const SLIDER_STEP = 1_024;

const inputClass =
  "w-full rounded-default border border-solid border-input-border bg-input px-2 py-1 text-xs text-input-foreground placeholder:text-input-placeholder focus:outline focus:outline-1 focus:outline-border-focus aria-[invalid=true]:border-error";

function sliderCeiling(tokens: number): number {
  return Math.max(2_000_000, tokens * 2);
}

function windowNote(
  source: ModelDescription["contextLengthSource"] | undefined,
  published: number,
): string {
  const n = published.toLocaleString();
  if (source === "unknown") {
    return `No published window is known for this model. ${DEFAULT_CONTEXT_LENGTH.toLocaleString()} is in use until you set one.`;
  }
  if (source === "provider") {
    return `The provider reported a window of ${n} tokens. The slider starts there. Raise or lower it to set your own.`;
  }
  if (source === "published") {
    return `Published window for this model: ${n} tokens. The slider starts there. Raise or lower it to set your own.`;
  }
  if (source === "config") {
    return `This window is set in your configuration (${n} tokens). Move the slider to change it.`;
  }
  return `Window in use: ${n} tokens. ${DEFAULT_CONTEXT_LENGTH.toLocaleString()} is used only when no window is known.`;
}

/**
 * The context window for one model: the published size, a slider, and a
 * number. An empty value means "use the published window".
 */
export function ContextLengthControl({
  value,
  onChange,
  error,
  published,
  source,
  inputId = "context-length-number",
  testId = "context-length-slider",
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string;
  published?: number;
  source?: ModelDescription["contextLengthSource"];
  inputId?: string;
  testId?: string;
}) {
  const written = parseTokens(value);
  const fallback =
    published && published > 0 ? published : DEFAULT_CONTEXT_LENGTH;
  const shown = written ?? fallback;
  const max = Math.max(sliderCeiling(fallback), shown);
  const usingDefault = written === undefined;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-xs font-medium">
        Context length (tokens)
      </label>
      <span className="text-2xs text-description-muted">
        {windowNote(source, fallback)}
      </span>
      <input
        type="range"
        data-testid={testId}
        aria-label="Context length"
        className="h-4 w-full cursor-pointer accent-blue-400"
        min={SLIDER_MIN}
        max={max}
        step={SLIDER_STEP}
        value={Math.min(max, Math.max(SLIDER_MIN, shown))}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="flex items-center gap-2">
        <input
          id={inputId}
          data-testid={inputId}
          type="text"
          inputMode="numeric"
          className={inputClass}
          aria-invalid={error ? true : undefined}
          value={value}
          placeholder={String(fallback)}
          onChange={(e) => onChange(e.target.value)}
        />
        {!usingDefault && (
          <button
            type="button"
            className="cursor-pointer border-none bg-transparent p-0 text-2xs whitespace-nowrap text-link underline"
            onClick={() => onChange("")}
          >
            Use default
          </button>
        )}
      </div>
      {usingDefault && (
        <span className="text-2xs text-description-muted">
          {`Showing ${fallback.toLocaleString()} tokens. Move the slider or type a number to save your own.`}
        </span>
      )}
      {error && (
        <span className="text-2xs text-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

function parseTokens(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

/** A saved window, or undefined when the field is still the published default. */
export function contextLengthOverride(
  raw: string | undefined,
): number | undefined {
  if (raw === undefined) return undefined;
  return parseTokens(raw);
}
