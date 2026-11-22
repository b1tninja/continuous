import { ConfigYaml } from "@continuedev/config-yaml";
import {
  ArrowPathIcon,
  ArrowsRightLeftIcon,
  ChevronDownIcon,
  CircleStackIcon,
  CommandLineIcon,
  DocumentDuplicateIcon,
  DocumentTextIcon,
  EllipsisVerticalIcon,
  GlobeAltIcon,
  PencilIcon,
  PlayCircleIcon,
  StopCircleIcon,
  TrashIcon,
  UserCircleIcon,
} from "@heroicons/react/24/outline";
import { MCPConnectionStatus, MCPServerStatus } from "core";
import type { McpServerScope } from "core/config/mcpWizard/manageMcpServers";
import type {
  McpWizardListing,
  McpWizardScopesResponse,
} from "core/config/mcpWizard/protocolHandlers";
import type { McpServerDraft } from "core/config/mcpWizard/types";
import { useContext, useRef, useState } from "react";
import ConfirmationDialog from "../../../components/dialogs/ConfirmationDialog";
import Alert from "../../../components/gui/Alert";
import { ToolTip } from "../../../components/gui/Tooltip";
import { useEditBlock } from "../../../components/mainInput/Lump/useEditBlock";
import { looksLikeCredentialName } from "../../../components/McpServerDialog/mcpDialogForm";
import { useMcpServerDialog } from "../../../components/McpServerDialog/useMcpServerDialog";
import {
  Button,
  Listbox,
  ListboxButton,
  ListboxOption,
  ListboxOptions,
} from "../../../components/ui";
import { IdeMessengerContext } from "../../../context/IdeMessenger";
import { useToolChangeNote } from "../../../hooks/useToolChangeNote";
import { useAppDispatch, useAppSelector } from "../../../redux/hooks";
import { updateConfig } from "../../../redux/slices/configSlice";
import { setDialogMessage, setShowDialog } from "../../../redux/slices/uiSlice";
import { ToolPoliciesGroup } from "./ToolPoliciesGroup";

/*
  One MCP server in the MCP servers tab: where it is saved, its state, its
  tools, and the menu that edits, moves or removes it. A server this page
  cannot write (a JSON file in another tool's format, a legacy folder, a
  config from elsewhere) is shown read-only, with "Copy to" in place of Move.
*/

export interface McpServerCardProps {
  allToolsOff: boolean;
  server: MCPServerStatus;
  serverFromYaml?: NonNullable<ConfigYaml["mcpServers"]>[number];
  duplicateDetection: Record<string, boolean>;
  /** The saved entry behind this server, when this page can write it. */
  saved?: McpWizardListing;
  /** Every saved server, for name checks before a move. */
  allSaved: McpWizardListing[];
  scopes?: McpWizardScopesResponse;
  /** After an edit, a move or a removal: what happened, to show above the list. */
  onChanged: (message: string, tone: "ok" | "error") => void;
}

/** Why this page cannot write a server's definition. */
export function readOnlyReason(server: { sourceFile?: string }): string {
  const file = server.sourceFile ?? "";
  if (/\.json$/i.test(file)) {
    return "It is defined in a JSON file in another tool's format, which this page does not change.";
  }
  if (/[\\/]\.continue[\\/]/.test(file)) {
    return "It is defined in a legacy .continue folder, which this page does not change.";
  }
  if (!file) {
    return "It comes from the selected config or assistant, not from a file this page writes.";
  }
  return "This page does not change the file it is defined in.";
}

/** A running server as a draft for "Copy to": what the page already holds. */
export function draftFromStatus(server: MCPServerStatus): McpServerDraft {
  const rows = (map: Record<string, string> | undefined) =>
    Object.entries(map ?? {}).map(([name, value]) => ({
      name,
      value: String(value ?? ""),
      secret: looksLikeCredentialName(name),
    }));
  if ("command" in server) {
    return {
      name: server.name,
      transport: "stdio",
      command: server.command,
      args: server.args ?? [],
      env: rows(server.env),
      ...(server.cwd ? { cwd: server.cwd } : {}),
    };
  }
  return {
    name: server.name,
    transport: server.type === "sse" ? "sse" : "http",
    ...(server.type === undefined ? { autoTransport: true } : {}),
    url: server.url,
    headers: rows(server.requestOptions?.headers),
  };
}

