/**
 * Where a link into Settings lands. Tabs and sections have moved; every old
 * `/config?tab=<id>` (and `&section=<id>`) keeps working by being rewritten to
 * the place the content is now. `section` names a fold or block on the tab,
 * which opens and scrolls into view (components/ui/Fold.tsx).
 */

interface Target {
  tab: string;
  /** Permissions only: the view the content is in. */
  view?: string;
  section?: string;
}

/** A tab that no longer exists, and where its content went. */
const TAB_ALIASES: Record<string, Target> = {
  // "Settings" inside Settings was renamed
  settings: { tab: "general" },
  // The Indexing tab is a folded group on General
  indexing: { tab: "general", section: "index" },
};

/**
 * Sections that used to be on the Tools tab and are now a Permissions view.
 * The Tools tab never had section links, so these names are new: they are the
 * same ids the folds on Permissions use, accepted with `tab=tools` too.
 */
const MOVED_FROM_TOOLS: Record<string, Target> = {
  approval: { tab: "permissions", view: "levels" },
  "skip-confirmation": { tab: "permissions", view: "levels" },
  "plans-questions": {
    tab: "permissions",
    view: "levels",
    section: "plans-questions",
  },
  "builtin-rules": {
    tab: "permissions",
    view: "protections",
    section: "builtin-rules",
  },
  "commands-secrets": {
    tab: "permissions",
    view: "protections",
    section: "commands-secrets",
  },
  "decision-timer": {
    tab: "permissions",
    view: "protections",
    section: "decision-timer",
  },
  "shadow-review": {
    tab: "permissions",
    view: "protections",
    section: "shadow-review",
  },
};

/**
 * The query a link should have had, or undefined when it already names a
 * current place. Other parameters (`custom`, `area`, ...) are kept.
 */
export function rewriteConfigLink(
  params: URLSearchParams,
): URLSearchParams | undefined {
  const tab = params.get("tab");
  if (!tab) return undefined;
  const section = params.get("section") ?? "";
  const target = tab === "tools" ? MOVED_FROM_TOOLS[section] : TAB_ALIASES[tab];
  if (!target) return undefined;
  const next = new URLSearchParams(params);
  next.set("tab", target.tab);
  if (target.view) next.set("view", target.view);
  if (target.section) next.set("section", target.section);
  // A section name that only said where to go is used up
  else if (tab === "tools") next.delete("section");
  return next;
}

const LAST_TAB_KEY = "continuous.settings.lastTab";

/** The tab the person last opened, on this machine; undefined when none or unreadable. */
export function readLastTab(): string | undefined {
  try {
    return localStorage.getItem(LAST_TAB_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function rememberLastTab(tab: string): void {
  try {
    localStorage.setItem(LAST_TAB_KEY, tab);
  } catch {
    // Not remembered; Settings opens on Models next time.
  }
}

/**
 * The tab Settings opens on when the link names none: Models while no chat
 * model is selected (nothing works until one is), otherwise the tab last
 * used, and Models the first time.
 */
export function landingTab(opts: {
  hasChatModel: boolean;
  lastTab: string | undefined;
  tabIds: readonly string[];
}): string {
  if (!opts.hasChatModel) return "models";
  return opts.lastTab && opts.tabIds.includes(opts.lastTab)
    ? opts.lastTab
    : "models";
}
