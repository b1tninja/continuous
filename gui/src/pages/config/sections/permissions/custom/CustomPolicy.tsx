import type { AuditOverview } from "core/tools/permissions/audit/auditOverview";
import type { PreviewSample } from "core/tools/permissions/customPolicy";
import type { EffectiveRulesReport } from "core/tools/permissions/effectiveRules";
import {
  BUILTIN_RULES,
  POLICY_AREA_LABELS,
  POLICY_AREAS,
  POLICY_LEVEL_DESCRIPTIONS,
  POLICY_LEVELS,
  POLICY_PRESET_ORDER,
  POLICY_PRESETS,
  policyLevelLabel,
  presetOf,
  QUESTION_TYPE_DESCRIPTIONS,
  QUESTION_TYPES,
  type PolicyArea,
  type PolicyLevel,
  type QuestionType,
} from "core/tools/permissions/policy";
import type { ToolRuleEditResponse } from "core/tools/permissions/ruleEditor";
import { CONFIRM_PHRASE } from "core/tools/permissions/ruleWords";
import { useContext, useEffect, useId, useRef, useState } from "react";
import { Button } from "../../../../../components/ui";
import { IdeMessengerContext } from "../../../../../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../../../../../redux/hooks";
import {
  customPolicyUpdate,
  saveCustomPolicy,
  type CustomPolicySave,
} from "../../../../../redux/thunks/policySettings";
import type { PolicySavePreview } from "core/tools/permissions/policySave";
import type { PolicyFileUpdate } from "core/tools/permissions/settingsFile";
import type { EditorEnv } from "../EditableRules";
import {
  customSetToStore,
  describeRuleChange,
  initialDraft,
  levelsOfBase,
  ruleChanges,
  settingChanges,
  type BaseName,
  type CustomDraft,
} from "./customPolicyState";
import { RuleListsEditor } from "./RuleListsEditor";
import { StringListEditor } from "./StringListEditor";
import { useRecentSamples } from "./useRecentSamples";

const STEPS = [
  "Start from",
  "Levels and settings",
  "Rules",
  "Read-only and trust",
  "Review and save",
] as const;

const MESSAGE = {
  add: "config/addToolRule",
  update: "config/updateToolRule",
  remove: "config/removeToolRule",
} as const;

type Who = "you" | "agent" | "level";

export function isBaseName(value: string | null): value is BaseName {
  return (
    value === "current" ||
    (value !== null && (POLICY_PRESET_ORDER as string[]).includes(value))
  );
}

/**
 * The Custom policy editor: start from a preset or from what is set now,
 * change the levels and the settings beside them, edit the Never, Ask, Always
 * and Always-on lists, then review every change and save. permissions.yaml is
 * written once by core's writer; each config.yaml change goes through the rule
 * editor's own checks, confirmation and audit, one at a time.
 */
