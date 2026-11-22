import { OnboardingModes } from "core/protocol/core";
import { ProviderSetupFlow } from "../../ProviderSetup/ProviderSetupFlow";
import { useSubmitOnboarding } from "../hooks/useSubmitOnboarding";

interface OnboardingProvidersTabProps {
  /** Whether this is being shown in a dialog context */
  isDialog?: boolean;
}

/**
 * The card's content: the shared "Add a model" flow, from its start screen
 * (what the person has), then the connection, the models, what to use them
 * for and the review.
 */
export function OnboardingProvidersTab({
  isDialog,
}: OnboardingProvidersTabProps) {
  const { finishOnboarding } = useSubmitOnboarding(
    OnboardingModes.API_KEY,
    isDialog,
  );

  return (
    <div className="flex h-full w-full items-center justify-center">
      <ProviderSetupFlow onDone={finishOnboarding} />
    </div>
  );
}
