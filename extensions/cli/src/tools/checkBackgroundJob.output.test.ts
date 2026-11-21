import { services } from "../services/index.js";

import { checkBackgroundJobTool } from "./checkBackgroundJob.js";

const ESC = "\u001b";

/**
 * A background job keeps the output as the program wrote it. What the model
 * reads from CheckBackgroundJob has no terminal escape sequences.
 */
describe("CheckBackgroundJob output and colour", () => {
  const jobs = () => services.backgroundJobs;

  afterEach(() => {
    jobs().killAllJobs();
  });

  function jobWith(output: string) {
    const job = jobs().createJob("sleep 1");
    if (!job) throw new Error("no job");
    job.status = "running";
    job.output = output;
    return job;
  }

  it("returns the output without escape sequences", async () => {
    const job = jobWith(`${ESC}[32mready${ESC}[0m on port 3000\n`);
    const out = JSON.parse(
      await checkBackgroundJobTool.run({ job_id: job.id }),
    );
    expect(out.output).toBe("ready on port 3000\n");
    expect(JSON.stringify(out)).not.toContain("\\u001b");
  });

  it("leaves the stored output as it was written", async () => {
    const raw = `${ESC}[32mready${ESC}[0m\n`;
    const job = jobWith(raw);
    await checkBackgroundJobTool.run({ job_id: job.id });
    expect(jobs().getJob(job.id)?.output).toBe(raw);
  });

  it("leaves plain output alone", async () => {
    const job = jobWith("compiled 12 files\n");
    const out = JSON.parse(
      await checkBackgroundJobTool.run({ job_id: job.id }),
    );
    expect(out.output).toBe("compiled 12 files\n");
  });

  it("still reports the exit code of a finished job", async () => {
    const job = jobWith(`${ESC}[31mfailed${ESC}[0m\n`);
    jobs().completeJob(job.id, 2);
    const out = JSON.parse(
      await checkBackgroundJobTool.run({ job_id: job.id }),
    );
    expect(out.exit_code).toBe(2);
    expect(out.output).toBe("failed\n");
  });
});
