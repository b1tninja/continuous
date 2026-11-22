import type { SetupSelectRole } from "core/config/providerSetup";
import { USE_FOR, useForLine } from "./providerSetupUtils";

interface UseForStepProps {
  /** The models being added, in list order; the first is the one put to use. */
  models: { model: string; title: string }[];
  useFor: ReadonlySet<SetupSelectRole>;
  onToggle: (role: SetupSelectRole) => void;
  /** The model each role uses today, by role; absent when none is chosen. */
  current: Partial<Record<SetupSelectRole, string>>;
  /**
   * Set when Autocomplete is left unticked on purpose: the name of a model
   * the catalogue does not list as a completion model.
   */
  notCompletionModel?: string;
}

/**
 * The step where roles are chosen, once, in words: what the new model is used
 * for, with what each role uses now so the person sees what changes.
 */
export function UseForStep({
  models,
  useFor,
  onToggle,
  current,
  notCompletionModel,
}: UseForStepProps) {
  const first = models[0]?.title ?? "";
  return (
    <div className="flex min-w-0 flex-col gap-3 text-xs" data-testid="use-for">
      <div>
        <div className="text-sm font-medium">Use {first} for</div>
        {models.length > 1 && (
          <div className="mt-1 break-words text-description-muted">
            All {models.length} models you ticked can do these. {first}, the
            first in the list, is the one put to use; switch between them in the
            model menu.
          </div>
        )}
      </div>
      <div className="flex flex-col gap-2">
        {USE_FOR.map(({ role, label, what }) => {
          const ticked = useFor.has(role);
          return (
            <label
              key={role}
              className="flex min-w-0 cursor-pointer items-start gap-2"
              data-testid={`use-for-${role}`}
            >
              <input
                type="checkbox"
                className="mt-0.5"
                checked={ticked}
                onChange={() => onToggle(role)}
                aria-label={label}
              />
              <span className="flex min-w-0 flex-col">
                <span>
                  <span className="font-medium">{label}</span>
                  <span className="text-description-muted">: {what}</span>
                </span>
                <span
                  className="break-words text-description-muted"
                  data-testid={`use-for-line-${role}`}
                >
                  {label}: {useForLine(ticked, current[role], first)}
                </span>
                {role === "autocomplete" && notCompletionModel && (
                  <span
                    className="break-words text-description-muted"
                    data-testid="use-for-autocomplete-note"
                  >
                    Not ticked: the model catalogue does not list{" "}
                    {notCompletionModel} as a completion model. A chat model
                    completes slowly and badly. Tick it if you know this model
                    was trained to complete code.
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </div>
      {useFor.size === 0 && (
        <div className="break-words text-warning" data-testid="use-for-none">
          Nothing is ticked: the model is saved but not used for anything until
          you give it a role in Settings, Models.
        </div>
      )}
    </div>
  );
}
