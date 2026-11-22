import {
  ChevronDownIcon,
  WrenchScrewdriverIcon,
} from "@heroicons/react/24/outline";
import { Tool } from "core";
import { useMemo, useState } from "react";
import ToggleSwitch from "../../../components/gui/Switch";
import { ToolTip } from "../../../components/gui/Tooltip";
import {
  Card,
  Listbox,
  ListboxButton,
  ListboxOption,
  ListboxOptions,
} from "../../../components/ui";
import { useAppDispatch, useAppSelector } from "../../../redux/hooks";
import { useToolChangeNote } from "../../../hooks/useToolChangeNote";
import {
  setToolPolicies,
  toggleToolGroupSetting,
} from "../../../redux/slices/uiSlice";
import {
  GROUP_TOOL_POLICY_LABEL,
  groupPolicyResultText,
  groupPolicyState,
  groupPolicyTargets,
  GroupToolPolicy,
} from "./toolGroupPolicy";
import { ToolPolicyItem } from "./ToolPolicyItem";

interface ToolPoliciesGroupProps {
  showIcon: boolean;
  groupName: string;
  displayName: string;
  allToolsOff: boolean;
  duplicateDetection: Record<string, boolean>;
  /** Offer "set all to" on the header (an MCP server's group) */
  setAllPolicy?: boolean;
}

export function ToolPoliciesGroup({
  showIcon,
  groupName,
  displayName,
  allToolsOff,
  duplicateDetection,
  setAllPolicy = false,
}: ToolPoliciesGroupProps) {
  const dispatch = useAppDispatch();
  const [isExpanded, setIsExpanded] = useState(false);

  const availableTools = useAppSelector(
    (state) => state.config.config.tools as Tool[],
  );
  const tools = useMemo(() => {
    return availableTools.filter((t) => t.group === groupName);
  }, [availableTools, groupName]);

  const toolGroupSettings = useAppSelector(
    (state) => state.ui.toolGroupSettings,
  );
  const toolSettings = useAppSelector((state) => state.ui.toolSettings);
  const warmCacheNote = useToolChangeNote();
  const isGroupEnabled = useMemo(() => {
    return toolGroupSettings[groupName] !== "exclude";
  }, [toolGroupSettings, groupName]);

  const { enabledCount, totalCount } = useMemo(() => {
    const total = tools.length;
    const enabled = tools.filter(
      (tool) => toolSettings[tool.function.name] !== "disabled",
    ).length;
    return { enabledCount: enabled, totalCount: total };
  }, [tools, toolSettings]);

  const badgeText = useMemo(() => {
    if (enabledCount === totalCount) {
      return totalCount.toString();
    }
    return `${enabledCount}/${totalCount}`;
  }, [enabledCount, totalCount]);

  const { targets, skipped } = useMemo(
    () => groupPolicyTargets(tools, toolSettings),
    [tools, toolSettings],
  );
  const groupState = useMemo(
    () => groupPolicyState(targets, toolSettings),
    [targets, toolSettings],
  );
  const [setAllResult, setSetAllResult] = useState<string>();
  const setAllDisabled = allToolsOff || !isGroupEnabled;
  const setAll = (policy: GroupToolPolicy) => {
    dispatch(
      setToolPolicies({
        toolNames: targets.map((tool) => tool.function.name),
        policy,
      }),
    );
    setSetAllResult(groupPolicyResultText(policy, targets.length, skipped));
  };

  return (
    <Card className="flex flex-1 flex-col p-0">
      <div
        className="flex cursor-pointer flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-sm px-2 py-2 hover:bg-gray-50/5"
        data-testid="tool-group-header"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-3">
          <ChevronDownIcon
            className={`h-3 w-3 text-description transition-transform ${
              isExpanded ? "rotate-180" : ""
            }`}
          />
          <div className="flex items-center gap-2">
            {showIcon && <WrenchScrewdriverIcon className="h-4 w-4 shrink-0" />}
            <span className="text-sm font-semibold">{displayName}</span>
            <div className="flex h-5 min-w-5 items-center justify-center rounded-md bg-gray-600 px-1 text-xs font-medium text-white">
              {badgeText}
            </div>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {setAllPolicy && groupState && (
            // The menu is drawn elsewhere on the page but is a React child of
            // the header: a choice must not also open or close the list.
            <div onClick={(e) => e.stopPropagation()}>
              <Listbox
                value={groupState === "mixed" ? null : groupState}
                onChange={(policy: GroupToolPolicy | null) => {
                  if (policy) {
                    setAll(policy);
                  }
                }}
                disabled={setAllDisabled}
              >
                <ListboxButton
                  className={
                    setAllDisabled
                      ? "h-7 cursor-not-allowed justify-between border-command-border px-2 whitespace-nowrap opacity-50"
                      : "h-7 justify-between border-command-border px-2 whitespace-nowrap"
                  }
                  data-testid={`tool-group-policy-${groupName}`}
                >
                  <span className="text-xs">
                    {groupState === "mixed"
                      ? "Mixed"
                      : `All: ${GROUP_TOOL_POLICY_LABEL[groupState]}`}
                    {/* the name starts with the words on the button */}
                    <span className="sr-only">
                      {`, policy for all tools of ${groupName}`}
                    </span>
                  </span>
                  <ChevronDownIcon className="h-3 w-3" />
                </ListboxButton>
                <ListboxOptions className="min-w-0" anchor="bottom end">
                  <ListboxOption value="allowedWithoutPermission">
                    Set all to Automatic
                  </ListboxOption>
                  <ListboxOption value="allowedWithPermission">
                    Set all to Ask First
                  </ListboxOption>
                </ListboxOptions>
              </Listbox>
            </div>
          )}
          <ToolTip
            content={
              allToolsOff
                ? "Tools disabled in current mode"
                : (isGroupEnabled
                    ? `Disable all tools in ${groupName} group`
                    : `Enable all tools in ${groupName} group`) +
                  (warmCacheNote
                    ? `. This changes the tool list. ${warmCacheNote}`
                    : "")
            }
          >
            <div>
              <ToggleSwitch
                isToggled={isGroupEnabled}
                onToggle={() => dispatch(toggleToolGroupSetting(groupName))}
                text=""
                size={10}
                disabled={allToolsOff}
              />
            </div>
          </ToolTip>
        </div>
      </div>
      {setAllPolicy && setAllResult && (
        <div
          role="status"
          className="px-2 pb-2 text-xs text-description"
          data-testid={`tool-group-policy-result-${groupName}`}
        >
          {setAllResult}
        </div>
      )}

      {isExpanded && (
        <div className="mt-3 space-y-1 pl-2">
          {tools.map((tool) => (
            <ToolPolicyItem
              key={tool.uri + tool.function.name}
              tool={tool}
              duplicatesDetected={duplicateDetection[tool.function.name]}
              isGroupEnabled={isGroupEnabled}
            />
          ))}
        </div>
      )}
    </Card>
  );
}
