import type { ToolRuleEditResponse } from "core/tools/permissions/ruleEditor";
import type { RuleDecision } from "core/tools/permissions/rules";
import {
  CONFIRM_PHRASE,
  DECISION_WORDS,
} from "core/tools/permissions/ruleWords";
import { parseWrittenRule } from "core/tools/permissions/writtenRule";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../../../../components/ui";
import { DecisionChip } from "./badges";
import {
  DiffView,
  NativeNotice,
  TypedConfirmation,
  Verdict,
  WrittenRuleLine,
} from "./RuleFormParts";
import { useRuleChange, type RuleChange } from "./useRuleChange";

/** What the form is for: a new rule, a change to one of yours, or adopting one from elsewhere. */
export type FormMode =
  | {
      kind: "add";
      prefix: string;
      example: string;
      /** The list the rule starts in (Ask when absent); set by the most-asked list and the inbox */
      decision?: RuleDecision;
    }
  | { kind: "edit"; decision: RuleDecision; rule: string }
  | { kind: "adopt"; decision: RuleDecision; rule: string; from: string }
  | { kind: "remove"; decision: RuleDecision; rule: string };

const DECISIONS: RuleDecision[] = ["deny", "ask", "allow"];

function changeOf(
  mode: FormMode,
  decision: RuleDecision,
  rule: string,
): RuleChange | undefined {
  const text = rule.trim();
  if (mode.kind === "adopt" || mode.kind === "remove") {
    return { op: mode.kind, decision: mode.decision, rule: mode.rule };
  }
  if (!text) return undefined;
  if (mode.kind === "add") return { op: "add", decision, rule: text };
  if (mode.decision === decision && mode.rule === text) return undefined;
  return {
    op: "update",
    decision: mode.decision,
    rule: mode.rule,
    newDecision: decision,
    newRule: text,
  };
}

/**
 * Add, change or adopt one rule. Every keystroke is checked by core with a dry
 * run (nothing is written): the form shows the warnings, what the file would
 * look like, and what a sample call gets now and with the rule. Save stays off
 * until the confirmation the change needs has been given.
 */