export function CustomPolicy({
  base: startBase,
  area,
  report,
  env,
  audit,
  onClose,
}: {
  base: BaseName;
  area?: PolicyArea;
  report: EffectiveRulesReport;
  env: EditorEnv;
  audit?: AuditOverview;
  onClose: (message?: string) => void;
}) {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const current = useAppSelector((s) => s.ui.policyLevels);
  const extras = useAppSelector((s) => s.ui.policyExtras);
  const rules = [
    ...Object.values(report.areas).flatMap((a) => a.rules),
    ...report.unscoped,
  ];
  const [saved] = useState(() =>
    initialDraft("current", current, extras, rules),
  );
  const [draft, setDraft] = useState<CustomDraft>(() =>
    initialDraft(startBase, current, extras, rules),
  );
  const [step, setStep] = useState(area ? 1 : 0);
  const heading = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  const id = useId();
  const recent = useRecentSamples();

  useEffect(() => {
    // Keyboard and screen reader: the new step's heading takes focus
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus();
  }, [step]);

  const set = (patch: Partial<CustomDraft>) =>
    setDraft((d) => ({ ...d, ...patch }));

  // The one permissions.yaml write: previewed in the review step, then saved
  const custom = customSetToStore(draft, current, extras.customSet);
  const save: CustomPolicySave = {
    levels: draft.levels,
    extras: {
      builtin: draft.builtin,
      maxNewPlanItems: draft.maxNewPlanItems,
      questions: {
        youDecide: draft.youDecide,
        agentDecides: draft.agentDecides,
      },
      questionDelivery: draft.questionDelivery,
      floor: draft.lists.floor,
      trustedMcpServers: draft.trustedMcpServers,
      planMcpTools: draft.planMcpTools,
      planAllowTerminal: draft.planAllowTerminal,
    },
    ...(custom ? { custom } : {}),
  };

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="mb-3 rounded-sm border border-solid border-border-focus p-2"
      data-testid="custom-policy"
    >
      <div className="flex items-center justify-between gap-2">
        <h4 id={`${id}-title`} className="my-0 text-sm font-semibold">
          Custom policy
          <span
            className="ml-1 text-2xs font-normal text-description"
            data-testid="custom-policy-base"
          >
            based on{" "}
            {draft.base === "current"
              ? "what is set now"
              : POLICY_PRESETS[draft.base].label}
          </span>
        </h4>
        <Button
          size="sm"
          variant="outline"
          className="min-h-6"
          onClick={() => onClose()}
          data-testid="custom-policy-cancel"
        >
          Cancel
        </Button>
      </div>
      <ol
        className="m-0 my-2 flex flex-wrap gap-1 p-0"
        aria-label="Steps"
        data-testid="custom-policy-steps"
      >
        {STEPS.map((name, i) => (
          <li key={name} className="list-none">
            <button
              type="button"
              aria-current={i === step ? "step" : undefined}
              data-testid={`custom-step-${i}`}
              onClick={() => setStep(i)}
              className={`cursor-pointer rounded-sm border border-solid px-2 py-0.5 text-xs text-foreground ${
                i === step
                  ? "border-border-focus bg-input"
                  : "border-border bg-transparent"
              }`}
            >
              {i + 1}. {name}
            </button>
          </li>
        ))}
      </ol>
      <h5
        ref={heading}
        tabIndex={-1}
        className="my-1 text-xs font-semibold outline-none"
        data-testid="custom-step-heading"
      >
        {STEPS[step]}
      </h5>

      {step === 0 && (
        <BaseStep
          base={draft.base}
          onChange={(b) => set({ base: b, levels: levelsOfBase(b, current) })}
        />
      )}
      {step === 1 && <LevelsStep draft={draft} set={set} focusArea={area} />}
      {step === 2 && (
        <RuleListsEditor
          lists={draft.lists}
          onChange={(lists) => set({ lists })}
          samples={recent.samples}
          samplesNote={recent.note}
          mostAsked={audit?.state === "ready" ? audit.mostAsked : []}
        />
      )}
      {step === 3 && <TrustStep draft={draft} set={set} />}
      {step === 4 && (
        <ReviewStep
          saved={saved}
          draft={draft}
          editable={env.editable}
          decisionOrder={report.decisionOrder}
          update={customPolicyUpdate(save)}
          onSave={async (confirm) => {
            try {
              await dispatch(saveCustomPolicy(save)).unwrap();
            } catch (e) {
              // unwrap() rejects with a serialized error, not an Error
              const why = (e as { message?: string } | undefined)?.message;
              return `Nothing was saved: ${why ?? String(e)}`;
            }
            const changes = ruleChanges(saved, draft);
            let hash = env.baseHash;
            for (let i = 0; i < changes.length; i++) {
              const c = changes[i];
              const res = await ideMessenger.request(MESSAGE[c.op], {
                ...c,
                ...(hash ? { baseHash: hash } : {}),
                ...(confirm ? { confirm } : {}),
                source: "permissions-page",
              });
              const content =
                res.status === "success" ? res.content : undefined;
              if (
                !content ||
                !["added", "updated", "removed"].includes(content.result)
              ) {
                return `permissions.yaml was saved, and ${i} of ${changes.length} rule changes. Stopped at "${describeRuleChange(c)}": ${content?.error ?? "the change could not be saved"}. Nothing after it was written.`;
              }
              hash = content.afterHash ?? hash;
            }
            onClose(
              changes.length
                ? `Custom policy saved: permissions.yaml and ${changes.length} rule change${changes.length === 1 ? "" : "s"} in config.yaml.`
                : "Custom policy saved to permissions.yaml.",
            );
            return undefined;
          }}
        />
      )}

      <div className="mt-2 flex justify-between gap-2">
        <Button
          size="sm"
          variant="outline"
          className="min-h-6"
          disabled={step === 0}
          onClick={() => setStep((s) => Math.max(0, s - 1))}
          data-testid="custom-back"
        >
          Back
        </Button>
        {step < STEPS.length - 1 && (
          <Button
            size="sm"
            className="min-h-6"
            onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}
            data-testid="custom-next"
          >
            Next: {STEPS[step + 1]}
          </Button>
        )}
      </div>
    </section>
  );
}

