import { BackgroundJobService } from "./BackgroundJobService.js";

/**
 * waitForJob: a caller waits for a background job to end without polling.
 * Every way a job ends (exit, failure, cancel, kill all) answers it.
 */
describe("BackgroundJobService.waitForJob", () => {
  let service: BackgroundJobService;

  beforeEach(() => {
    service = new BackgroundJobService();
  });

  function running() {
    const job = service.createJob("sleep 1");
    if (!job) throw new Error("no job");
    job.status = "running";
    return job;
  }

  it("resolves true at once for a job that has ended", async () => {
    const job = running();
    service.completeJob(job.id, 0);
    const started = Date.now();
    expect(await service.waitForJob(job.id, 5000)).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("resolves false for a job that does not exist, without waiting", async () => {
    const started = Date.now();
    expect(await service.waitForJob("bg-nope", 5000)).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("resolves true as soon as the job completes", async () => {
    const job = running();
    const started = Date.now();
    const waiting = service.waitForJob(job.id, 10_000);
    setTimeout(() => service.completeJob(job.id, 0), 50);
    expect(await waiting).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("is answered when the job fails", async () => {
    const job = running();
    const waiting = service.waitForJob(job.id, 10_000);
    setTimeout(() => service.failJob(job.id, "boom"), 30);
    expect(await waiting).toBe(true);
    expect(job.status).toBe("failed");
  });

  it("is answered when the job is cancelled", async () => {
    const job = running();
    const waiting = service.waitForJob(job.id, 10_000);
    setTimeout(() => service.cancelJob(job.id), 30);
    expect(await waiting).toBe(true);
    expect(job.status).toBe("cancelled");
  });

  it("is answered when every job is killed", async () => {
    const job = running();
    const waiting = service.waitForJob(job.id, 10_000);
    // killAllJobs ends the jobs that have a process; give this one a stand-in
    (
      service as unknown as { processes: Map<string, { kill: () => void }> }
    ).processes.set(job.id, { kill: () => undefined });
    setTimeout(() => service.killAllJobs(), 30);
    expect(await waiting).toBe(true);
    expect(job.status).toBe("cancelled");
  });

  it("resolves false when the time runs out, and the job is still running", async () => {
    const job = running();
    const started = Date.now();
    expect(await service.waitForJob(job.id, 80)).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);
    expect(job.status).toBe("running");
  });

  it("does not wait for zero, negative or invalid times", async () => {
    const job = running();
    for (const ms of [0, -1, Number.NaN]) {
      const started = Date.now();
      expect(await service.waitForJob(job.id, ms), String(ms)).toBe(false);
      expect(Date.now() - started).toBeLessThan(200);
    }
  });

  it("answers every waiter, and a timed-out waiter does not block the others", async () => {
    const job = running();
    const short = service.waitForJob(job.id, 40);
    const a = service.waitForJob(job.id, 5000);
    const b = service.waitForJob(job.id, 5000);
    expect(await short).toBe(false);
    service.completeJob(job.id, 0);
    expect(await Promise.all([a, b])).toEqual([true, true]);
  });
});
