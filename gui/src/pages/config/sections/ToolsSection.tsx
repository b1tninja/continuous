import { BUILT_IN_GROUP_NAME } from "core/tools/builtIn";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import Alert from "../../../components/gui/Alert";
import { useAppSelector } from "../../../redux/hooks";
import { CONFIG_ROUTES } from "../../../util/navigation";
import { ConfigHeader } from "../components/ConfigHeader";
import { PolicyCard } from "../../../components/PolicyControls";
import { ToolPoliciesGroup } from "../components/ToolPoliciesGroup";
import { ToolChangeNotice } from "../../../components/toolChanges/ToolChangeNotice";
import { ShadowReviewControl } from "./ShadowReviewControl";
import { TerminalEnvironmentControl } from "./TerminalEnvironmentControl";

export function ToolsSection() {
  const availableTools = useAppSelector((state) => state.config.config.tools);

  const mode = useAppSelector((store) => store.session.mode);
  const navigate = useNavigate();

  const duplicateDetection = useMemo(() => {
    const counts: Record<string, number> = {};
    availableTools.forEach((tool) => {
      if (counts[tool.function.name]) {
        counts[tool.function.name] = counts[tool.function.name] + 1;
      } else {
        counts[tool.function.name] = 1;
      }
    });
    return Object.fromEntries(
      Object.entries(counts).map(([k, v]) => [k, v > 1]),
    );
  }, [availableTools]);

  const allToolsOff = useMemo(() => {
    return mode === "chat";
  }, [mode]);

  const availableToolsMessage =
    mode === "chat"
      ? "All tools disabled in Chat, switch to Plan or Agent mode to use tools"
      : mode === "plan"
        ? "Read-only tools available in Plan mode"
        : "";

  return (
    <>
      <ConfigHeader
        title="Tools"
        subtext="Manage built-in tools and tool policies"
        className="mb-2"
      />
      {!!availableToolsMessage && (
        <div className="mb-4">
          <Alert type="info" size="sm">
            <span className="text-2xs italic">{availableToolsMessage}</span>
          </Alert>
        </div>
      )}
      <div className="mb-4 space-y-6">
        <ToolChangeNotice />
        <PolicyCard />
        <ShadowReviewControl />
        <TerminalEnvironmentControl />
        <ToolPoliciesGroup
          showIcon={false}
          groupName={BUILT_IN_GROUP_NAME}
          displayName={"Built-in Tools"}
          allToolsOff={allToolsOff}
          duplicateDetection={duplicateDetection}
        />
        {/* For a release or two: old links and habits still land here */}
        <p className="m-0 text-xs text-description" data-testid="mcp-moved">
          MCP servers have moved to their own tab.{" "}
          <a
            className="text-link"
            href={CONFIG_ROUTES.MCP}
            onClick={(e) => {
              e.preventDefault();
              void navigate(CONFIG_ROUTES.MCP);
            }}
          >
            Open MCP servers
          </a>
        </p>
      </div>
    </>
  );
}
