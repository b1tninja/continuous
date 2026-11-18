import * as path from "path";

import { env } from "../../env.js";
import { services } from "../../services/index.js";
import { useNavigation } from "../context/NavigationContext.js";

interface ConfigOption {
  id: string;
  name: string;
  type: "local" | "assistant" | "create";
  slug?: string;
  organizationId?: string | null;
}

interface UseConfigSelectorProps {
  configPath?: string;
  onMessage: (message: {
    role: string;
    content: string;
    messageType: "system";
  }) => void;
  handleClear: () => void;
}

const CONFIG_PATH = path.join(env.continueHome, "config.yaml");

export function useConfigSelector({
  onMessage,
  handleClear,
}: UseConfigSelectorProps) {
  const { closeCurrentScreen } = useNavigation();

  const handleConfigSelect = async (config: ConfigOption) => {
    closeCurrentScreen();

    if (config.type === "create") {
      // Nothing is opened or fetched: say where the file goes.
      onMessage({
        role: "system",
        content: `To add a configuration, create ${CONFIG_PATH} (or pass --config <path>).`,
        messageType: "system" as const,
      });
      return;
    }

    try {
      // Show loading message
      onMessage({
        role: "system",
        content: `Switching to configuration: ${config.name}...`,
        messageType: "system" as const,
      });

      let targetConfigPath: string | undefined;

      if (config.type === "local") {
        targetConfigPath = CONFIG_PATH;
      } else if (config.type === "assistant" && config.slug) {
        targetConfigPath = config.slug;
      }

      await services.config.updateConfigPath(targetConfigPath);

      handleClear();

      // Show success message
      onMessage({
        role: "system",
        content: `Successfully switched to configuration: ${config.name}`,
        messageType: "system" as const,
      });
    } catch (error: any) {
      // Show error message
      onMessage({
        role: "system",
        content: `Failed to switch configuration: ${error.message}`,
        messageType: "system" as const,
      });
    }
  };

  return {
    handleConfigSelect,
  };
}
