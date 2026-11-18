import { ConfigHeader } from "../components/ConfigHeader";
import { ProviderInstancesCard } from "../components/ProviderInstancesCard";
import { ProvidersCard } from "../components/ProvidersCard";

/**
 * Settings > Providers: the provider connections of the selected config and
 * the named accounts in providers.yaml, in one place instead of behind
 * "Manage models". Every action opens the existing setup flow or sends the
 * message the Models page used.
 */
export function ProvidersSection() {
  return (
    <div className="space-y-4">
      <ConfigHeader
        title="Providers"
        subtext="Connections, how each signs in, and which of its models are enabled"
        showAddButton={false}
      />
      <ProvidersCard />
      <ProviderInstancesCard />
    </div>
  );
}
