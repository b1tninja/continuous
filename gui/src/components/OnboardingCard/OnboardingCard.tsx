import { OnboardingModes } from "core/protocol/core";
import { useAppSelector } from "../../redux/hooks";
import { getLocalStorage, setLocalStorage } from "../../util/localStorage";
import { ReusableCard } from "../ReusableCard";
import { OnboardingProvidersTab } from "./components/OnboardingProvidersTab";
import { useOnboardingCard } from "./hooks/useOnboardingCard";

export interface OnboardingCardState {
  show?: boolean;
  activeTab?: OnboardingModes;
}

interface OnboardingCardProps {
  isDialog?: boolean;
}

/**
 * The first-run card. It holds the "Add a model" flow from its start screen
 * ("What do you have?"), which took the place of the "API Key" and "Local"
 * tabs: a key, a server on this computer and nothing yet are answers there.
 */
export function OnboardingCard({ isDialog }: OnboardingCardProps) {
  const { close } = useOnboardingCard();
  const config = useAppSelector((store) => store.config.config);

  if (getLocalStorage("onboardingStatus") === undefined) {
    setLocalStorage("onboardingStatus", "Started");
  }

  return (
    <ReusableCard
      showCloseButton={!isDialog && !!config.modelsByRole.chat.length}
      onClose={close}
      testId="onboarding-card"
    >
      <OnboardingProvidersTab isDialog={isDialog} />
    </ReusableCard>
  );
}
