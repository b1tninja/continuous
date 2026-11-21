import type { BackgroundJob } from "../services/BackgroundJobService.js";
import { services } from "../services/index.js";

import { Tool } from "./types.js";

/** The longest a CheckBackgroundJob call waits, in seconds. */
export const MAX_WAIT_SECONDS = 60;

/** `wait_seconds` as a whole number from 0 to MAX_WAIT_SECONDS; anything else is 0. */
export function clampWaitSeconds(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_WAIT_SECONDS, Math.floor(n));
}

export const checkBackgroundJobTool: Tool = {
  name: "CheckBackgroundJob",
  displayName: "Check Background Job",
  description: `Check the status and output of a background job.
Returns the current status, exit code (if finished), and all available output.
If the job is still running, returns partial output with "running" status.
To wait for a job, pass wait_seconds instead of running a sleep command: the call returns as soon as the job ends, or after that many seconds.`,
  parameters: {
    type: "object",
    required: ["job_id"],
    properties: {
      job_id: {
        type: "string",
        description:
          "The ID of the background job to check (e.g., bg-1-1234567890)",
      },
      wait_seconds: {
        type: "number",
        description:
          "Wait up to this many seconds for the job to end before reading (at most 60). Returns at once when it has already ended. Default 0: read now.",
      },
    },
  },
  readonly: true,
  isBuiltIn: true,
  run: async ({
    job_id,
    wait_seconds,
  }: {
    job_id: string;
    wait_seconds?: number;
  }): Promise<string> => {
    const waited = clampWaitSeconds(wait_seconds);
    let waitedFor: "ended" | "still-running" | undefined;
    if (waited > 0 && services.backgroundJobs.getJob(job_id)) {
      waitedFor = (await services.backgroundJobs.waitForJob(
        job_id,
        waited * 1000,
      ))
        ? "ended"
        : "still-running";
    }
    const job = services.backgroundJobs.getJob(job_id);

    if (!job) {
      return JSON.stringify({
        error: `Job ${job_id} not found`,
        available_jobs: services.backgroundJobs
          .getAllJobs()
          .map((j: BackgroundJob) => ({
            id: j.id,
            status: j.status,
            command:
              j.command.substring(0, 50) + (j.command.length > 50 ? "..." : ""),
          })),
      });
    }

    const result: Record<string, unknown> = {
      job_id: job.id,
      status: job.status,
      command: job.command,
      output: job.output,
      started_at: job.startTime.toISOString(),
    };

    if (job.endTime) {
      result.ended_at = job.endTime.toISOString();
      result.duration_seconds = Math.round(
        (job.endTime.getTime() - job.startTime.getTime()) / 1000,
      );
    }

    if (job.exitCode !== null) {
      result.exit_code = job.exitCode;
    }

    if (job.error) {
      result.error = job.error;
    }

    if (waitedFor) {
      result.waited =
        waitedFor === "ended"
          ? "waited: the job ended"
          : `waited ${waited} s: the job is still running`;
    }

    return JSON.stringify(result, null, 2);
  },
};
