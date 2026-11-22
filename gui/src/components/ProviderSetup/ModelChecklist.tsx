import { MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { useMemo, useState } from "react";
import { ContextLengthControl } from "../ModelConfig/ContextLengthControl";
import { FACT_HEADINGS, FactsTarget, modelFacts } from "./modelFacts";
import {
  ChecklistGroups,
  ChecklistRow,
  filterRows,
} from "./providerSetupUtils";

interface ModelChecklistProps {
  groups: ChecklistGroups;
  checked: Set<string>;
  onToggle: (model: string) => void;
  /** The lists come from the provider's live model list. */
  isLive?: boolean;
  /** Typed context-length overrides, keyed by model id. Empty means the published window. */
  windows?: Record<string, string>;
  onWindow?: (model: string, value: string) => void;
  /**
   * Whose models these are. With it each row says the model's context
   * window, price and tool support, or in words that it is not known.
   */
  factsFor?: FactsTarget;
}

// One grid for the header and every row, so the columns line up. Under 30rem
// of list width there are no columns: the three facts go under the name.
const COLUMNS =
  "@[30rem]:grid @[30rem]:grid-cols-[minmax(0,1fr)_5.5rem_8.5rem_4rem] @[30rem]:gap-x-2";

const USE_CASE_ROW_TITLE =
  "Won't work until the Anthropic use-case form is completed in the Bedrock console. You can still select it.";
const ACCESS_ROW_TITLE =
  "This account cannot use the model yet: request access under Model access in the Bedrock console. You can still select it.";

function Row({
  row,
  checked,
  onToggle,
  factsFor,
}: {
  row: ChecklistRow;
  checked: boolean;
  onToggle: () => void;
  factsFor?: FactsTarget;
}) {
  const facts = factsFor ? modelFacts(factsFor, row.pkg, row.model) : undefined;
  // A listing that has no description repeats the id: once is enough
  const description =
    row.description === row.title ? undefined : row.description;
  return (
    <label
      className="box-border flex w-full min-w-0 cursor-pointer items-start gap-2 rounded-sm px-1 py-1 text-xs hover:bg-input"
      data-testid={`model-row-${row.model}`}
    >
      <input
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        onChange={onToggle}
        aria-label={row.title}
        aria-description={
          row.needsAnthropicUseCase
            ? USE_CASE_ROW_TITLE
            : row.accessNote
              ? ACCESS_ROW_TITLE
              : undefined
        }
      />
      <span className={`min-w-0 flex-1 ${facts ? COLUMNS : ""}`}>
        <span className="flex min-w-0 flex-col">
          <span
            // Two whole strings: the class sorter removes a leading space inside
            // a template expression, which joined the two names into one.
            // A long id wraps, so all of it can be read in a narrow panel.
            className={
              row.accessNote
                ? "[overflow-wrap:anywhere] text-description-muted"
                : "[overflow-wrap:anywhere]"
            }
          >
            {row.title}
            {row.configured && (
              <span className="ml-1.5 text-description-muted">(in config)</span>
            )}
            {row.deprecated && (
              <span className="ml-1.5 text-description-muted">(legacy)</span>
            )}
          </span>
          {(description || row.needsAnthropicUseCase || row.accessNote) && (
            <span className="truncate text-description-muted">
              {/* First on the line, so truncation can't hide it */}
              {row.accessNote && (
                <span
                  className="text-warning"
                  title={ACCESS_ROW_TITLE}
                  data-testid={`model-row-access-${row.model}`}
                >
                  {row.accessNote}
                  {row.needsAnthropicUseCase || description ? " · " : ""}
                </span>
              )}
              {row.needsAnthropicUseCase && (
                <span
                  className="text-warning"
                  title={USE_CASE_ROW_TITLE}
                  data-testid={`model-row-needs-use-case-${row.model}`}
                >
                  Needs use-case form
                  {description ? " · " : ""}
                </span>
              )}
              {description}
            </span>
          )}
        </span>
        {facts && (
          <>
            {/* Narrow: one wrapping line under the name. Wide: three cells. */}
            <span
              className="break-words text-description-muted @[30rem]:hidden"
              data-testid={`model-row-facts-${row.model}`}
            >
              Context: {facts.context} · Price: {facts.price} · Tools:{" "}
              {facts.tools}
            </span>
            <span
              className="hidden text-description-muted @[30rem]:block"
              data-testid={`model-window-${row.model}`}
            >
              <span className="sr-only">{FACT_HEADINGS.context}: </span>
              {facts.contextCell}
            </span>
            <span
              className="hidden break-words text-description-muted @[30rem]:block"
              data-testid={`model-row-price-${row.model}`}
            >
              <span className="sr-only">{FACT_HEADINGS.price}: </span>
              {facts.priceCell}
            </span>
            <span
              className="hidden text-description-muted @[30rem]:block"
              data-testid={`model-row-tools-${row.model}`}
            >
              <span className="sr-only">{FACT_HEADINGS.tools}: </span>
              {facts.tools}
            </span>
          </>
        )}
      </span>
    </label>
  );
}

/**
 * Checkboxes for the models of one provider, with a search box. Checked models
 * are the ones that end up in config.yaml.
 */
export function ModelChecklist({
  groups,
  checked,
  onToggle,
  isLive,
  windows,
  onWindow,
  factsFor,
}: ModelChecklistProps) {
  const [query, setQuery] = useState("");

  const visible = useMemo(
    () => ({
      configuredOnly: filterRows(groups.configuredOnly, query),
      top: filterRows(groups.top, query),
      other: filterRows(groups.other, query),
    }),
    [groups, query],
  );
  const empty =
    visible.configuredOnly.length +
      visible.top.length +
      visible.other.length ===
    0;

  const section = (label: string, rows: ChecklistRow[]) =>
    rows.length > 0 && (
      <div className="flex flex-col gap-0.5" key={label}>
        <div className="px-1 text-xs font-medium text-description-muted">
          {label}
        </div>
        {rows.map((row) => {
          const published = row.pkg?.params.contextLength;
          const showWindow = checked.has(row.model) && onWindow !== undefined;
          return (
            <div key={row.model} className="flex flex-col">
              <Row
                row={row}
                checked={checked.has(row.model)}
                onToggle={() => onToggle(row.model)}
                factsFor={factsFor}
              />
              {showWindow && (
                <div className="py-1 pr-1 pl-6">
                  <ContextLengthControl
                    value={windows?.[row.model] ?? ""}
                    onChange={(value) => onWindow(row.model, value)}
                    published={
                      typeof published === "number" ? published : undefined
                    }
                    source={
                      typeof published === "number" ? "published" : "unknown"
                    }
                    inputId={`context-length-${row.model}`}
                    testId={`context-length-slider-${row.model}`}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    );

  return (
    <div
      className="@container flex min-w-0 flex-col gap-2"
      data-testid="model-checklist"
    >
      <div className="flex items-center rounded-sm border border-solid border-border bg-background pl-2 focus-within:border-border-focus">
        <MagnifyingGlassIcon className="h-4 w-4 text-description-muted" />
        <input
          type="text"
          aria-label="Search models"
          placeholder="Search models..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full border-none bg-transparent px-2 py-1.5 text-xs text-foreground outline-hidden"
        />
      </div>
      {factsFor && (
        <div
          className="hidden px-1 text-xs font-medium text-description-muted @[30rem]:flex @[30rem]:gap-2"
          data-testid="model-columns"
          aria-hidden="true"
        >
          {/* As wide as a row's checkbox, so the header sits over the cells */}
          <span className="w-[13px] shrink-0" />
          <span className={`min-w-0 flex-1 ${COLUMNS}`}>
            <span>Model</span>
            <span>{FACT_HEADINGS.context}</span>
            <span>{FACT_HEADINGS.price}</span>
            <span>{FACT_HEADINGS.tools}</span>
          </span>
        </div>
      )}
      <div className="flex max-h-72 flex-col gap-3 overflow-y-auto">
        {section(
          "Configured, not offered by the provider",
          visible.configuredOnly,
        )}
        {section(isLive ? "Latest available" : "Popular", visible.top)}
        {section(
          isLive ? "Other available models" : "Additional models",
          visible.other,
        )}
        {empty && (
          <div className="px-1 text-xs text-description-muted">
            No model matches "{query}".
          </div>
        )}
      </div>
      <div className="text-xs text-description-muted">
        {checked.size} model{checked.size === 1 ? "" : "s"} selected
      </div>
    </div>
  );
}
