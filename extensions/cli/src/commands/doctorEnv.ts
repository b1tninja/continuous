/**
 * `continuous doctor env`: what the agent is told about this machine and
 * folder (plans/research/env-disclosure-master-plan.md 7.1, row ENV28). It
 * gathers the same snapshot a session in this folder would and prints the
 * three texts the renderer gives and every contract field with where it goes,
 * its state and the setting that changes it. `--json` prints the renderer's
 * object. Nothing is sent to a model or the network: the only processes run
 * are the local git reads of the gatherer.
 */
import {
  formatDisclosureReport,
  renderEnvironment,
  type Detail,
  type EnvironmentSnapshot,
  type Surface,
} from "core/util/environmentPrompt.js";
import {
  gatherEnvironment,
  parseEnvDetail,
} from "core/util/environmentSnapshot.js";

import { environmentDetail, isRunningInWsl } from "../environmentContext.js";

export const DOCTOR_SURFACES: readonly Surface[] = [
  "cli",
  "headless",
  "serve",
  "acp",
  "ide-chat",
  "ide-agent",
  "ide-plan",
  "subagent",
  "loop-worker",
];

export interface DoctorEnvOptions {
  json?: boolean;
  surface?: string;
  detail?: string;
  write?: (line: string) => void;
  /** For tests: the snapshot to render instead of gathering one. */
  snapshot?: EnvironmentSnapshot;
}

export async function doctorEnvCommand(
  options: DoctorEnvOptions = {},
): Promise<number> {
  const write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
  const surface = (options.surface ?? "cli") as Surface;
  if (!DOCTOR_SURFACES.includes(surface)) {
    write(
      `Unknown surface "${options.surface}". Use one of: ${DOCTOR_SURFACES.join(", ")}`,
    );
    return 1;
  }
  const detail: Detail | undefined =
    options.detail === undefined
      ? environmentDetail()
      : parseEnvDetail(options.detail);
  if (!detail) {
    write(
      `Unknown detail level "${options.detail}". Use minimal, standard or full.`,
    );
    return 1;
  }
  const snapshot =
    options.snapshot ??
    (await gatherEnvironment({
      cwd: process.cwd(),
      hostWsl: process.platform === "linux" ? isRunningInWsl() : undefined,
    }));
  const d = renderEnvironment(snapshot, { surface, detail });
  if (options.json) {
    write(
      JSON.stringify(
        {
          surface,
          detail,
          systemLine: d.systemLine,
          toolSentence: d.toolSentence,
          firstMessageBlock: d.firstMessageBlock,
          fields: d.fieldReport,
          placements: d.placements,
          hash: d.hash,
          sessionHash: d.sessionHash,
          withheld: d.withheld,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  write(formatDisclosureReport(d, { surface, detail }));
  return 0;
}