function BaseStep({
  base,
  onChange,
}: {
  base: BaseName;
  onChange: (base: BaseName) => void;
}) {
  const options: BaseName[] = [...POLICY_PRESET_ORDER, "current"];
  return (
    <fieldset className="m-0 border-none p-0" data-testid="custom-base">
      <legend className="text-2xs text-description">
        The levels start from this. Rules and settings start from what you have
        now.
      </legend>
      {options.map((name) => (
        <label
          key={name}
          className="flex cursor-pointer items-start gap-1 py-0.5 text-xs"
        >
          <input
            type="radio"
            name="custom-base"
            value={name}
            checked={base === name}
            onChange={() => onChange(name)}
            data-testid={`custom-base-${name}`}
          />
          <span>
            {name === "current"
              ? "What is set now"
              : POLICY_PRESETS[name].label}
            <span className="block text-2xs text-description">
              {name === "current"
                ? "Keep the five levels as they are."
                : POLICY_PRESETS[name].description}
            </span>
          </span>
        </label>
      ))}
      {base === "idgaf" && (
        <p
          className="my-1 text-2xs text-warning"
          data-testid="custom-idgaf-note"
        >
          IDGAF is for one session: it is never saved, and the file keeps the
          level it had. At IDGAF every rule is ignored, Always-on Never
          included: the call runs and the audit trail records the rule that
          would have stopped it.
        </p>
      )}
    </fieldset>
  );
}

const selectClass =
  "shrink-0 cursor-pointer rounded border border-solid border-border bg-input px-1 text-xs text-foreground";

function LevelsStep({
  draft,
  set,
  focusArea,
}: {
  draft: CustomDraft;
  set: (patch: Partial<CustomDraft>) => void;
  focusArea?: PolicyArea;
}) {
  const who = (t: QuestionType): Who =>
    draft.youDecide.includes(t)
      ? "you"
      : draft.agentDecides.includes(t)
        ? "agent"
        : "level";
  const setWho = (t: QuestionType, w: Who) =>
    set({
      youDecide: [
        ...draft.youDecide.filter((x) => x !== t),
        ...(w === "you" ? [t] : []),
      ],
      agentDecides: [
        ...draft.agentDecides.filter((x) => x !== t),
        ...(w === "agent" ? [t] : []),
      ],
    });
  const preset = presetOf(draft.levels);
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-2xs text-description" data-testid="custom-matches">
        {preset
          ? `These levels are the ${POLICY_PRESETS[preset].label} preset.`
          : "These levels match no preset: the chip will say Custom."}
      </p>
      {POLICY_AREAS.map((a) => (
        <label
          key={a}
          className="flex items-center justify-between gap-2 text-xs"
        >
          <span>
            {POLICY_AREA_LABELS[a]}
            <span className="block text-2xs text-description">
              {POLICY_LEVEL_DESCRIPTIONS[a][draft.levels[a]]}
            </span>
          </span>
          <select
            className={selectClass}
            value={draft.levels[a]}
            autoFocus={a === focusArea}
            data-testid={`custom-level-${a}`}
            onChange={(e) =>
              set({
                levels: { ...draft.levels, [a]: e.target.value as PolicyLevel },
              })
            }
          >
            {POLICY_LEVELS.map((l) => (
              <option key={l} value={l}>
                {policyLevelLabel(a, l)}
              </option>
            ))}
          </select>
        </label>
      ))}
      <h6 className="my-0 mt-1 text-xs font-semibold">Built-in rules</h6>
      {BUILTIN_RULES.map((r) => (
        <label key={r.id} className="flex items-start gap-1 text-xs">
          <input
            type="checkbox"
            checked={draft.builtin[r.id] !== false}
            data-testid={`custom-builtin-${r.id}`}
            onChange={(e) =>
              set({ builtin: { ...draft.builtin, [r.id]: e.target.checked } })
            }
          />
          <span>
            {r.label}
            <span className="block text-2xs text-description">
              {r.description}
            </span>
          </span>
        </label>
      ))}
      <h6 className="my-0 mt-1 text-xs font-semibold">Plans and questions</h6>
      <label className="flex items-center justify-between gap-2 text-xs">
        <span>
          New to-dos a re-plan may add by itself (Plan edits at Permissive)
        </span>
        <input
          type="number"
          min={0}
          className="w-14 rounded border border-solid border-border bg-input px-1 text-xs text-foreground"
          value={draft.maxNewPlanItems}
          data-testid="custom-max-new-items"
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isInteger(n) && n >= 0) set({ maxNewPlanItems: n });
          }}
        />
      </label>
      <label className="flex items-center justify-between gap-2 text-xs">
        <span>While a question waits</span>
        <select
          className={selectClass}
          value={draft.questionDelivery}
          data-testid="custom-delivery"
          onChange={(e) =>
            set({ questionDelivery: e.target.value as "inbox" | "wait" })
          }
        >
          <option value="inbox">Work goes on (inbox)</option>
          <option value="wait">Work stops</option>
        </select>
      </label>
      {QUESTION_TYPES.map((t) => (
        <label
          key={t}
          className="flex items-center justify-between gap-2 text-xs"
        >
          <span>
            {t}
            <span className="block text-2xs text-description">
              {QUESTION_TYPE_DESCRIPTIONS[t]}
            </span>
          </span>
          <select
            className={selectClass}
            value={who(t)}
            onChange={(e) => setWho(t, e.target.value as Who)}
          >
            <option value="you">You decide</option>
            <option value="agent">Agent may decide</option>
            <option value="level">Questions level decides</option>
          </select>
        </label>
      ))}
    </div>
  );
}

