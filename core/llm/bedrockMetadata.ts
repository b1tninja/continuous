import type { RequestOptions } from "../index.js";

import {
  ensureBedrockPriceList,
  readBedrockPriceList,
} from "./bedrockPriceList.js";
import type {
  BedrockQuotaReport,
  QuotaCheckTrigger,
} from "./llms/bedrockQuotas.js";
import { ModelCatalogRefresher } from "./modelCatalogRefresh.js";
import {
  readModelCatalogSettings,
  type ModelCatalogSettings,
} from "./modelCatalogStore.js";
import { setBedrockPriceList } from "./utils/bedrockPriceListPricing.js";

/**
 * Provider metadata for the selected Bedrock model, with the user's own
 * credentials (owner decision 4 in plans/research/provider-model-metadata.md):
 * its region's AWS Price List and the account's Service Quotas. Only the
 * provider of the selected model is looked at, never every configured one.
 *
 * - On selection (and at start-up for the model already selected): the kept
 *   price list is put in front of the cost functions (a file read), and
 *   under `automatic` the quotas and prices are refreshed when stale.
 * - In the background under `automatic`: at most once per refresh interval.
 * - `off`: nothing is requested and nothing kept is used.
 *
 * A 0 quota for the selected model is reported once per model and region
 * per process, through `onZeroQuota`. Nothing here blocks a request.
 */

/** What this module needs from a Bedrock model (the Bedrock class has it). */
export interface SelectedBedrockModel {
  model: string;
  region?: string;
  checkQuotas(trigger: QuotaCheckTrigger): Promise<BedrockQuotaReport>;
  zeroQuotaWarning(report: BedrockQuotaReport): string | undefined;
}

export interface BedrockMetadataDeps {
  requestOptions: () =>
    Promise<RequestOptions | undefined> | RequestOptions | undefined;
  onZeroQuota: (warning: string) => void;
  settings?: () => ModelCatalogSettings;
  log?: (message: string) => void;
  /** Tests: the cache folder */
  dir?: string;
}

export class BedrockMetadataTracker {
  private current: SelectedBedrockModel | undefined;
  private readonly warned = new Set<string>();
  readonly refresher: ModelCatalogRefresher<void>;

  constructor(private readonly deps: BedrockMetadataDeps) {
    this.refresher = new ModelCatalogRefresher<void>({
      settings: () => this.settings(),
      // With no Bedrock model selected there is nothing to refresh
      fetchedAt: () => {
        const region = this.current?.region;
        if (!this.current) return new Date().toISOString();
        return region
          ? readBedrockPriceList(region, deps.dir)?.fetchedAt
          : undefined;
      },
      pull: async () => {
        const selected = this.current;
        if (!selected) return;
        await Promise.all([
          this.checkQuotas(selected, "background"),
          ensureBedrockPriceList(selected.region, "background", {
            requestOptions: await deps.requestOptions(),
            settings: this.settings(),
            dir: deps.dir,
          }),
        ]);
      },
      log: deps.log,
    });
  }

  private settings(): ModelCatalogSettings {
    return (this.deps.settings ?? (() => readModelCatalogSettings()))();
  }

  /** The selected Bedrock model, if any. */
  get selected(): SelectedBedrockModel | undefined {
    return this.current;
  }

  /**
   * The selected chat model changed (or the config loaded). Returns at once;
   * the lookups run afterwards.
   */
  select(model: SelectedBedrockModel | undefined): Promise<void> {
    const before = this.current;
    this.current = model;
    if (!model) {
      setBedrockPriceList(undefined);
      return Promise.resolve();
    }
    if (
      before &&
      before.model === model.model &&
      before.region === model.region
    ) {
      return Promise.resolve();
    }
    return this.onSelected(model);
  }

  private async onSelected(model: SelectedBedrockModel): Promise<void> {
    const settings = this.settings();
    try {
      await Promise.all([
        this.checkQuotas(model, "model-selected"),
        ensureBedrockPriceList(model.region, "model-selected", {
          requestOptions: await this.deps.requestOptions(),
          settings,
          dir: this.deps.dir,
        }).catch((e) =>
          this.deps.log?.(
            `AWS Price List download failed (${e instanceof Error ? e.message : String(e)}); the built-in Bedrock prices stay in use`,
          ),
        ),
      ]);
    } catch {
      // advisory only
    }
  }

  /** Run the quota check and report a 0 quota for the selected model once. */
  async checkQuotas(
    model: SelectedBedrockModel,
    trigger: QuotaCheckTrigger,
  ): Promise<BedrockQuotaReport | undefined> {
    let report: BedrockQuotaReport;
    try {
      report = await model.checkQuotas(trigger);
    } catch {
      return undefined;
    }
    this.warnIfZero(model, report);
    return report;
  }

  /** Report a 0 quota once per model and region in this process. */
  warnIfZero(model: SelectedBedrockModel, report: BedrockQuotaReport): void {
    const warning = model.zeroQuotaWarning(report);
    if (!warning) return;
    const key = `${model.model}@${report.region}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    try {
      this.deps.onZeroQuota(warning);
    } catch {
      // a listener's problem
    }
  }
}

/** What Test connection reports about quotas: one quiet line at most. */
export interface BedrockQuotaSummary {
  status: BedrockQuotaReport["status"];
  /** "Quota check skipped: ..." when it was skipped for a reason worth a line */
  note?: string;
  docsUrl?: string;
  fetchedAt?: string;
  /** How many listed models have a 0 quota on their route */
  zeroQuotaModels?: number;
}

/**
 * Mark each listed model whose quota on its route is 0, and summarise the
 * check for the Test connection result.
 */
export function withQuotaWarnings<T extends { id: string; name: string }>(
  models: T[],
  report: BedrockQuotaReport,
  warningFor: (id: string, name: string) => string | undefined,
): { models: (T & { quotaWarning?: string })[]; quota: BedrockQuotaSummary } {
  let zero = 0;
  const marked = models.map((m) => {
    const quotaWarning = report.quotas ? warningFor(m.id, m.name) : undefined;
    if (!quotaWarning) return m;
    zero += 1;
    return { ...m, quotaWarning };
  });
  return {
    models: marked,
    quota: {
      status: report.status,
      ...(report.note ? { note: report.note } : {}),
      ...(report.docsUrl ? { docsUrl: report.docsUrl } : {}),
      ...(report.fetchedAt ? { fetchedAt: report.fetchedAt } : {}),
      ...(zero > 0 ? { zeroQuotaModels: zero } : {}),
    },
  };
}
