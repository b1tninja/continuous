import type { ChildProcess } from "child_process";

import { getCommandExecutor } from "core/util/commandExecutor.js";
import {
  COMMAND_STDIO,
  commandEnvironment,
  spawnAgentCommand,
} from "core/util/commandSpawn.js";
import { terminalEnvironment } from "core/util/terminalEnvironment.js";

import { shellChildEnv } from "../childEnv.js";
import { logger } from "../util/logger.js";

export type BackgroundJobStatus =
  "pending" | "running" | "completed" | "failed" | "cancelled";

export interface BackgroundJob {
  id: string;
  status: BackgroundJobStatus;
  command: string;
  output: string;
  exitCode: number | null;
  startTime: Date;
  endTime: Date | null;
  error?: string;
}

const MAX_CONCURRENT_JOBS = 5;
const MAX_OUTPUT_LINES = 1000;

/**
 * Service for managing background job execution and lifecycle
 * Handles spawning, tracking, and cleanup of background processes
 */
export class BackgroundJobService {
  private jobs: Map<string, BackgroundJob> = new Map();
  private processes: Map<string, ChildProcess> = new Map();
  private jobCounter = 0;
  /** Callers waiting for a job to end; every way a job ends answers them. */
  private endWaiters: Map<string, Array<() => void>> = new Map();

  createJob(command: string): BackgroundJob | null {
    const runningCount = this.getRunningJobCount();
    if (runningCount >= MAX_CONCURRENT_JOBS) {
      logger.warn(
        `Cannot create background job: limit of ${MAX_CONCURRENT_JOBS} reached`,
      );
      return null;
    }

    const id = `bg-${++this.jobCounter}-${Date.now()}`;
    const job: BackgroundJob = {
      id,
      status: "pending",
      command,
      output: "",
      exitCode: null,
      startTime: new Date(),
      endTime: null,
    };

    this.jobs.set(id, job);
    return job;
  }

  /**
   * Starts the job's command through the command executor, the same place a
   * Bash call runs. Null when the job is not there or its shell could not
   * start (the job is then failed with the reason).
   */
  async startJob(jobId: string): Promise<ChildProcess | null> {
    const job = this.jobs.get(jobId);
    if (!job) {
      logger.error(`Cannot start job ${jobId}: job not found`);
      return null;
    }

    job.status = "running";

    let child: ChildProcess;
    try {
      child = await spawnAgentCommand(getCommandExecutor(), job.command, {
        // Output is piped; standard input is not left open (a prompt must fail)
        stdio: COMMAND_STDIO,
        env: commandEnvironment(terminalEnvironment(shellChildEnv())),
      });
    } catch (error) {
      this.failJob(
        jobId,
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
    this.processes.set(jobId, child);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (data: string) => {
      this.appendOutput(jobId, data);
    });

    child.stderr?.on("data", (data: string) => {
      this.appendOutput(jobId, data);
    });

    child.on("close", (code: number | null) => {
      this.completeJob(jobId, code ?? 0);
    });

    child.on("error", (error: Error) => {
      this.failJob(jobId, error.message);
    });

    return child;
  }

  createJobWithProcess(
    command: string,
    child: ChildProcess,
    existingOutput: string = "",
  ): BackgroundJob | null {
    const runningCount = this.getRunningJobCount();
    if (runningCount >= MAX_CONCURRENT_JOBS) {
      logger.warn(
        `Cannot create background job: limit of ${MAX_CONCURRENT_JOBS} reached`,
      );
      return null;
    }

    const id = `bg-${++this.jobCounter}-${Date.now()}`;
    const job: BackgroundJob = {
      id,
      status: "running",
      command,
      output: existingOutput,
      exitCode: null,
      startTime: new Date(),
      endTime: null,
    };

    this.jobs.set(id, job);
    this.processes.set(id, child);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (data: string) => {
      this.appendOutput(id, data);
    });

    child.stderr?.on("data", (data: string) => {
      this.appendOutput(id, data);
    });

    child.on("close", (code: number | null) => {
      this.completeJob(id, code ?? 0);
    });

    child.on("error", (error: Error) => {
      this.failJob(id, error.message);
    });

    return job;
  }

  // todo: improve write efficiency with ring buffer or similar
  appendOutput(jobId: string, data: string): void {
    const job = this.jobs.get(jobId);
    if (job) {
      job.output += data;
      const lines = job.output.split("\n");
      if (lines.length > MAX_OUTPUT_LINES) {
        job.output = lines.slice(-MAX_OUTPUT_LINES).join("\n");
      }
    }
  }

  completeJob(jobId: string, exitCode: number): void {
    const job = this.jobs.get(jobId);
    if (job) {
      if (job.status === "cancelled") {
        return;
      }
      job.status = exitCode === 0 ? "completed" : "failed";
      job.exitCode = exitCode;
      job.endTime = new Date();
      this.processes.delete(jobId);
      this.notifyEnded(jobId);
    }
  }

  failJob(jobId: string, error: string): void {
    const job = this.jobs.get(jobId);
    if (job) {
      job.status = "failed";
      job.error = error;
      job.endTime = new Date();
      this.processes.delete(jobId);
      this.notifyEnded(jobId);
    }
  }

  cancelJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    const process = this.processes.get(jobId);

    if (!job) return false;

    if (process) {
      process.kill();
      this.processes.delete(jobId);
    }

    job.status = "cancelled";
    job.endTime = new Date();
    this.notifyEnded(jobId);
    return true;
  }

  /**
   * Waits for a job to end, for at most `ms`. Resolves true when it has ended
   * (at once when it already had) and false when the time ran out or the job
   * does not exist. It waits on the end itself, so it does not poll.
   */
  waitForJob(jobId: string, ms: number): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job) return Promise.resolve(false);
    if (job.status !== "running" && job.status !== "pending") {
      return Promise.resolve(true);
    }
    if (!(ms > 0)) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const wake = () => {
        if (timer) clearTimeout(timer);
        resolve(true);
      };
      this.endWaiters.set(jobId, [...(this.endWaiters.get(jobId) ?? []), wake]);
      timer = setTimeout(() => {
        const rest = (this.endWaiters.get(jobId) ?? []).filter(
          (w) => w !== wake,
        );
        if (rest.length) this.endWaiters.set(jobId, rest);
        else this.endWaiters.delete(jobId);
        resolve(false);
      }, ms);
    });
  }

  private notifyEnded(jobId: string): void {
    const waiting = this.endWaiters.get(jobId);
    if (!waiting) return;
    this.endWaiters.delete(jobId);
    for (const wake of waiting) wake();
  }

  getJob(jobId: string): BackgroundJob | undefined {
    return this.jobs.get(jobId);
  }

  getRunningJobs(): BackgroundJob[] {
    return Array.from(this.jobs.values()).filter(
      (job) => job.status === "running" || job.status === "pending",
    );
  }

  getAllJobs(): BackgroundJob[] {
    return Array.from(this.jobs.values());
  }

  getRunningJobCount(): number {
    return this.getRunningJobs().length;
  }

  killAllJobs(): void {
    for (const [jobId, process] of this.processes) {
      process.kill();
      const job = this.jobs.get(jobId);
      if (job) {
        job.status = "cancelled";
        job.endTime = new Date();
        this.notifyEnded(jobId);
      }
    }
    this.processes.clear();
  }
}

export const backgroundJobService = new BackgroundJobService();
