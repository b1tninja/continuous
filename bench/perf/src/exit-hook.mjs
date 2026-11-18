// Preloaded into the measured process (node --import). On exit it appends one
// JSON line with the process's memory and CPU figures to $PERF_EXIT_FILE.
import { appendFileSync } from "node:fs";

const file = process.env.PERF_EXIT_FILE;
if (file) {
  process.on("exit", () => {
    try {
      const memory = process.memoryUsage();
      const cpu = process.cpuUsage();
      appendFileSync(
        file,
        JSON.stringify({
          rss: memory.rss,
          heapUsed: memory.heapUsed,
          maxRSSkB: process.resourceUsage().maxRSS,
          uptimeMs: Math.round(process.uptime() * 1000),
          userCpuMs: Math.round(cpu.user / 1000),
          sysCpuMs: Math.round(cpu.system / 1000),
        }) + "\n",
      );
    } catch {
      // measuring must never change the exit code
    }
  });
}
