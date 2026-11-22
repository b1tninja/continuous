import React, { useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Divider } from "../../components/ui/Divider";
import { TabGroup } from "../../components/ui/TabGroup";
import { useNavigationListener } from "../../hooks/useNavigationListener";
import { useAppSelector } from "../../redux/hooks";
import {
  landingTab,
  readLastTab,
  rememberLastTab,
  rewriteConfigLink,
} from "./configLinks";
import { bottomTabSections, getAllTabs, topTabSections } from "./configTabs";
import { AccountDropdown } from "./features/account/AccountDropdown";

const isCommandSection = (section: { tabs: { action?: boolean }[] }) =>
  section.tabs.every((tab) => tab.action);

/** Arrow keys (and Home/End) move between tabs; the focused tab opens. */
function moveBetweenTabs(e: React.KeyboardEvent<HTMLDivElement>) {
  const keys = [
    "ArrowRight",
    "ArrowDown",
    "ArrowLeft",
    "ArrowUp",
    "Home",
    "End",
  ];
  if (!keys.includes(e.key)) return;
  const tabs = [
    ...e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'),
  ];
  const at = tabs.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  e.preventDefault();
  const next =
    e.key === "Home"
      ? 0
      : e.key === "End"
        ? tabs.length - 1
        : (at +
            (e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1) +
            tabs.length) %
          tabs.length;
  tabs[next]?.focus();
  tabs[next]?.click();
}

function ConfigPage() {
  useNavigationListener();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const tablistRef = useRef<HTMLDivElement>(null);

  const allTabs = getAllTabs();

  // An old link (a tab or section that moved) is rewritten to where its
  // content is now. The page already draws that place on this render; the
  // effect puts the same thing in the URL, where the views and folds read it.
  const rewritten = rewriteConfigLink(searchParams);
  const linked = (rewritten ?? searchParams).get("tab");
  useEffect(() => {
    if (rewritten) setSearchParams(rewritten, { replace: true });
  }, [rewritten, setSearchParams]);

  // With no tab in the link: Models while no chat model is selected, else the
  // tab last used
  const hasChatModel = useAppSelector(
    (state) => !!state.config.config.selectedModelByRole.chat,
  );
  const activeTab =
    linked ||
    landingTab({
      hasChatModel,
      lastTab: readLastTab(),
      tabIds: allTabs.filter((t) => !t.action).map((t) => t.id),
    });
  useEffect(() => {
    // Only a tab the person asked for: landing on Models for want of a model
    // must not replace the tab they use
    if (linked) rememberLastTab(linked);
  }, [linked]);

  const handleTabClick = (tabId: string) => {
    if (tabId === "back") {
      navigate("/");
    } else {
      navigate(`/config?tab=${tabId}`);
    }
  };

  // In a short sidebar the selected tab may be off screen.
  useEffect(() => {
    tablistRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeTab]);

  const renderGroup = (section: (typeof topTabSections)[number]) => (
    <TabGroup
      key={section.id}
      tabs={section.tabs}
      activeTab={activeTab}
      onTabClick={handleTabClick}
      showTopDivider={section.showTopDivider}
      showBottomDivider={section.showBottomDivider}
      className={section.className}
    />
  );
  const sections = [...topTabSections, ...bottomTabSections];

  return (
    <div className="flex h-full flex-col overflow-hidden sm:flex-row">
      {/* Below `sm`: one row of icons along the top, every tab in view (it wraps under about 170 px). From `sm`: the vertical sidebar. */}
      <nav
        aria-label="Settings"
        className="flex shrink-0 flex-row border-0 bg-vsc-background sm:w-12 sm:flex-col md:w-40"
      >
        <div className="thin-scrollbar flex min-w-0 flex-1 flex-row flex-wrap items-center border-0 border-b-2 border-solid border-b-border p-1 text-xs sm:flex-col sm:flex-nowrap sm:items-stretch sm:overflow-x-hidden sm:overflow-y-auto sm:border-r-2 sm:border-b-0 sm:border-r-border sm:p-2">
          {sections.filter(isCommandSection).map(renderGroup)}

          <div
            ref={tablistRef}
            role="tablist"
            aria-label="Settings sections"
            className="contents sm:flex sm:flex-1 sm:flex-col sm:items-stretch"
            onKeyDown={moveBetweenTabs}
          >
            {topTabSections
              .filter((s) => !isCommandSection(s))
              .map((section) => (
                <React.Fragment key={section.id}>
                  {renderGroup(section)}
                </React.Fragment>
              ))}

            <div className="hidden flex-1 sm:block" />

            {bottomTabSections.map(renderGroup)}
          </div>

          <Divider className="hidden sm:block" />

          <AccountDropdown />
        </div>
      </nav>

      {/* Main content area */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div
          role="tabpanel"
          aria-label={allTabs.find((tab) => tab.id === activeTab)?.label}
          className="thin-scrollbar relative flex-1 overflow-x-hidden overflow-y-auto"
        >
          <div className="min-w-0 space-y-6 px-4 py-4">
            {allTabs.find((tab) => tab.id === activeTab)?.component}
          </div>
        </div>
      </div>
    </div>
  );
}

export default ConfigPage;
