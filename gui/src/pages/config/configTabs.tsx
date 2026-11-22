import {
  ArrowLeftIcon,
  Cog6ToothIcon,
  CubeIcon,
  DocumentIcon,
  PencilIcon,
  QuestionMarkCircleIcon,
  ServerStackIcon,
  ShieldCheckIcon,
  WrenchScrewdriverIcon,
} from "@heroicons/react/24/outline";
import { ConfigSection } from "./components/ConfigSection";
import { ConfigsSection } from "./sections/ConfigsSection";
import { HelpSection } from "./sections/HelpSection";
import { ModelsSection } from "./sections/ModelsSection";
import { PermissionsSection } from "./sections/permissions/PermissionsSection";
import { ProvidersSection } from "./sections/ProvidersSection";
import { RulesSection } from "./sections/RulesSection";
import { ToolsSection } from "./sections/ToolsSection";
import { UserSettingsSection } from "./sections/UserSettingsSection";

interface TabOption {
  id: string;
  label: string;
  component: React.ReactNode;
  icon: React.ReactNode;
  /** A command (Back), not a tab */
  action?: boolean;
}

interface TabSection {
  id: string;
  tabs: TabOption[];
  showTopDivider?: boolean;
  showBottomDivider?: boolean;
  className?: string;
}

export const topTabSections: TabSection[] = [
  {
    id: "top",
    tabs: [
      {
        id: "back",
        label: "Back",
        action: true,
        component: <div />,
        icon: <ArrowLeftIcon className="h-3 w-3 shrink-0 xs:h-4 xs:w-4" />,
      },
    ],
  },
  {
    id: "blocks",
    showTopDivider: true,
    tabs: [
      {
        id: "models",
        label: "Models",
        component: (
          <ConfigSection>
            <ModelsSection />
          </ConfigSection>
        ),
        icon: <CubeIcon className="h-3 w-3 shrink-0 xs:h-4 xs:w-4" />,
      },
      // A tab that belongs second, after Models, goes here.
      {
        id: "providers",
        label: "Providers",
        component: (
          <ConfigSection>
            <ProvidersSection />
          </ConfigSection>
        ),
        icon: <ServerStackIcon className="h-3 w-3 shrink-0 xs:h-4 xs:w-4" />,
      },
      {
        id: "tools",
        label: "Tools",
        component: (
          <ConfigSection>
            <ToolsSection />
          </ConfigSection>
        ),
        icon: (
          <WrenchScrewdriverIcon className="h-3 w-3 shrink-0 xs:h-4 xs:w-4" />
        ),
      },
      {
        id: "permissions",
        label: "Permissions",
        component: (
          <ConfigSection>
            <PermissionsSection />
          </ConfigSection>
        ),
        icon: <ShieldCheckIcon className="h-3 w-3 shrink-0 xs:h-4 xs:w-4" />,
      },
      {
        id: "rules",
        label: "Rules",
        component: (
          <ConfigSection>
            <RulesSection />
          </ConfigSection>
        ),
        icon: <PencilIcon className="h-3 w-3 shrink-0 xs:h-4 xs:w-4" />,
      },
    ],
  },
  {
    id: "agents-orgs",
    showTopDivider: true,
    tabs: [
      {
        id: "configs",
        label: "Configs",
        component: (
          <ConfigSection>
            <ConfigsSection />
          </ConfigSection>
        ),
        icon: <DocumentIcon className="h-3 w-3 shrink-0 xs:h-4 xs:w-4" />,
      },
    ],
  },
];

export const bottomTabSections: TabSection[] = [
  {
    id: "bottom",
    tabs: [
      {
        id: "general",
        label: "General",
        component: (
          <ConfigSection>
            <UserSettingsSection />
          </ConfigSection>
        ),
        icon: <Cog6ToothIcon className="h-3 w-3 shrink-0 xs:h-4 xs:w-4" />,
      },
      {
        id: "help",
        label: "Help",
        component: (
          <ConfigSection>
            <HelpSection />
          </ConfigSection>
        ),
        icon: (
          <QuestionMarkCircleIcon className="h-3 w-3 shrink-0 xs:h-4 xs:w-4" />
        ),
      },
    ],
  },
];

export const getAllTabs = (): TabOption[] => {
  return [...topTabSections, ...bottomTabSections].flatMap(
    (section) => section.tabs,
  );
};
