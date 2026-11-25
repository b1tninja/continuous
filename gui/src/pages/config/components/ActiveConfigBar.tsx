import { useAuth } from "../../../context/Auth";

/** The file name of a config, from its URI or path. */
export function configFileName(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  const name = decodeURIComponent(
    uri.split(/[\\/]/).filter(Boolean).pop() ?? "",
  );
  return name || undefined;
}

/**
 * Which config this page is editing, on every Settings tab. A config can mix
 * providers and models, so the models, MCP servers and rules on the page are
 * the active config's. The bar names it and says which file. It is not
 * interactive on purpose: a link to the Configs tab would add a Tab stop before
 * the content of every Settings tab (the walk check counts them), and the
 * Configs tab is one click away in the sidebar.
 */
export function ActiveConfigBar() {
  const { selectedProfile } = useAuth();
  if (!selectedProfile) return null;
  const file = configFileName(selectedProfile.uri);
  return (
    <div
      data-testid="active-config-bar"
      className="flex min-w-0 shrink-0 flex-wrap items-baseline gap-x-2 gap-y-0 border-0 border-b border-solid border-b-border bg-vsc-background px-4 py-1.5 text-xs"
    >
      <span className="text-description-muted">Active config</span>
      <span
        data-testid="active-config-name"
        className="min-w-0 font-semibold break-words"
        title={selectedProfile.uri}
      >
        {selectedProfile.title}
      </span>
      {file && (
        <span
          className="hidden min-w-0 truncate text-description-muted min-[420px]:inline"
          title={selectedProfile.uri}
        >
          {file}
        </span>
      )}
    </div>
  );
}
