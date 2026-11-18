import { useId, useState } from "react";
import { Button } from "../../../../../components/ui";

/** A short list of names with add and remove, checked as it is added. */
export function StringListEditor({
  label,
  hint,
  items,
  onChange,
  placeholder,
  validate,
  testId,
}: {
  label: string;
  hint: string;
  items: string[];
  onChange: (items: string[]) => void;
  placeholder: string;
  /** Why the text cannot be added, or undefined */
  validate: (value: string) => string | undefined;
  testId: string;
}) {
  const id = useId();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | undefined>();
  return (
    <section aria-labelledby={`${id}-label`} data-testid={testId}>
      <h6 id={`${id}-label`} className="my-0 text-xs font-semibold">
        {label}
      </h6>
      <p className="my-0 text-2xs text-description-muted">{hint}</p>
      {items.length === 0 ? (
        <p className="my-1 text-2xs text-description">None.</p>
      ) : (
        <ul className="m-0 flex flex-col gap-1 p-0">
          {items.map((item) => (
            <li key={item} className="flex list-none items-center gap-1">
              <code className="min-w-0 flex-1 text-xs break-all">{item}</code>
              <Button
                size="sm"
                variant="outline"
                className="min-h-6"
                aria-label={`Remove ${item}`}
                onClick={() => onChange(items.filter((i) => i !== item))}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="mt-1 flex items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          const value = draft.trim();
          const why =
            validate(draft) ??
            (items.includes(value) ? "That is already listed." : undefined);
          if (why) {
            setError(why);
            return;
          }
          onChange([...items, value]);
          setDraft("");
          setError(undefined);
        }}
      >
        <input
          aria-label={`Add to: ${label}`}
          aria-describedby={`${id}-error`}
          aria-invalid={error ? true : undefined}
          value={draft}
          placeholder={placeholder}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(undefined);
          }}
          data-testid={`${testId}-input`}
          className="min-w-0 flex-1 rounded border border-solid border-border bg-input px-1 text-xs text-foreground"
        />
        <Button type="submit" size="sm" variant="outline" className="min-h-6">
          Add
        </Button>
      </form>
      <p
        id={`${id}-error`}
        role={error ? "alert" : undefined}
        className="m-0 text-2xs text-error"
      >
        {error}
      </p>
    </section>
  );
}
