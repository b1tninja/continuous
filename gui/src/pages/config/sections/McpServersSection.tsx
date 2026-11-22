import { parseConfigYaml } from "@continuedev/config-yaml";
import { MCPServerStatus } from "core";
import type {
  McpWizardListing,
  McpWizardScopesResponse,
} from "core/config/mcpWizard/protocolHandlers";
import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import Alert from "../../../components/gui/Alert";
import { useMcpServerDialog } from "../../../components/McpServerDialog/useMcpServerDialog";
import { Button, Card } from "../../../components/ui";
import { useAuth } from "../../../context/Auth";
import { IdeMessengerContext } from "../../../context/IdeMessenger";
import { useAppSelector } from "../../../redux/hooks";
import { ConfigHeader } from "../components/ConfigHeader";
import { ImportClineMcpButton } from "../components/ImportClineMcp";
import { McpServerCard } from "../components/McpServerCard";

/*
  Settings, MCP servers: every server with where it is saved, and the one
  place to add, edit, move and remove them. Which servers run comes from the
  loaded config (redux); where each is saved comes from core (`mcp/list`),
  which reads the files itself.
*/

const sameName = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/** A path or file URI reduced to what two spellings of one file share. */
const pathKey = (p: string) => {
  let s = p;
  try {
    s = decodeURIComponent(p);
  } catch {
    // keep it as it is
  }
  return s
    .replace(/^file:\/\/\/?/i, "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
};

/** The saved entry behind a running server, if this page can write it. */
export function savedFor(
  server: MCPServerStatus,
  saved: McpWizardListing[],
): McpWizardListing | undefined {
  // A JSON file in another tool's format is loaded but never written here
  if (server.sourceFile && /\.json$/i.test(server.sourceFile)) return undefined;
  const scope = server.configSource === "workspace" ? "project" : "user";
  const matches = saved.filter(
    (s) => sameName(s.name, server.name) && s.scope === scope,
  );
  if (matches.length <= 1 || !server.sourceFile) return matches[0];
  const key = pathKey(server.sourceFile);
  return (
    matches.find((s) => key.endsWith(pathKey(s.file))) ??
    matches.find((s) => pathKey(s.file).endsWith(key)) ??
    matches[0]
  );
}

export function McpServersSection() {
  const ideMessenger = useContext(IdeMessengerContext);
  const openDialog = useMcpServerDialog();
  const { selectedProfile } = useAuth();
  const availableTools = useAppSelector((state) => state.config.config.tools);
  const mode = useAppSelector((store) => store.session.mode);
  const servers = useAppSelector(
    (store) => store.config.config.mcpServerStatuses,
  );

  const [saved, setSaved] = useState<McpWizardListing[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [scopes, setScopes] = useState<McpWizardScopesResponse>();
  const [status, setStatus] = useState<{
    text: string;
    tone: "ok" | "error";
  }>();
  const [refreshes, setRefreshes] = useState(0);

  // The files are read again whenever the loaded servers change (a save
  // reloads the config) and after each action here
  const loadedKey = (servers ?? [])
    .map((s) => `${s.name}|${s.configSource}|${s.sourceFile}|${s.status}`)
    .join("\n");
  useEffect(() => {
    let live = true;
    void ideMessenger.request("mcp/list", undefined).then((res) => {
      if (!live || res.status !== "success") return;
      setSaved(res.content.servers);
      setProblems(res.content.problems);
    });
    void ideMessenger.request("mcp/scopes", undefined).then((res) => {
      if (live && res.status === "success") setScopes(res.content);
    });
    return () => {
      live = false;
    };
  }, [ideMessenger, loadedKey, refreshes]);

  const onChanged = useCallback((text: string, tone: "ok" | "error") => {
    setStatus({ text, tone });
    setRefreshes((n) => n + 1);
  }, []);

  const duplicateDetection = useMemo(() => {
    const counts: Record<string, number> = {};
    availableTools.forEach((tool) => {
      counts[tool.function.name] = (counts[tool.function.name] ?? 0) + 1;
    });
    return Object.fromEntries(
      Object.entries(counts).map(([k, v]) => [k, v > 1]),
    );
  }, [availableTools]);

  const yamlServersByName = useMemo(() => {
    const parsed = selectedProfile?.rawYaml
      ? parseConfigYaml(selectedProfile.rawYaml)
      : undefined;
    return new Map(
      parsed?.mcpServers
        ?.filter(
          (server): server is NonNullable<typeof server> & { name: string } =>
            server != null && "name" in server,
        )
        .map((server) => [server.name, server]) ?? [],
    );
  }, [selectedProfile]);

  const rows = (servers ?? []).map((server) => ({
    server,
    saved: savedFor(server, saved),
  }));
  // Saved, and not among the running: another config is selected, or a
  // server of yours has the same name
  const shown = new Set(rows.map((r) => r.saved).filter(Boolean));
  const notLoaded = saved.filter((s) => !shown.has(s));

  const untrusted = (scopes?.folders ?? []).filter(
    (f) => f.trust === "untrusted",
  );

  const add = (opener: Element | null) =>
    openDialog({
      mode: { kind: "add" },
      opener: opener instanceof HTMLElement ? opener : null,
      onSaved: (m) => onChanged(m, "ok"),
    });

  const askTrust = async () => {
    try {
      const res = await ideMessenger.request("projectTrust/ask", undefined);
      if (res.status !== "success") throw new Error(String(res.error));
      const shownBy = res.content.shown;
      onChanged(
        shownBy === "workspace"
          ? "The editor's workspace trust page is open. Trust the workspace there first."
          : shownBy === "config"
            ? "Answered. Servers of a trusted folder start now."
            : "Nothing is waiting to be trusted. If a server still says it was not started, reload the window.",
        "ok",
      );
    } catch {
      onChanged(
        "This editor cannot ask from here. Reload the window and answer its question about this folder's configuration.",
        "error",
      );
    }
  };

  const allToolsOff = mode === "chat";

  return (
    <>
      <ConfigHeader
        title="MCP servers"
        subtext="Programs and services that give the model more tools"
        className="mb-2"
        onAddClick={() => add(document.activeElement)}
        addButtonTooltip="Add MCP server"
      />
      <div className="mb-4 space-y-4">
        {mode === "chat" && (
          <Alert type="info" size="sm">
            <span className="text-2xs italic">
              MCP tools are off in Chat. Switch to Plan or Agent mode to use
              them.
            </span>
          </Alert>
        )}
        {untrusted.length > 0 && (
          <Alert type="warning" size="sm">
            <div
              className="flex min-w-0 flex-col gap-1 text-xs"
              data-testid="mcp-untrusted"
            >
              <span className="break-words">
                {untrusted.length === 1
                  ? `The MCP servers of this folder (${untrusted[0].name}) are not trusted, so they were not started.`
                  : `The MCP servers of ${untrusted.map((f) => f.name).join(", ")} are not trusted, so they were not started.`}{" "}
                They are commands and addresses that came with the folder. Read
                them first, then let the editor ask you.
              </span>
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  className="my-0"
                  onClick={() => void askTrust()}
                >
                  Trust this folder…
                </Button>
              </div>
            </div>
          </Alert>
        )}
        {status && (
          <p
            className={
              status.tone === "error"
                ? "m-0 text-xs break-words text-error"
                : "m-0 text-xs break-words text-description"
            }
            role={status.tone === "error" ? "alert" : "status"}
            data-testid="mcp-status"
          >
            {status.text}
          </p>
        )}
        {problems.map((p) => (
          <p key={p} className="m-0 text-xs break-words text-warning">
            {p}
          </p>
        ))}
        <div className="flex justify-end empty:hidden">
          <ImportClineMcpButton />
        </div>

        {rows.length > 0 ? (
          rows.map(({ server, saved: entry }) => (
            <McpServerCard
              key={`${server.id}|${server.configSource}`}
              server={server}
              serverFromYaml={yamlServersByName.get(server.name)}
              allToolsOff={allToolsOff}
              duplicateDetection={duplicateDetection}
              saved={entry}
              allSaved={saved}
              scopes={scopes}
              onChanged={onChanged}
            />
          ))
        ) : (
          <Card>
            <div
              className="flex flex-col items-start gap-2 p-1 text-sm"
              data-testid="mcp-empty"
            >
              <p className="m-0 text-description">
                An MCP server is a program on this computer, or a service at an
                address, that gives the model more tools, such as searching your
                issues or reading a database. You have none yet.
              </p>
              <Button
                className="my-0"
                onClick={(e) => add(e.currentTarget)}
                data-testid="mcp-add-first"
              >
                Add a server
              </Button>
            </div>
          </Card>
        )}

        {notLoaded.length > 0 && (
          <div
            className="flex flex-col gap-1 text-xs"
            data-testid="mcp-not-loaded"
          >
            <h3 className="my-0 text-sm font-medium">Saved, not loaded</h3>
            {notLoaded.map((s) => (
              <p
                key={`${s.scope}|${s.file}|${s.name}`}
                className="m-0 break-words text-description"
              >
                {s.name}, {s.scope === "user" ? "all projects" : "workspace"}:
                saved in {s.file}.{" "}
                {s.scope === "project" &&
                saved.some(
                  (o) => o.scope === "user" && sameName(o.name, s.name),
                )
                  ? "Your own server of the same name is used instead."
                  : "The config in use does not load it."}
              </p>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
