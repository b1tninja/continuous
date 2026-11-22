import type {
  ModelLayer,
  ResolvedValue,
} from "core/config/modelEdit/valueState";

// 24 px high and wide at least: a pointer target, though it reads as a link
const linkClass =
  "inline-flex min-h-6 min-w-6 cursor-pointer items-center border-none bg-transparent p-0 text-2xs whitespace-nowrap text-link underline";

/** What "Go" is called for the layer a value is inherited from. */
export const GO_LABEL: Record<ModelLayer, string> = {
  entry: "Go to file",
  account: "Go to account",
  catalog: "Go to catalog",
  variant: "Go to catalog",
};

interface Props {
  /** The setting's state, from `resolvedValue` in core. */
  state: ResolvedValue;
  /** The setting's name: the narrow form shows it, and the buttons are named with it. */
  label: string;
  /** "wide": a line under a control. "narrow": one line with the name. */
  form?: "wide" | "narrow";
  /** Removes the key. Shown only when the person set the value. */
  onReset?: () => void;
  /** Opens the layer an inherited value comes from, when there is a way to. */
  onGo?: () => void;
  /** Goes to the control that sets the value. Offered when nothing else is. */
  onSet?: () => void;
  /** For the control's `aria-describedby`. */
  id?: string;
  testId?: string;
}

/**
 * The one action a setting offers: Reset for a value the person set, Go for
 * an inherited one with a place to open, else Set.
 */
export function ValueAction({
  state,
  label,
  onReset,
  onGo,
  onSet,
}: Pick<Props, "state" | "label" | "onReset" | "onGo" | "onSet">) {
  if (state.setByUser && onReset) {
    return (
      <button
        type="button"
        className={linkClass}
        aria-label={`Reset ${label}`}
        onClick={onReset}
      >
        Reset
      </button>
    );
  }
  if (!state.setByUser && state.whereSet && onGo) {
    const text = GO_LABEL[state.whereSet.layer];
    return (
      <button
        type="button"
        className={linkClass}
        aria-label={`${text} for ${label}`}
        onClick={onGo}
      >
        {text}
      </button>
    );
  }
  if (onSet) {
    return (
      <button
        type="button"
        className={linkClass}
        aria-label={`Set ${label}`}
        onClick={onSet}
      >
        Set
      </button>
    );
  }
  return null;
}

/**
 * One setting's state, in one of two forms: "Set by you: X" with Reset, or
 * "Not set: ..." with what happens then. An inherited value names where it
 * comes from and offers to go there.
 *
 * Wide is a line under the control. Narrow is one line: the name, the value
 * (or what happens with none), the state, and the action.
 */
export function ValueState({
  state,
  label,
  form = "wide",
  onReset,
  onGo,
  onSet,
  id,
  testId,
}: Props) {
  const actions = (
    <ValueAction
      state={state}
      label={label}
      onReset={onReset}
      onGo={onGo}
      onSet={onSet}
    />
  );

  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-2 text-2xs"
      data-testid={testId}
      data-set-by-user={state.setByUser}
    >
      {form === "narrow" ? (
        <>
          <span className="font-medium">{label}</span>
          <span id={id} className="min-w-0 break-words">
            {state.valueText ?? state.detail}
          </span>
          <span className="text-description-muted">{state.source}</span>
        </>
      ) : (
        <span id={id} className="min-w-0 break-words text-description-muted">
          {state.sentence}
        </span>
      )}
      {actions}
    </div>
  );
}