function TrustStep({
  draft,
  set,
}: {
  draft: CustomDraft;
  set: (patch: Partial<CustomDraft>) => void;
}) {
  return (
    <div className="flex flex-col gap-2" data-testid="custom-trust">
      <p className="m-0 text-2xs text-description">
        What counts as read-only is decided by the product, not by a list: a
        tool marked read-only, a terminal command the parser vouches for as
        read-only (it then counts as Context use), and an MCP tool whose server
        says it is read-only, but only for a server you trust below. Plan mode
        runs only read-only tools on its own.
      </p>
      <StringListEditor
        label="MCP servers whose read-only hints you trust"
        hint="By display name. A server that came with the open folder is never trusted this way."
        testId="trusted-servers"
        items={draft.trustedMcpServers}
        onChange={(trustedMcpServers) => set({ trustedMcpServers })}
        placeholder="github"
        validate={(v) =>
          v.trim() ? undefined : "Write the server's display name."
        }
      />
      <StringListEditor
        label="MCP tools Plan mode may use"
        hint='Whatever the server claims: "server/tool", "server/*" or "server".'
        testId="plan-mcp-tools"
        items={draft.planMcpTools}
        onChange={(planMcpTools) => set({ planMcpTools })}
        placeholder="github/get_issue"
        validate={(v) => {
          const parts = v.split("/");
          return v !== v.trim() ||
            !v ||
            parts.length > 2 ||
            parts.some((p) => !p)
            ? "Write server/tool, server/* or server."
            : undefined;
        }}
      />
      <label className="flex items-start gap-1 text-xs">
        <input
          type="checkbox"
          checked={draft.planAllowTerminal}
          data-testid="custom-plan-terminal"
          onChange={(e) => set({ planAllowTerminal: e.target.checked })}
        />
        <span>
          Offer the terminal in Plan mode (terminal agent)
          <span className="block text-2xs text-description">
            It still asks before each command.
          </span>
        </span>
      </label>
    </div>
  );
}

interface DryRun {
  label: string;
  res?: ToolRuleEditResponse;
}

