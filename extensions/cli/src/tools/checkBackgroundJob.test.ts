import { services } from "../services/index.js";

import {
  checkBackgroundJobTool,
  clampWaitSeconds,
  MAX_WAIT_SECONDS,
} from "./checkBackgroundJob.js";

describe("clampWaitSeconds", () => {
  it("is zero for anything that is not a positive number", () => {
    for (const v of [
      undefined,
      null,
      0,
      -1,
      "abc",
      NaN,
      Infinity,
      {},
      true,
      "",
    ]) {
      expect(clampWaitSeconds(v), String(v)).toBe(0);
    }
  });

  it("is a whole number of seconds, at most the maximum", () => {
    expect(clampWaitSeconds(2.9)).toBe(2);
    expect(clampWaitSeconds("5")).toBe(5);
    expect(clampWaitSeconds(MAX_WAIT_SECONDS + 1)).toBe(MAX_WAIT_SECONDS);
    expect(clampWaitSeconds(1e9)).toBe(MAX_WAIT_SECONDS);
  });
});

describe("CheckBackgroundJob wait_seconds", () => {
  const jobs = () => services.backgroundJobs;

  afterEach(() => {
    jobs().killAllJobs();
  });

  function running() {
    const job = jobs().createJob("sleep 1");
    if (!job) throw new Error("no job");
    job.status = "running";
    return job;
  }

  it("returns the finished job when it ends during the wait", async () => {
    const job = running();
    setTimeout(() => jobs().completeJob(job.id, 0), 60);
    const out = JSON.parse(
      await checkBackgroundJobTool.run({ job_id: job.id, wait_seconds: 10 }),
    );
    expect(out.status).toBe("completed");
    expect(out.exit_code).toBe(0);
    expect(out.waited).toBe("waited: the job ended");
  });

  it("says the job is still running when the wait runs out", async () => {
    const job = running();
    const out = JSON.parse(
      await checkBackgroundJobTool.run({ job_id: job.id, wait_seconds: 1 }),
    );
    expect(out.status).toBe("running");
    expect(out.waited).toBe("waited 1 s: the job is still running");
  });

  it("reads at once without wait_seconds, and says nothing about waiting", async () => {
    const job = running();
    const started = Date.now();
    const out = JSON.parse(
      await checkBackgroundJobTool.run({ job_id: job.id }),
    );
    expect(Date.now() - started).toBeLessThan(500);
    expect(out.waited).toBeUndefined();
    expect(out.status).toBe("running");
  });

  it("reports an unknown job without waiting", async () => {
    const started = Date.now();
    const out = JSON.parse(
      await checkBackgroundJobTool.run({ job_id: "bg-nope", wait_seconds: 30 }),
    );
    expect(Date.now() - started).toBeLessThan(500);
    expect(out.error).toContain("not found");
  });

  it("wait_seconds is an optional number appended after job_id", () => {
    const params = checkBackgroundJobTool.parameters as {
      required: string[];
      properties: Record<string, { type: string }>;
    };
    expect(params.required).toEqual(["job_id"]);
    expect(Object.keys(params.properties)).toEqual(["job_id", "wait_seconds"]);
    expect(params.properties.wait_seconds.type).toBe("number");
  });
});
