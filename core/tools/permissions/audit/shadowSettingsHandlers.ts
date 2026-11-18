import { getAuditTrail } from "./global";
import {
  checkShadowChange,
  readShadowForm,
  writeShadowChange,
  type ShadowChange,
  type ShadowForm,
  type ShadowWriteResult,
} from "./shadowConfig";
import { sharedLedger } from "./shadowLedger";
import { shadowSeed } from "./shadowReport";

/**
 * The Settings page's shadow reviewer messages (ROADMAP B67). Protocol
 * messages, not tools: nothing the model can call reaches them. Turning the
 * switch on sends tool-call text to a model, so it waits for the IDE's own
 * dialog, which the page cannot click; a missing answer is a no.
 */
export interface ShadowSettingsView {
  form: ShadowForm;
  /** The audit trail is what shadow reviews are written to; off, nothing runs */
  trailEnabled: boolean;
  spentUsd: number;
  /** In flight in any process right now */
  reservedUsd: number;
  reviews: number;
}

export type ShadowSetResponse = ShadowWriteResult & {
  view?: ShadowSettingsView;
};

export interface ShadowSettingsHost {
  /** The IDE's own dialog; resolves true only on an explicit yes */
  confirm?: (text: string) => Promise<boolean>;
  /** Tests: the config file and the audit directory */
  file?: string;
  dir?: string;
  trailEnabled?: boolean;
}

type On = (
  name: any,
  handler: (msg: { data: any }) => Promise<unknown>,
) => void;

export function enablingText(budgetUsd: number): string {
  return (
    "Turn on shadow review?\n\n" +
    "While this is on, each tool call you or your rules settle is sent to your reviewer model a second time: the tool name, its arguments and your recent messages, with secrets masked. " +
    "The answer is only recorded beside your own decision in the audit trail. It never changes a decision, and nothing waits for it.\n\n" +
    `This uses your model account and is capped at $${budgetUsd} across every window and the command line. ` +
    "Saved to your own config.yaml."
  );
}

async function view(host: ShadowSettingsHost): Promise<ShadowSettingsView> {
  const trail = host.dir === undefined ? getAuditTrail() : undefined;
  const dir = host.dir ?? trail!.dir;
  const ledger = sharedLedger(dir, () => shadowSeed(dir));
  // Counts what the trail already holds the first time, then reads one file
  await ledger.ensureSeeded();
  const s = ledger.summary();
  return {
    form: readShadowForm(host.file),
    trailEnabled: host.trailEnabled ?? trail?.enabled ?? true,
    spentUsd: s.spentUsd,
    reservedUsd: s.reservedUsd,
    reviews: s.reviews,
  };
}

export function registerShadowSettingsHandlers(
  on: On,
  host: ShadowSettingsHost,
): void {
  on("audit/shadowSettings", async () => view(host));

  on(
    "audit/setShadowSettings",
    async ({ data }): Promise<ShadowSetResponse> => {
      const checked = checkShadowChange(data);
      if (!checked.ok) return { result: "refused", error: checked.error };
      const change: ShadowChange = checked.change;
      const before = readShadowForm(host.file);
      if (change.enabled === true && !before.enabled) {
        const budget = change.budgetUsd ?? before.budgetUsd;
        if (budget === undefined) {
          return {
            result: "refused",
            error: "Set a budget before turning it on.",
          };
        }
        const ok = host.confirm
          ? await host.confirm(enablingText(budget)).catch(() => false)
          : false;
        if (!ok) {
          return {
            result: "refused",
            error:
              "Not confirmed in the editor's own dialog, so nothing was changed.",
          };
        }
      }
      const res = writeShadowChange(change, host.file);
      return res.result === "refused"
        ? res
        : { ...res, view: await view(host) };
    },
  );
}
