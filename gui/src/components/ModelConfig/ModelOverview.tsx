import {
  DEFAULT_REASONING_BUDGET,
  pathKey,
  type ModelEditField,
} from "core/config/modelEdit/modelEditFields";
import {
  priceSummary,
  type ResolvedValue,
} from "core/config/modelEdit/valueState";
import { budgetTokensToEffort } from "core/llm/llms/anthropicThinking";
import { useId, useState } from "react";
import { Button } from "../ui";
import { ValueAction, ValueState } from "./ValueState";

/** What the Overview needs from the dialog, so it holds no state of the form. */
export interface OverviewSource {
  /** The state of a field of `MODEL_EDIT_FIELDS`, by its path key. */
  stateOf: (key: string) => ResolvedValue;
  tools: ResolvedValue;
  images: ResolvedValue;
  /** Go to the control that sets this key. */
  onSet: (key: string) => void;
  /** Remove the key. */
  onReset: (key: string) => void;
  /** Whether this dialog can change the key at all. Every key, when absent. */
  editable?: (key: string) => boolean;
  /** Open the layer an inherited value comes from; undefined when there is no way to. */
  goFor: (state: ResolvedValue) => (() => void) | undefined;
}

interface Row {
  key: string;
  label: string;
  /** The value in use, or what happens with none. */
  value: string;
  state: ResolvedValue;
  /** Keys this row's Reset removes, when not just its own. */
  resets?: string[];
  /** Whether Reset is offered at all (capabilities are one list of two). */
  noReset?: boolean;
}

/** The keys the Overview shows first: what costs money, limits a reply, or says what the model can do. */
export const OVERVIEW_KEYS = [
  "contextLength",
  "defaultCompletionOptions.maxTokens",
  "defaultCompletionOptions.reasoning",
  "defaultCompletionOptions.reasoningBudgetTokens",
  "defaultCompletionOptions.temperature",
  "defaultCompletionOptions.promptCaching",
  "pricing.input",
  "pricing.output",
  "roles",
  "requestOptions.timeout",
] as const;

const shown = (state: ResolvedValue) => state.valueText ?? state.detail;

/** "set by you, config.yaml", "account work", "published", "not set". */
function sourceText(state: ResolvedValue): string {
  return state.setByUser && state.sourceDetail
    ? `${state.source}, ${state.sourceDetail}`
    : state.source;
}

function defaultRows(source: OverviewSource): Row[] {
  const of = source.stateOf;
  const window = of("contextLength");
  const maxTokens = of("defaultCompletionOptions.maxTokens");
  const reasoning = of("defaultCompletionOptions.reasoning");
  const budget = of("defaultCompletionOptions.reasoningBudgetTokens");
  const caching = of("defaultCompletionOptions.promptCaching");
  const lifetime = of("cacheBehavior.ttl");
  const input = of("pricing.input");
  const output = of("pricing.output");
  const timeout = of("requestOptions.timeout");
  const price = priceSummary(input, output);
  const tokens = (s: ResolvedValue) =>
    typeof s.value === "number" ? `${s.valueText} tokens` : shown(s);

  // A level is what the requests send for a budget (reasoningEffort.ts)
  const effort =
    reasoning.value === true
      ? `on, ${budgetTokensToEffort(
          typeof budget.value === "number"
            ? budget.value
            : DEFAULT_REASONING_BUDGET,
        )} effort`
      : reasoning.value === false
        ? "off"
        : shown(reasoning);

  const cachingValue =
    caching.value === true
      ? `on, ${typeof lifetime.value === "string" ? `${lifetime.value} lifetime` : "5 minute lifetime"}`
      : caching.value === false
        ? "off"
        : shown(caching);

  return [
    {
      key: "contextLength",
      label: "Context length",
      value: tokens(window),
      state: window,
    },
    {
      key: "defaultCompletionOptions.maxTokens",
      label: "Max output",
      // With nothing set the number alone is not the whole rule: say it
      value:
        maxTokens.sourceKind === "notSet"
          ? maxTokens.detail
          : tokens(maxTokens),
      state: maxTokens,
    },
    {
      key: "defaultCompletionOptions.reasoning",
      label: "Reasoning effort",
      value: effort,
      state: reasoning,
    },
    {
      key: "defaultCompletionOptions.reasoningBudgetTokens",
      label: "Reasoning budget",
      value: tokens(budget),
      state: budget,
    },
    {
      key: "defaultCompletionOptions.temperature",
      label: "Temperature",
      value: shown(of("defaultCompletionOptions.temperature")),
      state: of("defaultCompletionOptions.temperature"),
    },
    {
      key: "defaultCompletionOptions.promptCaching",
      label: "Prompt caching",
      value: cachingValue,
      state: caching,
    },
    {
      key: "pricing.input",
      label: "Price in / out per million",
      value: price.text,
      // One row for two keys: it is the person's when either is
      state: output.setByUser && !input.setByUser ? output : input,
      resets: ["pricing.input", "pricing.output"],
    },
    {
      key: "capabilities.tools",
      label: "Tools",
      value: shown(source.tools),
      state: source.tools,
      noReset: true,
    },
    {
      key: "capabilities.images",
      label: "Images",
      value: shown(source.images),
      state: source.images,
      noReset: true,
    },
    {
      key: "roles",
      label: "Used for",
      value: shown(of("roles")),
      state: of("roles"),
    },
    {
      key: "requestOptions.timeout",
      label: "Request timeout",
      value:
        typeof timeout.value === "number"
          ? `${timeout.valueText} s`
          : shown(timeout),
      state: timeout,
    },
  ];
}

const ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 border-0 border-b border-solid border-border py-1 @md:grid-cols-[minmax(0,1.1fr)_minmax(0,1.5fr)_minmax(0,1.1fr)_5.5rem]";

/**
 * The first tab of "Configure": what this model will actually do. One row
 * per setting that costs money, limits a reply or says what the model can
 * do, each with the value in use, where it comes from and one action; then
 * every other setting, folded. A stacked list when narrow, four columns when
 * there is room.
 */
export function ModelOverview({
  source,
  rest,
  assumedWindow,
  children,
}: {
  source: OverviewSource;
  /** The remaining fields, listed under the fold. */
  rest: ModelEditField[];
  /** Shown under the window's row when its size is only assumed. */
  assumedWindow?: React.ReactNode;
  /** The connection test. */
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const restId = useId();
  const rows = defaultRows(source);
  const restStates = rest.map((field) => ({
    field,
    key: pathKey(field.path),
    state: source.stateOf(pathKey(field.path)),
  }));
  const setCount = restStates.filter((r) => r.state.setByUser).length;

  return (
    <div
      className="@container flex flex-col gap-3"
      data-testid="model-overview"
    >
      <div
        role="table"
        aria-label="What this model will do"
        className="text-xs"
      >
        <div
          role="row"
          className="hidden gap-x-3 border-0 border-b border-solid border-border py-1 text-2xs text-description-muted @md:grid @md:grid-cols-[minmax(0,1.1fr)_minmax(0,1.5fr)_minmax(0,1.1fr)_5.5rem]"
        >
          <span role="columnheader">Setting</span>
          <span role="columnheader">Value in use</span>
          <span role="columnheader">Source</span>
          <span role="columnheader">Action</span>
        </div>
        {rows.map((row) => {
          const { state } = row;
          const editable = source.editable?.(row.key) ?? true;
          const reset =
            editable && !row.noReset
              ? () => (row.resets ?? [row.key]).forEach(source.onReset)
              : undefined;
          return (
            <div
              key={row.key}
              role="row"
              className={ROW_GRID}
              data-testid={`overview-row-${row.key}`}
              data-source={state.sourceKind}
            >
              <span
                role="rowheader"
                className="col-span-2 font-medium @md:col-span-1"
              >
                {row.label}
              </span>
              <span className="flex min-w-0 flex-wrap gap-x-2 pl-3 @md:contents">
                <span role="cell" className="min-w-0 break-words">
                  {row.value}
                </span>
                <span
                  role="cell"
                  className="min-w-0 break-words text-description-muted"
                >
                  {sourceText(state)}
                </span>
              </span>
              <span
                role="cell"
                className="justify-self-end @md:justify-self-start"
              >
                <ValueAction
                  state={state}
                  label={row.label}
                  onReset={reset}
                  onGo={source.goFor(state)}
                  onSet={editable ? () => source.onSet(row.key) : undefined}
                />
              </span>
              {row.key === "contextLength" &&
                state.sourceKind === "assumed" &&
                assumedWindow && (
                  <div role="cell" className="col-span-full pl-3 @md:pl-0">
                    {assumedWindow}
                  </div>
                )}
            </div>
          );
        })}
      </div>

      {children}

      {restStates.length > 0 && (
        <div className="flex flex-col gap-1">
          <div>
            <Button
              variant="ghost"
              size="sm"
              className="text-left"
              aria-expanded={open}
              aria-controls={restId}
              data-testid="overview-rest-toggle"
              onClick={() => setOpen((o) => !o)}
            >
              {open ? "Hide" : "Show"} everything else ({restStates.length}{" "}
              {restStates.length === 1 ? "setting" : "settings"},{" "}
              {setCount === 0 ? "none" : setCount} set by you)
            </Button>
          </div>
          {open && (
            <ul
              id={restId}
              className="m-0 flex list-none flex-col gap-1 p-0"
              data-testid="overview-rest"
            >
              {restStates.map(({ field, key, state }) => (
                <li key={key}>
                  <ValueState
                    form="narrow"
                    state={state}
                    label={field.label}
                    testId={`overview-rest-${key}`}
                    onReset={
                      (source.editable?.(key) ?? true)
                        ? () => source.onReset(key)
                        : undefined
                    }
                    onGo={source.goFor(state)}
                    onSet={
                      (source.editable?.(key) ?? true)
                        ? () => source.onSet(key)
                        : undefined
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The fields under the fold: every visible field the first rows do not
 * cover. The provider and the model id are which model this is, not a
 * setting of it, so they are not counted here.
 */
export function restFields(visible: ModelEditField[]): ModelEditField[] {
  const skip = new Set<string>([...OVERVIEW_KEYS, "provider", "model"]);
  return visible.filter((f) => !skip.has(pathKey(f.path)));
}
