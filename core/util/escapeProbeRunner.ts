import { randomBytes } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandExecutor } from "./commandExecutor";
import {
  renderProbe,
  type Probe,
  type ProbeResult,
  type ProbeVariable,
} from "./escapeProbes";
import { isPosixShell } from "./shell";

/**
 * Runs the probes of `escapeProbes.ts` through a `CommandExecutor`
 * (plans/jail-network.md, W7a). Nothing in the product calls this yet: it is
 * the harness the backends' tests and the "Verify this jail" action will use.
 *
 * The harness makes the canaries on the host, so a probe that can see one has
 * escaped by definition: fake credential files with a random marker, a folder
 * that exists only on the host, an environment value, and a listener on the
 * host's addresses that counts connections. The runner does not run anything
 * against a backend by itself; the caller passes the executor.
 */
export interface Canaries {
  /** The folder that holds every canary file; remove it with `remove()` */
  root: string;
  /** What the probe scripts substitute for `{{canary.*}}` */
  vars: Partial<Record<ProbeVariable, string>>;
  /** The name and value the runner puts in the executor's environment */
  env: Record<string, string>;
  /** Connections the listener has seen; undefined without a listener */
  hits(): number | undefined;
  remove(): Promise<void>;
}

export interface CreateCanariesOptions {
  /** Where to make the folder; the temp directory by default */
  parent?: string;
  /** Start the listener probes use. Needs the sockets of this machine. */
  listener?: boolean;
  /** For tests: the marker generator */
  random?: () => string;
}

const marker = () => `PROBE-CANARY-${randomBytes(12).toString("hex")}`;

/** The first non-internal IPv4 address of this machine, if it has one. */
export function lanAddress(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string | undefined {
  for (const list of Object.values(interfaces)) {
    for (const i of list ?? []) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  return undefined;
}

export async function createCanaries(
  opts: CreateCanariesOptions = {},
): Promise<Canaries> {
  const random = opts.random ?? marker;
  const root = mkdtempSync(join(opts.parent ?? tmpdir(), "probe-canary-"));
  const key = random();
  const envValue = random();
  const home = join(root, "home");
  const put = (path: string) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `${key}\n`);
    return path;
  };
  const dir = join(root, "writable");
  mkdirSync(dir, { recursive: true });
  const vars: Canaries["vars"] = {
    "canary.dir": dir,
    "canary.ssh": put(join(home, ".ssh", "id_probe")),
    "canary.aws": put(join(home, ".aws", "credentials")),
    "canary.continuousEnv": put(join(home, ".continuous", ".env")),
    "canary.parentEnv": put(join(root, ".env")),
    "canary.key": key,
    "canary.envValue": envValue,
  };

  let server: Server | undefined;
  let hits = 0;
  if (opts.listener) {
    server = createServer((socket) => {
      hits++;
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      // All interfaces, so a probe on the LAN address and one through a
      // container gateway can both reach it if the jail lets them
      server!.listen(0, "0.0.0.0", resolve);
    });
    const address = server.address();
    if (address && typeof address === "object") {
      vars["canary.port"] = String(address.port);
    }
    const lan = lanAddress();
    if (lan) vars["canary.lanHost"] = lan;
  }

  return {
    root,
    vars,
    env: { PROBE_SECRET: envValue },
    hits: () => (server ? hits : undefined),
    remove: async () => {
      if (server) await new Promise<void>((r) => server!.close(() => r()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export interface RunProbesOptions {
  /** The workspace folder: where every probe starts */
  cwd: string;
  canaries: Canaries;
  /** Per probe; 90 seconds by default (the file scan can take a minute) */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** The environment the executor is given; the process's own by default */
  env?: Record<string, string | undefined>;
  /** Run only these probe ids */
  only?: readonly string[];
}

const MARKER_LINE = /^PROBE:(pass|fail|skip)\s*$/;
const MAX_EVIDENCE = 500;

function collect(
  child: ChildProcess,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ out: string; code: number | null; reason?: string }> {
  return new Promise((resolve) => {
    let out = "";
    let reason: string | undefined;
    const add = (d: unknown) => {
      if (out.length < 100_000) out += String(d);
    };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    const stop = (why: string) => {
      reason ??= why;
      child.kill();
    };
    const timer = setTimeout(() => stop("timed out"), timeoutMs);
    const onAbort = () => stop("aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = (code: number | null) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ out, code, reason });
    };
    child.on("error", (e) => {
      reason ??= `could not start: ${e.message}`;
      done(null);
    });
    child.on("close", done);
  });
}

/**
 * Runs the probes one after another and returns one result each. Failures to
 * run are results (`error`), never exceptions, and an executor that is not
 * available fails closed: every probe is an error and nothing runs.
 */
export async function runProbes(
  executor: CommandExecutor,
  probes: readonly Probe[],
  opts: RunProbesOptions,
): Promise<ProbeResult[]> {
  const selected = opts.only
    ? probes.filter((p) => opts.only!.includes(p.id))
    : probes;
  const result = (
    p: Probe,
    verdict: ProbeResult["verdict"],
    evidence: string,
  ): ProbeResult => ({
    id: p.id,
    property: p.property,
    verdict,
    weak: !!p.weak,
    evidence: evidence.slice(0, MAX_EVIDENCE),
  });

  if (executor.unavailable) {
    return selected.map((p) => result(p, "error", executor.unavailable!));
  }
  if (!isPosixShell(executor.shell.kind)) {
    return selected.map((p) =>
      result(
        p,
        "skip",
        `the probes are bash scripts; this executor runs ${executor.shell.kind}`,
      ),
    );
  }

  const results: ProbeResult[] = [];
  for (const probe of selected) {
    if (opts.signal?.aborted) {
      results.push(result(probe, "error", "aborted"));
      continue;
    }
    const rendered = renderProbe(probe, opts.canaries.vars);
    if ("missing" in rendered) {
      results.push(
        result(probe, "skip", `needs ${rendered.missing.join(", ")}`),
      );
      continue;
    }
    const before = opts.canaries.hits();
    let child: ChildProcess;
    try {
      child = await executor.spawn(rendered.command, {
        cwd: opts.cwd,
        env: { ...(opts.env ?? process.env), ...opts.canaries.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      // As collect reports a process that emits "error" on start
      const why = error instanceof Error ? error.message : String(error);
      results.push(result(probe, "error", `could not start: ${why}`));
      continue;
    }
    const { out, code, reason } = await collect(
      child,
      opts.timeoutMs ?? 90_000,
      opts.signal,
    );
    if (reason) {
      results.push(result(probe, "error", reason));
      continue;
    }
    const lines = out.split(/\r?\n/);
    const verdictLine = [...lines].reverse().find((l) => MARKER_LINE.test(l));
    const evidence = lines
      .filter((l) => l.trim() && !MARKER_LINE.test(l))
      .join("\n");
    if (!verdictLine) {
      results.push(
        result(probe, "error", `no verdict (exit ${code}): ${evidence}`),
      );
      continue;
    }
    let verdict = MARKER_LINE.exec(verdictLine)![1] as ProbeResult["verdict"];
    let why = evidence;
    // The listener's own count wins over the script's word
    if (probe.usesListener && before !== undefined) {
      const after = opts.canaries.hits();
      if (after !== undefined && after > before && verdict !== "fail") {
        verdict = "fail";
        why =
          `${why}\nthe canary listener saw ${after - before} connection(s)`.trim();
      }
    }
    results.push(result(probe, verdict, why));
  }
  return results;
}