export function RuleChangeForm({
  mode,
  baseHash,
  onSaved,
  onCancel,
}: {
  mode: FormMode;
  baseHash?: string;
  onSaved: (res: ToolRuleEditResponse) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const initialRule = mode.kind === "add" ? mode.prefix : mode.rule;
  const [decision, setDecision] = useState<RuleDecision>(
    mode.kind === "add" ? (mode.decision ?? "ask") : mode.decision,
  );
  const [rule, setRule] = useState(initialRule);
  const [probe, setProbe] = useState("");
  const [confirm, setConfirm] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const change = changeOf(mode, decision, rule);
  const state = useRuleChange(change, baseHash);
  const { preview } = state;
  const friction = preview?.analysis?.friction ?? "none";
  // The typed phrase is the page's part; whatever loosens is also confirmed
  // in the editor's own dialog, which this page cannot answer.
  const confirmed =
    friction !== "typed" || confirm.trim().toLowerCase() === CONFIRM_PHRASE;
  const canSave =
    Boolean(preview?.result === "preview") && confirmed && !state.busy;
  const [waiting, setWaiting] = useState(false);
  // Text pasted from `continuous audit suggest` or the CLI sets both fields
  const onRuleText = (value: string) => {
    const written =
      mode.kind === "add" &&
      /^\s*(continuous|cn)\s|^\s*(never|ask|always)\s/i.test(value)
        ? parseWrittenRule(value)
        : undefined;
    if (written?.ok && written.decision) {
      setDecision(written.decision);
      setRule(written.rule);
    } else {
      setRule(value);
    }
  };

  useEffect(() => {
    if (mode.kind === "add" || mode.kind === "edit") input.current?.focus();
  }, [mode.kind]);

  useEffect(() => {
    setConfirm("");
  }, [decision, rule]);

  const title =
    mode.kind === "add"
      ? "Add a rule"
      : mode.kind === "edit"
        ? "Change this rule"
        : mode.kind === "remove"
          ? "Remove this rule"
          : "Adopt this rule";
  const submit = async () => {
    setWaiting(Boolean(preview?.analysis?.loosens));
    const res = await state.save(confirm || undefined);
    setWaiting(false);
    if (
      res &&
      ["added", "updated", "removed", "adopted"].includes(res.result)
    ) {
      onSaved(res);
    }
  };

  return (
    <form
      aria-label={title}
      data-testid="rule-form"
      className="flex min-w-0 flex-col gap-2 rounded-sm border border-solid border-border-focus p-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) void submit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <h5 className="m-0 text-xs font-semibold">{title}</h5>
      {mode.kind === "adopt" || mode.kind === "remove" ? (
        <>
          {mode.kind === "adopt" ? (
            <p className="m-0 text-2xs text-description-muted">
              This rule is in{" "}
              {mode.from === "folder"
                ? "a workspace file"
                : "an assistant configuration"}
              , so it is ignored: only your own config.yaml can add an Always
              rule. Adopting copies it there. Check what it changes first.
            </p>
          ) : (
            <p className="m-0 text-2xs text-description-muted">
              This takes the rule out of your config.yaml.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-1">
            <DecisionChip decision={mode.decision} />
            <code className="font-mono text-2xs break-all">{mode.rule}</code>
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <label className="text-2xs" htmlFor={`${id}-decision`}>
              What should happen
            </label>
            <select
              id={`${id}-decision`}
              value={decision}
              onChange={(e) => setDecision(e.target.value as RuleDecision)}
              className="box-border w-full min-w-0 rounded border border-solid border-border bg-input px-1 text-xs text-foreground"
            >
              {DECISIONS.map((d) => (
                <option key={d} value={d}>
                  {DECISION_WORDS[d]}
                  {d === "deny"
                    ? ": refuse it"
                    : d === "ask"
                      ? ": ask me first"
                      : ": run without asking"}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-2xs" htmlFor={`${id}-rule`}>
              Rule
            </label>
            <input
              id={`${id}-rule`}
              ref={input}
              value={rule}
              onChange={(e) => onRuleText(e.target.value)}
              placeholder={mode.kind === "add" ? mode.example : undefined}
              aria-describedby={`${id}-help`}
              autoComplete="off"
              spellCheck={false}
              className="box-border w-full min-w-0 rounded border border-solid border-border bg-input px-1 font-mono text-xs text-foreground"
            />
            <span id={`${id}-help`} className="text-2xs text-description-muted">
              Write toolName(pattern), or just toolName. * matches any
              characters. You can paste a command from{" "}
              <code>continuous audit suggest</code>.
            </span>
          </div>
        </>
      )}
      <div className="flex flex-col gap-1">
        <label className="text-2xs" htmlFor={`${id}-probe`}>
          Try a call (optional)
        </label>
        <input
          id={`${id}-probe`}
          value={probe}
          onChange={(e) => setProbe(e.target.value)}
          onBlur={() => state.check(probe || undefined)}
          placeholder="A command, path or address to test this rule against"
          autoComplete="off"
          spellCheck={false}
          className="box-border w-full min-w-0 rounded border border-solid border-border bg-input px-1 font-mono text-xs text-foreground"
        />
      </div>
      <div
        aria-live="polite"
        className="flex flex-col gap-1"
        data-testid="rule-preview"
      >
        {state.error && (
          <p
            className="m-0 text-xs text-error"
            role="alert"
            data-testid="rule-error"
          >
            {state.error}
          </p>
        )}
        {preview?.analysis?.warnings
          .filter((w) => w.kind !== "broad")
          .map((w) => (
            <p
              key={w.message}
              className="m-0 text-2xs text-warning"
              data-testid="rule-warning"
            >
              {w.message}
            </p>
          ))}
        {preview?.verdict && <Verdict verdict={preview.verdict} />}
        {preview?.diff && <DiffView diff={preview.diff} />}
        {preview?.analysis?.loosens && <NativeNotice waiting={waiting} />}
      </div>
      {friction === "typed" && (
        <TypedConfirmation
          broadReason={preview?.analysis?.broadReason}
          value={confirm}
          onChange={setConfirm}
        />
      )}
      <WrittenRuleLine
        decision={
          mode.kind === "adopt" || mode.kind === "remove"
            ? mode.decision
            : decision
        }
        rule={
          mode.kind === "adopt" || mode.kind === "remove" ? mode.rule : rule
        }
      />
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          className="min-h-6"
          disabled={!canSave}
          data-testid="rule-save"
        >
          {mode.kind === "adopt"
            ? "Adopt"
            : mode.kind === "remove"
              ? "Remove"
              : "Save to config.yaml"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="min-h-6"
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
