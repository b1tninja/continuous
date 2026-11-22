// Valid config tab names
export type ConfigTab =
  | "models"
  | "mcp"
  | "tools"
  | "permissions"
  | "rules"
  | "configs"
  | "general"
  | "help";

// TODO: Move all the routes here
export const ROUTES = {
  HOME: "/",
  HOME_INDEX: "/index.html",
  CONFIG: "/config",
  THEME: "/theme",
  STATS: "/stats",
  // EXAMPLE_ROUTE_WITH_PARAMS: (params: ParamsType) => `/route/${params}`,
};

// Helper function to build config URLs with tabs
export const buildConfigRoute = (tab?: ConfigTab): string => {
  return tab ? `${ROUTES.CONFIG}?tab=${tab}` : ROUTES.CONFIG;
};

// Typed config route builders for common tabs
export const CONFIG_ROUTES = {
  MODELS: buildConfigRoute("models"),
  MCP: buildConfigRoute("mcp"),
  // The Providers tab merged into Models; its connections are a block there
  PROVIDERS: `${buildConfigRoute("models")}&section=connections`,
  RULES: buildConfigRoute("rules"),
  TOOLS: buildConfigRoute("tools"),
  PERMISSIONS: buildConfigRoute("permissions"),
  CONFIGS: buildConfigRoute("configs"),
  GENERAL: buildConfigRoute("general"),
  // The Indexing tab is a folded group on General
  INDEXING: `${buildConfigRoute("general")}&section=index`,
  HELP: buildConfigRoute("help"),
} as const;

/**
 * The Custom policy editor on the Permissions page, started from a preset
 * (or the current levels) and, from an area's control, open at that area.
 */
export const customPolicyRoute = (opts: {
  base?: string;
  area?: string;
}): string => {
  const params = new URLSearchParams({
    tab: "permissions",
    custom: opts.base ?? "current",
  });
  if (opts.area) params.set("area", opts.area);
  return `${ROUTES.CONFIG}?${params.toString()}`;
};
