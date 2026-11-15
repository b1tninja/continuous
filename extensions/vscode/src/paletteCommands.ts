import type { ToWebviewProtocol } from "core/protocol";

/**
 * Command Palette commands for the fork's own pages and chat actions (NI13).
 * Each does what its button in the panel does: a page opens through the
 * panel's `navigateTo` route, and a chat action is a webview message whose
 * handler runs the button's own thunk (gui/src/hooks/usePaletteCommandListeners).
 * None has a default key: the key for Stop is the owner's decision (NI8).
 */

/** The panel routes the page commands open; gui/src/util/navigation.ts. */
export const PALETTE_ROUTES = {
  permissions: "/config?tab=permissions",
  providers: "/config?tab=providers",
  auditInbox: "/config?tab=permissions&view=inbox",
  stats: "/stats",
} as const;

export const PALETTE_COMMAND_IDS = [
  "continuous.openPermissions",
  "continuous.openProviders",
  "continuous.openAuditInbox",
  "continuous.openStats",
  "continuous.startLoop",
  "continuous.stopLoop",
  "continuous.stopResponse",
  "continuous.resumeResponse",
  "continuous.showAgents",
  "continuous.testConnection",
] as const;

export type PaletteCommandId = (typeof PALETTE_COMMAND_IDS)[number];

export interface PaletteHost {
  /** Reveals the panel and waits until it can answer; false when it cannot. */
  showPanel(): Promise<boolean>;
  request<T extends keyof ToWebviewProtocol>(
    messageType: T,
    data: ToWebviewProtocol[T][0],
  ): Promise<ToWebviewProtocol[T][1] | undefined>;
  info(message: string): void;
}

/** What the command says when there was nothing to act on. */
export const PALETTE_NOTHING_TO_DO = {
  stopResponse: "Nothing is running to stop.",
  resumeResponse: "There is no stopped or failed response to resume.",
  startLoop: "A loop is already running.",
  stopLoop: "No loop is running, or it is already stopping.",
  showAgents: "This session has no agents yet.",
  testConnection:
    "No chat model is selected. Add one with Continuous: Manage Models and Providers.",
} as const;

export function paletteCommands(
  host: PaletteHost,
): Record<PaletteCommandId, () => Promise<void>> {
  const open = (path: string) => async () => {
    if (!(await host.showPanel())) {
      return;
    }
    await host.request("navigateTo", { path, toggle: false });
  };
  /** A chat action; `applied` reads its answer, undefined when there was none. */
  const action =
    <T extends keyof typeof PALETTE_NOTHING_TO_DO>(
      messageType: T,
      applied: (answer: ToWebviewProtocol[T][1]) => boolean = (a) => a === true,
    ) =>
    async () => {
      if (!(await host.showPanel())) {
        return;
      }
      const answer = await host.request(messageType, undefined);
      if (answer === undefined) {
        return;
      }
      if (!applied(answer)) {
        host.info(PALETTE_NOTHING_TO_DO[messageType]);
      }
    };

  return {
    "continuous.openPermissions": open(PALETTE_ROUTES.permissions),
    "continuous.openProviders": open(PALETTE_ROUTES.providers),
    "continuous.openAuditInbox": open(PALETTE_ROUTES.auditInbox),
    "continuous.openStats": open(PALETTE_ROUTES.stats),
    "continuous.startLoop": action("startLoop", (a) => a !== "running"),
    "continuous.stopLoop": action("stopLoop"),
    "continuous.stopResponse": action("stopResponse"),
    "continuous.resumeResponse": action("resumeResponse"),
    "continuous.showAgents": action("showAgents"),
    "continuous.testConnection": action("testConnection"),
  };
}
