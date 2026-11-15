import type { MostAskedRow } from "core/tools/permissions/audit/auditOverview";
import {
  DECISION_NAMES,
  ruleForSample,
  ruleMatchesSample,
  type PreviewSample,
} from "core/tools/permissions/customPolicy";
import { validateRuleText } from "core/tools/permissions/ruleAnalysis";
import { useId, useState } from "react";
import { Button } from "../../../../../components/ui";
import { DecisionChip } from "../badges";
import {
  EDITABLE_LISTS,
  LIST_HINTS,
  LIST_NAMES,
  decisionOfList,
  type EditableLists,
  type ListKey,
} from "./customPolicyState";

/**
 * The person's own lists as one editor: Never, Ask and Always (config.yaml)
 * and Always-on (the `floor:` of permissions.yaml, which binds below IDGAF). Each
 * rule can be removed or moved to another list; a new rule is checked as it is
 * typed and previewed against recent calls with the engine's own matchers.
 * Nothing is written here: the review step saves.
 */
export function RuleListsEditor({
  lists,
  onChange,
  samples,
  mostAsked,
  samplesNote,
}: {
  lists: EditableLists;
  onChange: (next: EditableLists) => void;
  /** Recent calls from the audit trail, for the preview and to add from */
  samples: PreviewSample[];
  /** Asks the person always answered the same way (the audit overview) */
  mostAsked: MostAskedRow[];
  /** Why there are no samples, when there are none */
  samplesNote?: string;
}) {
  const inputId = useId();
  const listId = useId();
  const [target, setTarget] = useState<ListKey>("deny");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [status, setStatus] = useState<string | undefined>();

  const add = (key: ListKey, rule: string): boolean => {
    const text = rule.trim();
    const invalid = validateRuleText(text, decisionOfList(key));
    const where = EDITABLE_LISTS.find((k) => lists[k].includes(text));
    const problem =
      invalid ??
      (where === key
        ? "That rule is already in this list."
        : where
          ? `That rule is already in the ${LIST_NAMES[where]} list. Move it instead.`
          : undefined);
    if (problem) {
      setError(problem);
      return false;
    }
    onChange({ ...lists, [key]: [...lists[key], text] });
    setError(undefined);
    setStatus(`Added ${text} to ${LIST_NAMES[key]}.`);
    return true;
  };

  const remove = (key: ListKey, rule: string) => {
    onChange({ ...lists, [key]: lists[key].filter((r) => r !== rule) });
    setStatus(`Removed ${rule} from ${LIST_NAMES[key]}.`);
  };

  const move = (from: ListKey, to: ListKey, rule: string) => {
    if (from === to || lists[to].includes(rule)) return;
    onChange({
      ...lists,
      [from]: lists[from].filter((r) => r !== rule),
      [to]: [...lists[to], rule],
    });
    setStatus(`Moved ${rule} from ${LIST_NAMES[from]} to ${LIST_NAMES[to]}.`);
  };

  const draftText = draft.trim();
  const matched = draftText
    ? samples.filter(
        (s) => ruleMatchesSample(draftText, decisionOfList(target), s) === true,
      )
    : [];
  const unreadable =
    draftText !== "" &&
    ruleMatchesSample(draftText, "deny", { tool: "x" }) === undefined;

  return (
    <div className="flex flex-col gap-3" data-testid="rule-lists-editor">
      <div role="status" aria-live="polite" className="sr-only">
        {status}
      </div>
      <form
        className="flex flex-col gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (add(target, draft)) setDraft("");
        }}
      >
        <label htmlFor={inputId} className="text-xs font-semibold">
          Add a rule
        </label>
        <div className="flex flex-wrap items-center gap-1">
          <select
            aria-label="List to add to"
            data-testid="add-rule-list"
            value={target}
            onChange={(e) => setTarget(e.target.value as ListKey)}
            className="rounded border border-solid border-border bg-input px-1 text-xs text-foreground"
          >
            {EDITABLE_LISTS.map((k) => (
              <option key={k} value={k}>
                {LIST_NAMES[k]}
              </option>
            ))}
          </select>
          <input
            id={inputId}
            data-testid="add-rule-input"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(undefined);
            }}
            placeholder="runTerminalCommand(git push*)"
            aria-describedby={`${inputId}-preview ${inputId}-error`}
            aria-invalid={error ? true : undefined}
            className="min-w-0 flex-1 rounded border border-solid border-border bg-input px-1 font-mono text-xs text-foreground"
          />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            className="min-h-6"
            data-testid="add-rule-submit"
          >
            Add
          </Button>
        </div>
        <p
          id={`${inputId}-error`}
          role={error ? "alert" : undefined}
          data-testid="add-rule-error"
          className="m-0 text-2xs text-error"
        >
          {error}
        </p>
        <div
          id={`${inputId}-preview`}
          data-testid="add-rule-preview"
          className="text-2xs text-description"
        >
          {!draftText
            ? `${LIST_HINTS[target]}`
            : unreadable
              ? "This cannot be read as a rule yet: write toolName(pattern), or just toolName."
              : samples.length === 0
                ? (samplesNote ?? "No recent calls to preview against.")
                : `Matches ${matched.length} of the last ${samples.length} calls.`}
          {matched.length > 0 && (
            <ul className="m-0 mt-1 pl-4" data-testid="add-rule-matches">
              {matched.slice(0, 5).map((s, i) => (
                <li key={`${s.tool}:${s.value}:${i}`}>
                  <code className="break-all">
                    {s.tool}
                    {s.value ? `: ${s.value}` : ""}
                  </code>
                </li>
              ))}
            </ul>
          )}
        </div>
      </form>

      {EDITABLE_LISTS.map((key) => (
        <section
          key={key}
          aria-labelledby={`${listId}-${key}`}
          data-testid={`list-${key}`}
        >
          <h6 id={`${listId}-${key}`} className="my-1 text-xs font-semibold">
            {LIST_NAMES[key]}{" "}
            <span className="font-normal text-description-muted">
              ({lists[key].length})
            </span>
          </h6>
          <p className="my-0 text-2xs text-description-muted">
            {LIST_HINTS[key]}
          </p>
          {lists[key].length === 0 ? (
            <p className="my-1 text-2xs text-description">None.</p>
          ) : (
            <ul className="m-0 flex flex-col gap-1 p-0">
              {lists[key].map((rule) => (
                <li
                  key={rule}
                  className="flex list-none flex-wrap items-center gap-1"
                  data-testid={`rule-${key}-${rule}`}
                >
                  <DecisionChip decision={decisionOfList(key)} />
                  <code className="min-w-0 flex-1 font-mono text-xs break-all">
                    {rule}
                  </code>
                  <select
                    aria-label={`Move ${rule} to another list`}
                    data-testid={`move-${key}-${rule}`}
                    value=""
                    onChange={(e) =>
                      e.target.value &&
                      move(key, e.target.value as ListKey, rule)
                    }
                    className="rounded border border-solid border-border bg-input px-1 text-2xs text-foreground"
                  >
                    <option value="">Move to…</option>
                    {EDITABLE_LISTS.filter((k) => k !== key).map((k) => (
                      <option key={k} value={k}>
                        {LIST_NAMES[k]}
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    variant="outline"
                    className="min-h-6"
                    aria-label={`Remove ${rule} from ${LIST_NAMES[key]}`}
                    data-testid={`remove-${key}-${rule}`}
                    onClick={() => remove(key, rule)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}

      {(mostAsked.length > 0 || samples.length > 0) && (
        <section aria-label="Add from the audit trail" data-testid="from-audit">
          <h6 className="my-1 text-xs font-semibold">From the audit trail</h6>
          {mostAsked.length > 0 && (
            <>
              <p className="my-0 text-2xs text-description-muted">
                Asked again and again, and you always answered the same way.
              </p>
              <ul className="m-0 flex flex-col gap-1 p-0">
                {mostAsked.map((row) => {
                  const key: ListKey =
                    row.answer === "allow" ? "allow" : "deny";
                  return (
                    <li
                      key={row.rule}
                      className="flex list-none flex-wrap items-center gap-1"
                    >
                      <code className="min-w-0 flex-1 text-xs break-all">
                        {row.rule}
                      </code>
                      <span className="text-2xs text-description">
                        {row.answered}× {DECISION_NAMES[key].toLowerCase()}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        className="min-h-6"
                        aria-label={`Add ${row.rule} to ${LIST_NAMES[key]}`}
                        onClick={() => add(key, row.rule)}
                      >
                        Add to {LIST_NAMES[key]}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {samples.length > 0 && (
            <>
              <p className="my-0 mt-1 text-2xs text-description-muted">
                Recent calls. Adding one writes the exact call; widen it with *
                before you add it if you mean more.
              </p>
              <ul className="m-0 flex flex-col gap-1 p-0">
                {samples.slice(0, 10).map((s, i) => {
                  const rule = ruleForSample(s);
                  if (!rule) return null;
                  return (
                    <li
                      key={`${rule}:${i}`}
                      className="flex list-none flex-wrap items-center gap-1"
                    >
                      <code className="min-w-0 flex-1 text-xs break-all">
                        {rule}
                      </code>
                      <Button
                        size="sm"
                        variant="outline"
                        className="min-h-6"
                        aria-label={`Edit ${rule} before adding it`}
                        onClick={() => {
                          setDraft(rule);
                          document.getElementById(inputId)?.focus();
                        }}
                      >
                        Use
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>
      )}
    </div>
  );
}
