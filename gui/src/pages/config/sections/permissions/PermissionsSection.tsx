import type { AuditOverview } from "core/tools/permissions/audit/auditOverview";
import type {
  AreaReport,
  EffectiveRulesReport,
} from "core/tools/permissions/effectiveRules";
import {
  areaOfTool,
  DEFAULT_MAX_NEW_PLAN_ITEMS,
  POLICY_AREA_LABELS,
  POLICY_AREAS,
  QUESTION_TYPE_DESCRIPTIONS,
  type PolicyArea,
} from "core/tools/permissions/policy";
import type { ToolCallTestResult } from "core/tools/permissions/testToolCall";
import { useContext, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import Alert from "../../../../components/gui/Alert";
import { Button } from "../../../../components/ui";
import { IdeMessengerContext } from "../../../../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../../../../redux/hooks";
import { updateConfig } from "../../../../redux/slices/configSlice";
import { modifyAnyConfigWithSharedConfig } from "core/config/sharedConfig";
import { ConfigHeader } from "../../components/ConfigHeader";
import { AuditOverviewPanel, type ReviewRequest } from "./AuditOverviewPanel";
import { CustomPolicy, isBaseName } from "./custom/CustomPolicy";
import { EditableRules, type EditorEnv } from "./EditableRules";
import { AuditInbox } from "./audit/AuditInbox";
import { AuditList } from "./audit/AuditList";
import {
  isPermissionsView,
  ViewSwitch,
  type PermissionsView,
} from "./audit/ViewSwitch";
import { FirstRunOverview } from "./FirstRunOverview";
import { LocksSection } from "./Locks";
import { PermissionsError, PermissionsSkeleton } from "./PermissionsStates";
import { BuiltinList, RuleList } from "./RuleList";
import { RuleTester } from "./RuleTester";
import { auditKeyOf, useAuditOverview } from "./useAuditOverview";
import { usePermissionsReport } from "./usePermissionsReport";

function PlanSettings({ area }: { area: AreaReport }) {
  const s = area.settings;
  if (s?.kind !== "plan") return null;
  return (
    <section aria-label="Plan settings" data-testid="plan-settings">
      <h5 className="my-1 text-xs font-semibold">What Plan edits has</h5>
      <p className="my-1 text-2xs text-description-muted">
        Plan edits is a level, not a list of rules. In Loop it decides whether a
        plan or re-plan goes on without you.
      </p>
      <ul className="m-0 pl-4 text-xs">
        <li>
          New to-dos a re-plan may add by itself (Permissive):{" "}
          <strong>{s.maxNewItems}</strong>
          {s.maxNewItems === DEFAULT_MAX_NEW_PLAN_ITEMS ? " (default)" : ""}
        </li>
        <li>
          Stop a re-plan that weakens a check:{" "}
          <strong>{s.keepsChecks ? "on" : "off"}</strong>
        </li>
      </ul>
    </section>
  );
}

function QuestionSettings({ area }: { area: AreaReport }) {
  const s = area.settings;
  if (s?.kind !== "questions") return null;
  const list = (items: string[]) => (items.length ? items.join(", ") : "none");
  return (
    <section aria-label="Question settings" data-testid="question-settings">
      <h5 className="my-1 text-xs font-semibold">What Questions has</h5>
      <p className="my-1 text-2xs text-description-muted">
        Questions is a level and two lists of question types, not a list of
        rules.
      </p>
      <ul className="m-0 pl-4 text-xs">
        <li>
          You always decide: <strong>{list(s.youDecide)}</strong>
        </li>
        <li>
          The agent may decide: <strong>{list(s.agentDecides)}</strong>
        </li>
        <li>
          While a question waits:{" "}
          <strong>
            {s.delivery === "wait" ? "work stops" : "work goes on (inbox)"}
          </strong>
        </li>
      </ul>
      <details className="mt-1 text-2xs">
        <summary className="cursor-pointer">The types</summary>
        <ul className="m-0 pl-4">
          {Object.entries(QUESTION_TYPE_DESCRIPTIONS).map(([k, v]) => (
            <li key={k}>
              <strong>{k}</strong>: {v}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

function AreaPanel({
  area,
  report,
  env,
  audit,
  review,
  onReviewOpened,
}: {
  area: PolicyArea;
  report: EffectiveRulesReport;
  env: EditorEnv;
  audit?: AuditOverview;
  review?: ReviewRequest & { nonce: number };
  onReviewOpened?: () => void;
}) {
  const levels = useAppSelector((s) => s.ui.policyLevels);
  const [result, setResult] = useState<ToolCallTestResult | undefined>();
  const a = report.areas[area];
  const hasRules = area !== "plan" && area !== "questions";
  return (
    <div
      role="tabpanel"
      id={`permissions-panel-${area}`}
      aria-labelledby={`permissions-tab-${area}`}
      className="flex min-w-0 flex-col gap-3"
      data-testid={`panel-${area}`}
    >
      <section aria-label="Level">
        <div className="text-xs">
          {a.label}: <strong data-testid="area-level">{a.levelLabel}</strong>
        </div>
        <div className="text-2xs text-description-muted">
          {a.levelDescription} Change it in Settings &gt; Tools or the toolbar.
        </div>
      </section>
      <PlanSettings area={a} />
      <QuestionSettings area={a} />
      {hasRules && (
        <p
          className="m-0 text-2xs text-description-muted"
          data-testid="decision-order"
        >
          {report.decisionOrder}
        </p>
      )}
      {hasRules && <LocksSection />}
      <BuiltinList builtins={a.builtins} />
      {hasRules && (
        <>
          {report.userFile?.state === "broken" ? (
            <section aria-label="Rules" data-testid="rules">
              <h5 className="my-1 text-xs font-semibold">Rules</h5>
              <p className="my-1 text-xs text-error" role="alert">
                Your own rules cannot be shown because config.yaml cannot be
                read. This is not an empty list. Editing is off until the file
                is fixed.
              </p>
              <RuleList
                rules={a.rules}
                highlight={result?.matchedRules.map((m) => m.raw)}
              />
            </section>
          ) : (
            <EditableRules
              area={area}
              rules={a.rules}
              highlight={result?.matchedRules.map((m) => m.raw)}
              env={env}
              audit={audit}
              review={review}
              onReviewOpened={onReviewOpened}
            />
          )}
          <RuleTester area={area} levels={levels} onResult={setResult} />
        </>
      )}
    </div>
  );
}

/**
 * Settings > Permissions: every rule in effect by area, with its source and
 * whether it is obeyed, a tester that runs the real check, and the controls to
 * add, change, remove and adopt rules in your own config.yaml. Only the core
 * dialect is written; a config.yaml that cannot be read turns editing off
 * instead of showing an empty list.
 * The Reviewer tab joins the area tabs here later.
 */
export function PermissionsSection() {
  const ideMessenger = useContext(IdeMessengerContext);
  const levels = useAppSelector((s) => s.ui.policyLevels);
  const dispatch = useAppDispatch();
  const config = useAppSelector((s) => s.config.config);
  const { report, error, slow, loading, reload } = usePermissionsReport(
    ideMessenger,
    levels,
  );
  const [active, setActive] = useState<PolicyArea>("tools");
  // ?custom=<preset|current>&area=<area>: the Custom… entry of a policy control
  const [params, setParams] = useSearchParams();
  const customBase = params.get("custom");
  const customArea = params.get("area");
  const closeCustom = (message?: string) => {
    const next = new URLSearchParams(params);
    next.delete("custom");
    next.delete("area");
    setParams(next, { replace: true });
    if (message) {
      setStatus({ text: message });
      reload();
    }
  };
  // ?view=inbox|recent: a view opened from outside (the Command Palette's
  // Open Audit Inbox)
  const viewParam = params.get("view");
  const [view, setView] = useState<PermissionsView>(
    isPermissionsView(viewParam) ? viewParam : "rules",
  );
  useEffect(() => {
    if (isPermissionsView(viewParam)) setView(viewParam);
  }, [viewParam]);
  const [review, setReview] = useState<
    (ReviewRequest & { nonce: number }) | undefined
  >();
  const ruleTexts = report
    ? [
        ...new Set(
          [
            ...Object.values(report.areas).flatMap((a) => a.rules),
            ...report.unscoped,
          ].map(auditKeyOf),
        ),
      ]
    : [];
  const audit = useAuditOverview(ideMessenger, ruleTexts, Boolean(report));
  const [introHidden, setIntroHidden] = useState(false);
  const [status, setStatus] = useState<
    { text: string; error?: boolean } | undefined
  >();

  // Dismissal is saved in the person's own settings, so it holds for good.
  const showIntro =
    !introHidden && config.ui?.permissionsIntroDismissed !== true;
  const dismissIntro = () => {
    setIntroHidden(true);
    const shared = { permissionsIntroDismissed: true };
    dispatch(updateConfig(modifyAnyConfigWithSharedConfig(config, shared)));
    ideMessenger.post("config/updateSharedConfig", shared);
  };

  const userFile = report?.userFile;
  const env: EditorEnv = {
    editable: !userFile || userFile.state === "ok",
    baseHash: userFile?.hash,
    onChanged: (text) => {
      setStatus({ text });
      reload();
    },
  };

  // Review opens the editor in the rule's own area, with the rule filled in
  const onReview = (r: ReviewRequest) => {
    setActive(
      areaOfTool(r.rule.split("(")[0]) === "context" ? "context" : "tools",
    );
    setReview({ ...r, nonce: Date.now() });
  };

  const undo = async () => {
    const res = await ideMessenger.request("config/undoToolRule", {
      source: "permissions-page",
    });
    if (res.status !== "success") {
      setStatus({ text: "Could not undo. Nothing was changed.", error: true });
      return;
    }
    const r = res.content;
    setStatus({
      text:
        r.result === "undone"
          ? "Put config.yaml back as it was before your last change."
          : (r.error ?? "Could not undo."),
      error: r.result !== "undone",
    });
    reload();
  };

  return (
    <section className="mb-4 min-w-0" data-testid="permissions-page">
      <ConfigHeader
        title="Permissions"
        subtext="Every rule that decides what the agent may read, run and change, where it came from, and whether it applies. You can add, change and remove your own rules here; they are saved to your config.yaml."
        showAddButton={false}
        className="mb-2"
      />
      {showIntro && <FirstRunOverview onDismiss={dismissIntro} />}
      {report && isBaseName(customBase) ? (
        <CustomPolicy
          key={`${customBase}:${customArea ?? ""}`}
          base={customBase}
          area={
            POLICY_AREAS.includes(customArea as PolicyArea)
              ? (customArea as PolicyArea)
              : undefined
          }
          report={report}
          env={env}
          audit={audit.overview}
          onClose={closeCustom}
        />
      ) : (
        report && (
          <Button
            variant="outline"
            size="sm"
            className="mb-2 min-h-6"
            data-testid="open-custom-policy"
            onClick={() => {
              const next = new URLSearchParams(params);
              next.set("custom", "current");
              setParams(next);
            }}
          >
            Custom policy…
          </Button>
        )
      )}
      <ViewSwitch view={view} onChange={setView} />
      <div hidden={view !== "rules"}>
        {loading && <PermissionsSkeleton slow={slow} onRetry={reload} />}
        {error && <PermissionsError onRetry={reload} />}
        {userFile?.state === "broken" && (
          <div className="mb-2">
            <Alert type="error" size="sm">
              <span className="text-2xs" data-testid="config-broken">
                Your config.yaml cannot be read: {userFile.error} Your rules are
                not shown, and editing is off so nothing is written over the
                file. Fix the file, then reload.
              </span>
            </Alert>
          </div>
        )}
        {userFile?.state === "missing" && (
          <div className="mb-2">
            <Alert type="warning" size="sm">
              <span className="text-2xs" data-testid="config-missing">
                There is no config.yaml, so rules cannot be saved here.
              </span>
            </Alert>
          </div>
        )}
      </div>
      <div role="status" aria-live="polite" data-testid="change-status">
        {status && (
          <p
            className={`my-1 text-xs ${status.error ? "text-error" : "text-success"}`}
          >
            {status.text}
          </p>
        )}
      </div>
      {userFile?.undoable && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => void undo()}
          aria-label="Undo the last rule change"
          data-testid="undo-rule-change"
        >
          Undo last change
        </Button>
      )}
      <div hidden={view !== "rules"}>
        {report?.notices.map((n) => (
          <div className="mb-2" key={n}>
            <Alert type="warning" size="sm">
              <span className="text-2xs">{n}</span>
            </Alert>
          </div>
        ))}
        {report && (
          <div
            role="tablist"
            aria-label="Permission areas"
            className="mb-3 flex flex-wrap gap-1"
          >
            {POLICY_AREAS.map((area) => (
              <button
                key={area}
                role="tab"
                id={`permissions-tab-${area}`}
                aria-selected={active === area}
                aria-controls={`permissions-panel-${area}`}
                data-testid={`tab-${area}`}
                onClick={() => setActive(area)}
                className={`cursor-pointer rounded-sm border border-solid px-2 py-0.5 text-xs text-foreground ${
                  active === area
                    ? "border-border-focus bg-input"
                    : "border-border bg-transparent"
                }`}
              >
                {POLICY_AREA_LABELS[area]}
                {report && report.areas[area].rules.length > 0 && (
                  <span className="ml-1 text-description-muted">
                    {report.areas[area].rules.length}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        {report && (
          <AuditOverviewPanel
            overview={audit.overview}
            loading={audit.loading}
            slow={audit.slow}
            error={audit.error}
            canEdit={env.editable}
            onReview={onReview}
            onRetry={audit.reload}
          />
        )}
        {report && (
          <AreaPanel
            key={active}
            area={active}
            report={report}
            env={env}
            audit={audit.overview}
            review={review}
            onReviewOpened={() => setReview(undefined)}
          />
        )}
        {report && report.unscoped.length > 0 && (
          <section aria-label="Rules with no area" className="mt-3">
            <h5 className="my-1 text-xs font-semibold">Rules with no area</h5>
            <p className="my-1 text-2xs text-description-muted">
              These name a tool that only touches the session, or cannot be
              read, so no area applies.
            </p>
            <RuleList rules={report.unscoped} />
          </section>
        )}
      </div>
      {view === "recent" && (
        <div
          role="tabpanel"
          id="permissions-view-recent"
          aria-labelledby="permissions-view-tab-recent"
        >
          <AuditList />
        </div>
      )}
      {view === "inbox" && (
        <div
          role="tabpanel"
          id="permissions-view-inbox"
          aria-labelledby="permissions-view-tab-inbox"
        >
          <AuditInbox
            env={{ ...env, editable: env.editable && Boolean(report) }}
          />
        </div>
      )}
    </section>
  );
}
