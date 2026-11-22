import { useId } from "react";
import { Divider } from "./Divider";
import { TabButton } from "./TabButton";

interface TabOption {
  id: string;
  label: string;
  component: React.ReactNode;
  icon: React.ReactNode;
  /** A command such as Back, not a tab */
  action?: boolean;
}

interface TabGroupProps {
  tabs: TabOption[];
  activeTab: string;
  onTabClick: (tabId: string) => void;
  label?: string;
  showTopDivider?: boolean;
  showBottomDivider?: boolean;
  className?: string;
}

/**
 * A run of Settings tabs. Below `sm` the group has no box of its own, so its
 * tabs share the one row of the top strip (dividers are hidden there); from
 * `sm` it is a column in the sidebar.
 */
export function TabGroup({
  tabs,
  activeTab,
  onTabClick,
  label,
  showTopDivider = false,
  showBottomDivider = false,
  className = "",
}: TabGroupProps) {
  // Two groups on one page must not share element ids
  const groupId = useId();
  return (
    <div className={`contents sm:block sm:shrink-0 ${className}`}>
      {showTopDivider && <Divider className="hidden sm:block" />}

      {label && (
        <div className="mb-1 ml-1.5 hidden text-2xs font-medium text-description md:block md:pt-1">
          {label}
        </div>
      )}

      {tabs.map((tab) => (
        <TabButton
          key={tab.id}
          label={tab.label}
          icon={tab.icon}
          isActive={activeTab === tab.id}
          onClick={() => onTabClick(tab.id)}
          tabId={tab.id}
          action={tab.action}
          domId={`${groupId}-tab-${tab.id}`}
        />
      ))}

      {showBottomDivider && <Divider className="hidden sm:block" />}
    </div>
  );
}