/** The first of `name-2`, `name-3`, ... that no saved server has. */
export function freeCopyName(name: string, saved: McpWizardListing[]): string {
  const taken = new Set(saved.map((s) => s.name.trim().toLowerCase()));
  for (let i = 2; ; i++) {
    const candidate = `${name}-${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

const ServerStatusTooltip: Record<MCPConnectionStatus, string> = {
  connected: "Active",
  connecting: "Connecting",
  "not-connected": "Inactive",
  disabled: "Off",
  authenticating: "Authenticating",
  error: "Error",
};

const ServerStatusColor: Record<MCPConnectionStatus, string> = {
  connected: "bg-success",
  connecting: "bg-warning",
  "not-connected": "bg-description-muted",
  disabled: "bg-description-muted",
  authenticating: "bg-warning",
  error: "bg-error",
};

export function McpServerCard({
  server,
  serverFromYaml,
  allToolsOff,
  duplicateDetection,
  saved,
  allSaved,
  scopes,
  onChanged,
}: McpServerCardProps) {
  const [expandedSections, setExpandedSections] = useState<{
    [key: string]: boolean;
  }>({});
  const ideMessenger = useContext(IdeMessengerContext);
  const config = useAppSelector((store) => store.config.config);
  const editBlock = useEditBlock();
  const openDialog = useMcpServerDialog();
  const menuButton = useRef<HTMLButtonElement>(null);

  const dispatch = useAppDispatch();

  // ---- where it is saved ----
  const scope: McpServerScope =
    saved?.scope ?? (server.configSource === "workspace" ? "project" : "user");
  const file = saved?.file ?? server.sourceFile;
  const folders = scopes?.folders ?? [];
  const folderName =
    folders.length > 1
      ? folders.find((f) => f.dir === saved?.folder)?.name
      : undefined;
  const scopeLabel =
    scope === "user"
      ? "All projects"
      : folderName
        ? `Workspace: ${folderName}`
        : "This workspace";
  const readOnly = saved ? undefined : readOnlyReason(server);
  const target = saved
    ? { name: saved.name, scope: saved.scope, folder: saved.folder }
    : undefined;
  const refocus = () =>
    setTimeout(() => {
      if (menuButton.current?.isConnected) menuButton.current.focus();
    }, 0);

  const confirm = (
    title: string,
    text: string,
    confirmText: string,
    onConfirm: () => void,
  ) => {
    dispatch(setShowDialog(true));
    dispatch(
      setDialogMessage(
        <ConfirmationDialog
          title={title}
          text={text}
          confirmText={confirmText}
          onConfirm={() => {
            onConfirm();
            refocus();
          }}
          onCancel={refocus}
        />,
      ),
    );
  };

  const onEdit = () => {
    if (!target) return;
    openDialog({
      mode: { kind: "edit", target },
      opener: menuButton.current,
      onSaved: (m) => onChanged(m, "ok"),
    });
  };

  const onDuplicate = () => {
    const name = freeCopyName(server.name, allSaved);
    openDialog({
      mode: target
        ? { kind: "add", prefillFrom: target, prefillName: name }
        : { kind: "add", prefill: draftFromStatus(server), prefillName: name },
      opener: menuButton.current,
      onSaved: (m) => onChanged(m, "ok"),
    });
  };

  const onMove = (to: McpServerScope, folder?: string) => {
    if (!target || !saved) return;
    // Yours wins over a workspace server of the same name, so the other
    // place must not have one
    const clash = allSaved.find(
      (s) =>
        s !== saved &&
        s.name.trim().toLowerCase() === saved.name.trim().toLowerCase() &&
        (to === "project" ? true : s.scope === "user"),
    );
    if (clash && !(clash.scope === saved.scope && clash.file === saved.file)) {
      onChanged(
        `Not moved: a server called ${clash.name} is already saved in ${clash.file}. Rename one of them first.`,
        "error",
      );
      return;
    }
    const destination =
      to === "user"
        ? (scopes?.user.file ?? "your config.yaml")
        : (folders.find((f) => f.dir === folder) ?? folders[0])?.mcpDir;
    const text =
      to === "user"
        ? `${saved.name} will be added to ${destination} and removed from ${saved.file}.\n\nThis loosens it. It will start for every project without this folder being trusted, and a tool it marks as read-only can then run without asking. Its tools wait for your approval again.\n\nIt runs: ${saved.target}`
        : `${saved.name} will be added under ${destination} and removed from ${saved.file}.\n\nIt will start only when this folder is trusted, and all its tools will ask first. Secrets stay in your secret store; the file only refers to them.`;
    confirm(
      to === "user" ? "Move to all my projects" : "Move to this workspace",
      text,
      "Move",
      () => {
        void ideMessenger
          .request("mcp/move", {
            target,
            to: { scope: to, ...(folder ? { folder } : {}) },
            ...(to === "user" ? { consent: true } : {}),
          })
          .then((res) => {
            if (res.status !== "success") {
              onChanged(String(res.error ?? "Could not move it."), "error");
            } else if (!res.content.ok) {
              onChanged(res.content.error, "error");
            } else {
              const r = res.content;
              onChanged(
                [
                  `Moved ${r.name} to ${r.to}.`,
                  r.secretsStored.length
                    ? `Its credentials are now secrets: ${r.secretsStored.join(", ")}.`
                    : "",
                  ...r.warnings,
                ]
                  .filter(Boolean)
                  .join(" "),
                r.warnings.length ? "error" : "ok",
              );
            }
          });
      },
    );
  };

  const onRemove = () => {
    if (!target || !saved) return;
    confirm(
      "Remove MCP server",
      `${saved.name} will be removed from ${saved.file}. Secrets it used are kept.`,
      "Remove",
      () => {
        void ideMessenger.request("mcp/remove", target).then((res) => {
          if (res.status !== "success") {
            onChanged(String(res.error ?? "Could not remove it."), "error");
          } else if (!res.content.ok) {
            onChanged(res.content.error, "error");
          } else {
            onChanged(
              res.content.fileDeleted
                ? `Removed ${saved.name}. ${res.content.file} was deleted.`
                : `Removed ${saved.name} from ${res.content.file}.`,
              "ok",
            );
          }
        });
      },
    );
  };

  const warmCacheNote = useToolChangeNote();
  const updateMCPServerStatus = (status: MCPServerStatus["status"]) => {
    // optimistic config update
    dispatch(
      updateConfig({
        ...config,
        mcpServerStatuses: config.mcpServerStatuses.map((s) =>
          s.id === server.id
            ? {
                ...s,
                status,
              }
            : s,
        ),
      }),
    );
  };

  // OAuth applies to the HTTP-based transports. Sign in is always offered for
  // them (in the menu); it is also shown inline when the server needs it.
  const isRemote = "url" in server && server.type !== "websocket";
  const needsSignIn =
    server.status === "authenticating" ||
    (server.status !== "connected" &&
      (server.isProtectedResource || server.status === "error"));

  const onAuthenticate = async () => {
    if ("url" in server) {
      updateMCPServerStatus("authenticating");
      await ideMessenger.request("mcp/startAuthentication", {
        serverId: server.id,
        serverUrl: server.url,
      });
    }
  };

  const onRemoveAuth = async () => {
    if ("url" in server) {
      updateMCPServerStatus("authenticating");
      await ideMessenger.request("mcp/removeAuthentication", {
        serverId: server.id,
        serverUrl: server.url,
      });
    }
  };

  const onRefresh = async () => {
    updateMCPServerStatus("connecting");
    if (server.status === "disabled") {
      await ideMessenger.request("mcp/setServerEnabled", {
        id: server.id,
        enabled: true,
      });
    } else {
      await ideMessenger.request("mcp/reloadServer", {
        id: server.id,
      });
    }
  };

  const onDisconnect = async () => {
    updateMCPServerStatus("disabled");
    dispatch(
      updateConfig({
        ...config,
        tools: config.tools.filter((tool) => tool.group !== server.id),
      }),
    );
    await ideMessenger.request("mcp/setServerEnabled", {
      id: server.id,
      enabled: false,
    });
  };

  // TR4: tools the person has not approved are not offered to the model
  const pendingTools = config.tools.filter(
    (tool) => tool.group === server.name && tool.mcpPendingApproval,
  );
  const onApprove = async (tools: string[] | "all") => {
    await ideMessenger.request("mcp/approveTools", { id: server.id, tools });
  };

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => ({
      ...prev,
      [section]: !prev[section],
    }));
  };

  const ResourceRow = ({
    title,
    items,
    icon,
    sectionKey,
  }: {
    title: string;
    items:
      | MCPServerStatus["prompts"]
      | MCPServerStatus["resources"]
      | MCPServerStatus["resourceTemplates"];
    icon: React.ReactNode;
    sectionKey: string;
  }) => {
    const isExpanded = expandedSections[sectionKey];
    const hasItems = items.length > 0;

    return (
      <div>
        <div
          className="mx-2 flex cursor-pointer items-center justify-between rounded-sm hover:bg-gray-50/5"
          onClick={() => toggleSection(sectionKey)}
        >
          <div className="flex items-center gap-3">
            <ChevronDownIcon
              className={`h-3 w-3 text-description transition-transform ${isExpanded ? "rotate-180" : ""}`}
            />
            <div className="flex items-center gap-2">
              {icon}
              <span className="text-sm">{title}</span>
              <div className="flex h-5 w-5 items-center justify-center rounded-md bg-gray-600 px-0.5 text-xs font-medium text-white">
                {items.length}
              </div>
            </div>
          </div>
        </div>

        {isExpanded && (
          <div className="mx-2 my-2 mb-3">
            {hasItems ? (
              <div className="space-y-1">
                {items.map((item, idx) => {
                  return (
                    <div
                      key={idx}
                      className="rounded-sm bg-gray-50/5 px-2 py-1 text-xs text-description"
                    >
                      <code>{item.name}</code>
                      {item.description && (
                        <div className="mt-1 text-xs text-gray-500">
                          {item.description}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-xs text-gray-500 italic">
                No {title.toLowerCase()} available
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="" data-testid={`mcp-server-${server.name}`}>
      <div className="flex items-center justify-between gap-2 py-1">
        <div className="flex min-w-0 items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <h3 className="my-0 min-w-0 text-sm font-medium break-words">
                {server.name}
              </h3>
              <ToolTip content={ServerStatusTooltip[server.status] ?? "Error"}>
                <div
                  className={`h-2 w-2 shrink-0 rounded-full ${ServerStatusColor[server.status] ?? "bg-error"}`}
                />
              </ToolTip>
              <ToolTip content={file ? `Saved in ${file}` : readOnly}>
                <span
                  className="rounded-sm border border-solid border-border px-1 text-2xs whitespace-nowrap text-description"
                  data-testid="mcp-scope-label"
                  tabIndex={0}
                  aria-label={
                    file ? `${scopeLabel}, saved in ${file}` : scopeLabel
                  }
                >
                  {scopeLabel}
                </span>
              </ToolTip>
              {readOnly && (
                <ToolTip content={readOnly}>
                  <span
                    className="rounded-sm border border-solid border-border px-1 text-2xs whitespace-nowrap text-description"
                    data-testid="mcp-read-only"
                    tabIndex={0}
                    aria-label={`Read-only. ${readOnly}`}
                  >
                    Read-only
                  </span>
                </ToolTip>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1">
          {isRemote && needsSignIn && (
            <ToolTip
              content={
                server.status === "authenticating" ? "Signing in..." : "Sign in"
              }
            >
              <Button
                onClick={
                  server.status === "authenticating"
                    ? undefined
                    : onAuthenticate
                }
                variant="ghost"
                size="sm"
                className="my-0 h-6 w-6 p-0 pt-0.5 text-description-muted hover:enabled:text-foreground"
                disabled={server.status === "authenticating"}
                data-testid="mcp-sign-in"
              >
                {server.status === "authenticating" ? (
                  <GlobeAltIcon className="h-4 w-4 shrink-0 animate-spin-slow" />
                ) : (
                  <UserCircleIcon className="h-4 w-4 shrink-0" />
                )}
              </Button>
            </ToolTip>
          )}
          <Listbox>
            <ListboxButton
              ref={menuButton}
              aria-label={`Actions for ${server.name}`}
            >
              <EllipsisVerticalIcon className="h-4 w-4 shrink-0" />
            </ListboxButton>
            <ListboxOptions className="min-w-fit" anchor="bottom end">
              {isRemote && server.status !== "authenticating" && (
                <ListboxOption
                  value="sign in"
                  onClick={onAuthenticate}
                  className="justify-start gap-x-1.5"
                >
                  <UserCircleIcon className="h-4 w-4 shrink-0" /> Sign in
                </ListboxOption>
              )}
              {isRemote && server.isProtectedResource && (
                <ListboxOption
                  value="remove auth"
                  onClick={onRemoveAuth}
                  className="justify-start gap-x-1.5"
                >
                  <UserCircleIcon className="h-4 w-4 shrink-0" /> Sign out
                </ListboxOption>
              )}

              {saved && (
                <ListboxOption
                  value="edit"
                  onClick={onEdit}
                  className="justify-start gap-x-1.5"
                >
                  <PencilIcon className="h-3.5 w-3.5 shrink-0" /> Edit…
                </ListboxOption>
              )}
              <ListboxOption
                value="edit file"
                className="justify-start gap-x-1.5"
                onClick={() =>
                  editBlock(
                    serverFromYaml && "uses" in serverFromYaml
                      ? serverFromYaml.uses
                      : undefined,
                    file,
                  )
                }
              >
                <DocumentTextIcon className="h-3.5 w-3.5 shrink-0" /> Edit the
                file
              </ListboxOption>
              {saved && scope === "project" && (
                <ListboxOption
                  value="move user"
                  onClick={() => onMove("user")}
                  className="justify-start gap-x-1.5"
                >
                  <ArrowsRightLeftIcon className="h-3.5 w-3.5 shrink-0" /> Move
                  to all my projects
                </ListboxOption>
              )}
              {saved &&
                scope === "user" &&
                folders.map((f) => (
                  <ListboxOption
                    key={f.dir}
                    value={`move ${f.dir}`}
                    onClick={() => onMove("project", f.dir)}
                    className="justify-start gap-x-1.5"
                  >
                    <ArrowsRightLeftIcon className="h-3.5 w-3.5 shrink-0" />
                    {folders.length > 1
                      ? `Move to workspace folder ${f.name}`
                      : "Move to this workspace"}
                  </ListboxOption>
                ))}
              <ListboxOption
                value="duplicate"
                onClick={onDuplicate}
                className="justify-start gap-x-1.5"
              >
                <DocumentDuplicateIcon className="h-3.5 w-3.5 shrink-0" />
                {saved ? "Duplicate to…" : "Copy to…"}
              </ListboxOption>
              {saved && (
                <ListboxOption
                  value="remove"
                  onClick={onRemove}
                  className="justify-start gap-x-1.5"
                >
                  <TrashIcon className="h-3.5 w-3.5 shrink-0" /> Remove
                </ListboxOption>
              )}

              {server.status === "connected" && (
                <ListboxOption
                  value="disconnect"
                  onClick={onDisconnect}
                  className="justify-start gap-x-1.5"
                >
                  <span
                    className="flex items-center gap-x-1.5"
                    title={
                      warmCacheNote
                        ? `Removes this server's tools from the prompt. ${warmCacheNote}`
                        : undefined
                    }
                  >
                    <StopCircleIcon className="h-4 w-4 shrink-0" />
                    Disconnect
                  </span>
                </ListboxOption>
              )}

              {server.status !== "connecting" && (
                <ListboxOption
                  value="reconnect"
                  onClick={onRefresh}
                  className="justify-start gap-x-1.5"
                >
                  <span
                    className="flex items-center gap-x-1.5"
                    title={
                      warmCacheNote
                        ? `A server that comes back with different tools changes the prompt. ${warmCacheNote}`
                        : undefined
                    }
                  >
                    {server.status === "disabled" ? (
                      <PlayCircleIcon className="h-4 w-4 shrink-0" />
                    ) : (
                      <ArrowPathIcon className="h-4 w-4 shrink-0" />
                    )}
                    Reload
                  </span>
                </ListboxOption>
              )}
            </ListboxOptions>
          </Listbox>
        </div>
      </div>

      {/* Individual resource rows */}
      <div className="mt-1">
        <ToolPoliciesGroup
          showIcon={true}
          groupName={server.name}
          displayName={"Tools"}
          allToolsOff={allToolsOff}
          duplicateDetection={duplicateDetection}
          setAllPolicy
        />
        {pendingTools.length > 0 && (
          <div
            className="mx-2 my-2 space-y-1 rounded-sm bg-gray-50/5 px-2 py-1.5 text-xs"
            data-testid="mcp-pending-approval"
          >
            <div className="text-description">
              Not offered to the model until you approve{" "}
              {pendingTools.length === 1 ? "it" : "them"}. Read the description
              first: it is what the model will be told.
            </div>
            {pendingTools.map((tool) => (
              <div
                key={tool.function.name}
                className="flex items-start justify-between gap-2"
              >
                <div className="min-w-0">
                  <code>{tool.originalFunctionName ?? tool.function.name}</code>
                  {tool.mcpPendingApproval === "changed" && (
                    <span className="ml-1 text-warning">changed</span>
                  )}
                  {tool.function.description && (
                    <div className="mt-0.5 line-clamp-3 text-description">
                      {tool.function.description}
                    </div>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="my-0 shrink-0"
                  title={warmCacheNote || undefined}
                  data-testid="mcp-approve-tool"
                  onClick={() =>
                    void onApprove([
                      tool.originalFunctionName ?? tool.function.name,
                    ])
                  }
                >
                  Approve
                </Button>
              </div>
            ))}
            {pendingTools.length > 1 && (
              <Button
                variant="ghost"
                size="sm"
                className="my-0"
                title={warmCacheNote || undefined}
                data-testid="mcp-approve-all"
                onClick={() =>
                  void onApprove(
                    pendingTools.map(
                      (t) => t.originalFunctionName ?? t.function.name,
                    ),
                  )
                }
              >
                Approve all {pendingTools.length}
              </Button>
            )}
          </div>
        )}
        {server.prompts.length > 0 && (
          <ResourceRow
            title="Prompts"
            items={server.prompts}
            icon={
              <CommandLineIcon className="h-4 w-4 shrink-0 text-description" />
            }
            sectionKey={`${server.id}-prompts`}
          />
        )}
        {(server.resources.length > 0 ||
          server.resourceTemplates.length > 0) && (
          <ResourceRow
            title="Resources"
            items={[...server.resources, ...server.resourceTemplates]}
            icon={
              <CircleStackIcon className="h-4 w-4 shrink-0 text-description" />
            }
            sectionKey={`${server.id}-resources`}
          />
        )}
      </div>

      {/* Error display below expandable section */}
      {server.status === "error" && (
        <div
          className="mt-2 flex flex-wrap items-center gap-2 text-xs"
          data-testid="mcp-failed-start"
        >
          <span className="min-w-0 break-words">
            This server did not start. The reason it gave is below.
          </span>
          {saved && (
            <Button
              variant="outline"
              size="sm"
              className="my-0"
              onClick={onEdit}
            >
              Edit…
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="my-0"
            onClick={onRefresh}
          >
            Try again
          </Button>
        </div>
      )}
      {server.errors && server.errors.length > 0 && (
        <div className="mt-3 space-y-2">
          {server.errors.map((error, errorIndex) => (
            <Alert
              key={errorIndex}
              type="error"
              size="sm"
              className="cursor-pointer transition-all hover:underline"
              onClick={() =>
                void ideMessenger.ide.showVirtualFile(server.name, error)
              }
            >
              <span className="text-xs">
                {error.length > 150 ? error.substring(0, 150) + "..." : error}
              </span>
            </Alert>
          ))}
        </div>
      )}

      {server.infos && server.infos.length > 0 && (
        <div className="mt-3 space-y-2">
          {server.infos.map((info, infoIndex) => (
            <Alert
              key={infoIndex}
              type="info"
              size="sm"
              className="transition-all"
              onClick={() =>
                void ideMessenger.ide.showVirtualFile(server.name, info)
              }
            >
              <span
                className="text-xs"
                dangerouslySetInnerHTML={{ __html: info }}
              />
            </Alert>
          ))}
        </div>
      )}
    </div>
  );
}
