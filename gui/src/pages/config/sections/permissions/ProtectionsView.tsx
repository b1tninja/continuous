import { useState } from "react";
import { BuiltinRulesCard } from "../../../../components/PolicyControls/BuiltinRulesCard";
import { DecisionTimerCard } from "../../../../components/PolicyControls/DecisionTimerCard";
import {
  builtinRulesSummary,
  decisionTimerSummary,
} from "../../../../components/PolicyControls/policySummaries";
import { Fold } from "../../../../components/ui";
import { useAppSelector } from "../../../../redux/hooks";
import { ShadowReviewControl } from "../ShadowReviewControl";
import { TerminalEnvironmentControl } from "../TerminalEnvironmentControl";
import { LocksSection } from "./Locks";

/** Shown until a folded control has read its own state. */
const READING = "Reading the setting…";

/**
 * Settings > Permissions > Protections: what guards a call whatever the
 * level. The locks are always shown. The safeguards with a safe built-in
 * value are folded, each to one line that says the value in use.
 */
export function ProtectionsView() {
  const extras = useAppSelector((s) => s.ui.policyExtras);
  const floor = extras.floor ?? [];
  const builtin = builtinRulesSummary(extras);
  const timer = decisionTimerSummary(extras);
  const [secrets, setSecrets] = useState({ text: READING, warning: false });
  const [shadow, setShadow] = useState(READING);

  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="protections">
      <LocksSection />
      {floor.length > 0 && (
        <p
          className="my-0 text-2xs text-description"
          data-testid="policy-floor"
        >
          {floor.length} locked rule{floor.length === 1 ? "" : "s"} in
          permissions.yaml block these calls at every level below IDGAF. At
          IDGAF they are recorded, not applied. Edit the file to change them.
        </p>
      )}
      <Fold
        id="builtin-rules"
        title="Built-in rules"
        summary={builtin.text}
        tone={builtin.warning ? "warning" : undefined}
      >
        <BuiltinRulesCard />
      </Fold>
      <Fold
        id="commands-secrets"
        title="Commands and secrets"
        summary={secrets.text}
        tone={secrets.warning ? "warning" : undefined}
      >
        <TerminalEnvironmentControl
          folded
          onSummary={(text, warning) => setSecrets({ text, warning })}
        />
      </Fold>
      <Fold id="decision-timer" title="Decision timer" summary={timer.text}>
        <DecisionTimerCard folded />
      </Fold>
      <Fold id="shadow-review" title="Shadow review" summary={shadow}>
        <ShadowReviewControl folded onSummary={setShadow} />
      </Fold>
    </div>
  );
}