function ReviewStep({
  saved,
  draft,
  editable,
  decisionOrder,
  update,
  onSave,
}: {
  saved: CustomDraft;
  draft: CustomDraft;
  editable: boolean;
  /** The engine's order, in words (effectiveRules.ts) */
  decisionOrder: string;
  /** The permissions.yaml update the save sends, for the host's dry run */
  update: PolicyFileUpdate;
  /** Returns the error sentence, or undefined when everything was saved */
  onSave: (confirm: string | undefined) => Promise<string | undefined>;
}) {
  const ideMessenger = useContext(IdeMessengerContext);
  const settings = settingChanges(saved, draft);
  const changes = ruleChanges(saved, draft);
  const [checks, setChecks] = useState<DryRun[] | undefined>();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [preview, setPreview] = useState<PolicySavePreview | "failed">();
  const key = JSON.stringify(changes);
  const updateKey = JSON.stringify(update);

  // The exact permissions.yaml the save would write, from the host's writer
  useEffect(() => {
    let live = true;
    setPreview(undefined);
    void ideMessenger
      .request("policy/preview", update)
      .then((res) => {
        if (live) setPreview(res.status === "success" ? res.content : "failed");
      })
      .catch(() => live && setPreview("failed"));
    return () => {
      live = false;
    };
  }, [updateKey]);

  useEffect(() => {
    let live = true;
    void Promise.all(
      changes.map(async (c) => {
        const res = await ideMessenger.request(MESSAGE[c.op], {
          ...c,
          dryRun: true,
          source: "permissions-page",
        });
        return {
          label: describeRuleChange(c),
          res: res.status === "success" ? res.content : undefined,
        };
      }),
    ).then((r) => live && setChecks(r));
    return () => {
      live = false;
    };
  }, [key]);

  const blocked = (checks ?? []).filter(
    (c) => !c.res || !["preview", "needs-confirmation"].includes(c.res.result),
  );
  const needsTyped = (checks ?? []).some(
    (c) => c.res?.analysis?.friction === "typed",
  );
  const ruleLoosens = (checks ?? []).some(
    (c) => c.res?.analysis?.friction === "confirm",
  );
  const nothing = settings.length === 0 && changes.length === 0;
  const problem =
    preview === "failed"
      ? "Could not check permissions.yaml, so nothing can be saved now."
      : preview?.problem
        ? `permissions.yaml cannot be saved: ${preview.problem}`
        : undefined;
  // No page checkbox: what loosens is confirmed in the editor's own dialog,
  // which the page cannot click
  const ready =
    editable &&
    !nothing &&
    checks !== undefined &&
    preview !== undefined &&
    !problem &&
    blocked.length === 0 &&
    (!needsTyped || typed.trim().toLowerCase() === CONFIRM_PHRASE);
  const nativeAsks = preview && preview !== "failed" ? preview.loosens : [];

  return (
    <div className="flex flex-col gap-2" data-testid="custom-review">
      {nothing && (
        <p className="m-0 text-xs" data-testid="custom-nothing">
          Nothing has changed yet.
        </p>
      )}
      {settings.length > 0 && (
        <section aria-label="permissions.yaml changes">
          <h6 className="my-0 text-xs font-semibold">permissions.yaml</h6>
          <ul className="m-0 pl-4 text-xs" data-testid="custom-setting-changes">
            {settings.map((s) => (
              <li key={s.key}>
                <code>{s.key}</code>: {s.before} → <strong>{s.after}</strong>
                {s.loosens && (
                  <span className="ml-1 text-warning">(loosens)</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {!nothing && <PolicyDiff preview={preview} problem={problem} />}
      {changes.length > 0 && (
        <section aria-label="config.yaml rule changes">
          <h6 className="my-0 text-xs font-semibold">
            Your rules in config.yaml
          </h6>
          <ul className="m-0 pl-4 text-xs" data-testid="custom-rule-changes">
            {(
              checks ?? changes.map((c) => ({ label: describeRuleChange(c) }))
            ).map((c: DryRun) => (
              <li key={c.label}>
                {c.label}
                {c.res?.analysis?.warnings.map((w) => (
                  <span key={w.message} className="block text-2xs text-warning">
                    {w.message}
                  </span>
                ))}
                {c.res &&
                  !["preview", "needs-confirmation"].includes(c.res.result) && (
                    <span className="block text-2xs text-error" role="alert">
                      {c.res.error ?? "This change cannot be saved."}
                    </span>
                  )}
                {checks && !c.res && (
                  <span className="block text-2xs text-error" role="alert">
                    Could not check this change.
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-label="How this is decided" data-testid="custom-precedence">
        <h6 className="my-0 text-xs font-semibold">How a call is decided</h6>
        <p className="my-0 text-2xs text-description">{decisionOrder}</p>
        <ul className="m-0 pl-4 text-2xs text-description">
          <li>
            A file that came with the workspace may only add Never and Ask
            rules. Always rules and these settings come from your own files
            only.
          </li>
          <li data-testid="custom-unattended">
            Ask means Deny when nobody can answer: a headless run refuses the
            call; a loop holds it in the inbox.
          </li>
          <li>
            Terminal commands, scripts and MCP servers are not contained: no
            sandbox is active. A rule about a command is best-effort.
          </li>
        </ul>
      </section>
      {nativeAsks.length > 0 && (
        <div
          className="m-0 text-2xs text-description"
          data-testid="custom-native-settings"
        >
          When you save, your editor will ask you to confirm these in its own
          dialog, which the page cannot answer. No means nothing is saved.
          <ul className="m-0 pl-4" data-testid="custom-native-list">
            {nativeAsks.map((l) => (
              <li key={`${l.key}:${l.text}`}>{l.text}</li>
            ))}
          </ul>
        </div>
      )}
      {(checks ?? []).some((c) => c.res?.analysis?.loosens) && (
        <p
          className="m-0 text-2xs text-description"
          data-testid="custom-native"
        >
          Your editor will ask you to confirm each rule change that loosens, in
          its own dialog, as it is saved.
        </p>
      )}
      {needsTyped && (
        <label className="flex flex-col gap-1 text-xs">
          <span>
            A rule here allows more than you may mean. Type{" "}
            <code>{CONFIRM_PHRASE}</code> to confirm.
          </span>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            data-testid="custom-typed-confirm"
            className="rounded border border-solid border-border bg-input px-1 text-xs text-foreground"
          />
        </label>
      )}
      {!editable && (
        <p className="m-0 text-xs text-error">
          Your config.yaml cannot be written now, so nothing can be saved.
        </p>
      )}
      <div role="status" aria-live="polite" data-testid="custom-save-error">
        {error && <p className="my-1 text-xs text-error">{error}</p>}
      </div>
      <Button
        size="sm"
        className="min-h-6 self-start"
        disabled={!ready || busy}
        data-testid="custom-save"
        onClick={async () => {
          setBusy(true);
          const why = await onSave(
            needsTyped ? CONFIRM_PHRASE : ruleLoosens ? "yes" : undefined,
          );
          setBusy(false);
          setError(why);
        }}
      >
        Save
      </Button>
    </div>
  );
}

/** Unchanged lines kept around each change; longer runs are folded. */
const CONTEXT_LINES = 2;

/**
 * The exact permissions.yaml diff the save would write: the host's writer,
 * dry-run. Unchanged runs are folded, keeping two lines of context.
 */
function PolicyDiff({
  preview,
  problem,
}: {
  preview: PolicySavePreview | "failed" | undefined;
  problem: string | undefined;
}) {
  if (problem) {
    return (
      <p
        className="m-0 text-xs text-error"
        role="alert"
        data-testid="custom-yaml-problem"
      >
        {problem}
      </p>
    );
  }
  if (!preview || preview === "failed") {
    return (
      <p
        className="m-0 text-2xs text-description"
        data-testid="custom-yaml-loading"
      >
        Checking permissions.yaml…
      </p>
    );
  }
  if (!preview.changed) {
    return (
      <p
        className="m-0 text-2xs text-description"
        data-testid="custom-yaml-same"
      >
        permissions.yaml stays as it is.
      </p>
    );
  }
  const rows: { text: string; kind: "same" | "old" | "new" | "fold" }[] = [];
  const lines = preview.diff;
  const near = (i: number) =>
    lines
      .slice(Math.max(0, i - CONTEXT_LINES), i + CONTEXT_LINES + 1)
      .some((d) => d.type !== "same");
  for (let i = 0; i < lines.length; i++) {
    const d = lines[i];
    if (d.type !== "same" || near(i)) {
      const sign = d.type === "old" ? "-" : d.type === "new" ? "+" : " ";
      rows.push({ kind: d.type, text: `${sign} ${d.line}` });
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j].type === "same" && !near(j)) j++;
    if (j - i === 1) {
      rows.push({ kind: "same", text: `  ${d.line}` });
      continue;
    }
    rows.push({
      kind: "fold",
      text: `  … ${j - i} unchanged lines`,
    });
    i = j - 1;
  }
  return (
    <section aria-label="permissions.yaml as it will be written">
      <h6 className="my-0 text-xs font-semibold">
        permissions.yaml, exactly as it will be written
      </h6>
      <pre
        className="m-0 overflow-x-auto rounded-sm border border-solid border-border p-1 text-2xs"
        data-testid="custom-yaml-diff"
      >
        {rows.map((r, i) => (
          <div
            key={i}
            data-diff={r.kind}
            className={
              r.kind === "old"
                ? "text-error"
                : r.kind === "new"
                  ? "text-success"
                  : "text-description"
            }
          >
            {r.kind === "old" && <span className="sr-only">Removed: </span>}
            {r.kind === "new" && <span className="sr-only">Added: </span>}
            {r.text}
          </div>
        ))}
      </pre>
    </section>
  );
}
