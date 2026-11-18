import type { ChildProcess } from "node:child_process";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandExecutor } from "./commandExecutor";
import { createCanaries, lanAddress, runProbes } from "./escapeProbeRunner";
import {
  COMMON_PROBES,
  PROBE_VARIABLES,
  renderProbe,
  shellQuote,
  summarizeProbes,
  type Probe,
  type ProbeResult,
} from "./escapeProbes";
import { getCommandExecutor } from "./commandExecutor";

const FULL_VARS = Object.fromEntries(
  PROBE_VARIABLES.map((v) => [v, `/value/of/${v}`]),
);

const bashAvailable = (() => {
  try {
    const r = spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8" });
    return r.status === 0 && r.stdout.trim() === "ok";
  } catch {
    return false;
  }
})();

describe("the probe definitions", () => {
  it("have unique ids, and every id names its property", () => {
    const ids = COMMON_PROBES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of COMMON_PROBES) {
      expect(p.id.length).toBeGreaterThan(3);
      expect(p.description.length).toBeGreaterThan(10);
    }
  });

  it("cover every property the plan names", () => {
    const props = new Set(COMMON_PROBES.map((p) => p.property));
    for (const want of [
      "write-scope",
      "host-executed-files",
      "read-scope",
      "environment",
      "processes",
      "privilege",
      "network",
    ]) {
      expect(props.has(want as never), want).toBe(true);
    }
  });

  it("use only known variables, and render completely with the full set", () => {
    for (const p of COMMON_PROBES) {
      const used = [...p.script.matchAll(/\{\{([A-Za-z.]+)\}\}/g)].map(
        (m) => m[1],
      );
      for (const u of used)
        expect(PROBE_VARIABLES as readonly string[], `${p.id} ${u}`).toContain(
          u,
        );
      const r = renderProbe(p, FULL_VARS);
      expect(r, p.id).toHaveProperty("command");
      expect((r as { command: string }).command).not.toContain("{{");
      expect((r as { command: string }).command).toContain(`: probe ${p.id}`);
    }
  });

  it("report what is missing instead of running with an empty value", () => {
    const p = COMMON_PROBES.find((x) => x.id === "network.host-lan-address")!;
    expect(renderProbe(p, { "canary.port": "1" })).toEqual({
      missing: ["canary.lanHost"],
    });
  });

  it("end every script in a verdict call, and never do anything destructive", () => {
    for (const p of COMMON_PROBES) {
      expect(p.script.trimEnd().split("\n").pop(), p.id).toMatch(
        /probe_(pass|skip)$/,
      );
      expect(p.script, p.id).not.toMatch(/rm\s+-[a-z]*r/);
      expect(p.script, p.id).not.toMatch(/>\s*\/(proc|sys)\//);
      expect(p.script, p.id).not.toMatch(
        /\bmount\b|\bchmod\b|\bchown\b|\bkill\b/,
      );
    }
  });

  it.skipIf(!bashAvailable)("are valid bash", () => {
    for (const p of COMMON_PROBES) {
      const r = renderProbe(p, FULL_VARS) as { command: string };
      const syntax = spawnSync("bash", ["-n"], {
        input: r.command,
        encoding: "utf8",
      });
      expect(syntax.status, `${p.id}: ${syntax.stderr}`).toBe(0);
    }
  });
});

describe("shellQuote", () => {
  it("quotes any value as one word", () => {
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("$(rm -rf /)")).toBe("'$(rm -rf /)'");
    expect(shellQuote("")).toBe("''");
  });

  it.skipIf(!bashAvailable)("round-trips through bash", () => {
    const value = `a 'b' "c" $d \`e\` \\f ;g`;
    const r = spawnSync("bash", ["-c", `printf %s ${shellQuote(value)}`], {
      encoding: "utf8",
    });
    expect(r.stdout).toBe(value);
  });
});

describe("summarizeProbes", () => {
  const r = (
    property: ProbeResult["property"],
    verdict: ProbeResult["verdict"],
    weak = false,
  ): ProbeResult => ({ id: "x", property, verdict, weak, evidence: "" });

  it("is violated by any failure", () => {
    expect(
      summarizeProbes([r("network", "pass"), r("network", "fail")]),
    ).toEqual({
      network: "violated",
    });
  });

  it("is verified by strong passes with only skips beside them", () => {
    expect(
      summarizeProbes([r("privilege", "pass"), r("privilege", "skip")]),
    ).toEqual({
      privilege: "verified",
    });
  });

  it("is not verified by weak passes, skips or errors", () => {
    expect(summarizeProbes([r("network", "pass", true)]).network).toBe(
      "unverified",
    );
    expect(summarizeProbes([r("network", "skip")]).network).toBe("unverified");
    expect(
      summarizeProbes([r("network", "pass"), r("network", "error")]).network,
    ).toBe("unverified");
  });

  it("leaves out a property with no probe", () => {
    expect(summarizeProbes([])).toEqual({});
  });
});

// ------------------------------------------------------------------ the runner

type Script = (command: string) => string | Error | "hang";

/** An executor that never starts a process: its output comes from `script`. */
function fakeExecutor(
  script: Script,
  over: Partial<CommandExecutor> = {},
  delayMs = 0,
): {
  executor: CommandExecutor;
  spawned: { command: string; cwd?: unknown; env?: unknown }[];
} {
  const spawned: { command: string; cwd?: unknown; env?: unknown }[] = [];
  const executor: CommandExecutor = {
    kind: "container",
    shell: {
      kind: "bash",
      executable: "docker",
      args: () => [],
      runsProfile: false,
    },
    invocation: () => ({ shell: "docker", args: [] }),
    describe: () => "a fake",
    spawn: async (command, options) => {
      spawned.push({ command, cwd: options?.cwd, env: options?.env });
      const child = new EventEmitter() as ChildProcess;
      const stdout = new PassThrough();
      (child as { stdout: unknown }).stdout = stdout;
      (child as { stderr: unknown }).stderr = new PassThrough();
      let closed = false;
      const close = (code: number | null) => {
        if (closed) return;
        closed = true;
        stdout.end();
        setImmediate(() => child.emit("close", code));
      };
      (child as { kill: () => boolean }).kill = () => {
        close(null);
        return true;
      };
      const out = script(command);
      if (out === "hang") return child;
      setTimeout(() => {
        if (out instanceof Error) child.emit("error", out);
        else {
          stdout.write(out);
          close(0);
        }
      }, delayMs);
      return child;
    },
    ...over,
  };
  return { executor, spawned };
}

const probeNamed = (id: string): Probe =>
  COMMON_PROBES.find((p) => p.id === id)!;
const ids = (...names: string[]) => names;

describe("runProbes", () => {
  let cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const c of cleanup) await c();
    cleanup = [];
  });
  const canaries = async (listener = false) => {
    const c = await createCanaries({ listener });
    cleanup.push(c.remove);
    return c;
  };

  it("runs each probe from the workspace with the canary in the environment, and reads the verdict", async () => {
    const c = await canaries();
    const { executor, spawned } = fakeExecutor((cmd) =>
      cmd.includes(": probe write.etc")
        ? "created /etc/x\nPROBE:fail\n"
        : "PROBE:pass\n",
    );
    const results = await runProbes(executor, COMMON_PROBES, {
      cwd: "/work/space",
      canaries: c,
      env: { PATH: "/bin" },
      only: ids("write.etc", "write.usr-local"),
    });
    expect(results.map((r) => [r.id, r.verdict])).toEqual([
      ["write.etc", "fail"],
      ["write.usr-local", "pass"],
    ]);
    expect(results[0].evidence).toBe("created /etc/x");
    expect(spawned).toHaveLength(2);
    expect(spawned[0].cwd).toBe("/work/space");
    expect(spawned[0].env).toEqual({
      PATH: "/bin",
      PROBE_SECRET: c.env.PROBE_SECRET,
    });
  });

  it("fails closed when the executor is unavailable: every probe is an error and nothing runs", async () => {
    const c = await canaries();
    const { executor, spawned } = fakeExecutor(() => "PROBE:pass\n", {
      unavailable: "docker is not installed",
    });
    const results = await runProbes(executor, COMMON_PROBES, {
      cwd: "/w",
      canaries: c,
    });
    expect(results).toHaveLength(COMMON_PROBES.length);
    expect(
      results.every(
        (r) =>
          r.verdict === "error" && r.evidence === "docker is not installed",
      ),
    ).toBe(true);
    expect(spawned).toHaveLength(0);
  });

  it("skips every probe on a shell that is not bash", async () => {
    const c = await canaries();
    const { executor, spawned } = fakeExecutor(() => "PROBE:pass\n", {
      shell: {
        kind: "powershell",
        executable: "powershell.exe",
        args: () => [],
        runsProfile: false,
      },
    });
    const results = await runProbes(executor, COMMON_PROBES, {
      cwd: "C:\\w",
      canaries: c,
    });
    expect(results.every((r) => r.verdict === "skip")).toBe(true);
    expect(spawned).toHaveLength(0);
  });

  it("makes no verdict an error, and reads the last verdict line", async () => {
    const c = await canaries();
    const { executor } = fakeExecutor((cmd) =>
      cmd.includes(": probe write.etc")
        ? "oops\n"
        : "PROBE:pass\nnoise\nPROBE:fail\n",
    );
    const [a, b] = await runProbes(executor, COMMON_PROBES, {
      cwd: "/w",
      canaries: c,
      only: ids("write.etc", "write.usr-local"),
    });
    expect(a).toMatchObject({ verdict: "error" });
    expect(a.evidence).toContain("no verdict");
    expect(b.verdict).toBe("fail");
  });

  it("reports a process that cannot start and one that hangs", async () => {
    const c = await canaries();
    const { executor } = fakeExecutor((cmd) =>
      cmd.includes(": probe write.etc")
        ? new Error("spawn docker ENOENT")
        : "hang",
    );
    const [a, b] = await runProbes(executor, COMMON_PROBES, {
      cwd: "/w",
      canaries: c,
      timeoutMs: 50,
      only: ids("write.etc", "write.usr-local"),
    });
    expect(a).toMatchObject({ verdict: "error" });
    expect(a.evidence).toContain("ENOENT");
    expect(b).toMatchObject({ verdict: "error", evidence: "timed out" });
  });

  it("skips a probe whose canary was not made", async () => {
    const c = await canaries(false);
    const { executor, spawned } = fakeExecutor(() => "PROBE:pass\n");
    const [r] = await runProbes(executor, COMMON_PROBES, {
      cwd: "/w",
      canaries: c,
      only: ids("network.host-lan-address"),
    });
    expect(r.verdict).toBe("skip");
    expect(r.evidence).toContain("canary.port");
    expect(spawned).toHaveLength(0);
  });

  it("lets the listener's count overrule a script that said pass", async () => {
    const c = await canaries(true);
    const port = Number(c.vars["canary.port"]);
    const { executor } = fakeExecutor(
      (cmd) => {
        if (cmd.includes(": probe network.host-loopback")) {
          // something reaches the listener while the script reports a pass
          const s = connect(port, "127.0.0.1");
          s.on("error", () => {});
          s.on("connect", () => s.destroy());
        }
        return "PROBE:pass\n";
      },
      {},
      150,
    );
    const [reached, quiet] = await runProbes(executor, COMMON_PROBES, {
      cwd: "/w",
      canaries: c,
      only: ids("network.host-loopback", "network.host-lan-address"),
    });
    expect(reached.verdict).toBe("fail");
    expect(reached.evidence).toContain("canary listener saw 1 connection");
    // a probe that sees no connection keeps its own verdict (the LAN probe
    // needs a LAN address; without one it is skipped)
    expect(["pass", "skip"]).toContain(quiet.verdict);
  });

  it("stops when aborted", async () => {
    const c = await canaries();
    const ac = new AbortController();
    ac.abort();
    const { executor, spawned } = fakeExecutor(() => "PROBE:pass\n");
    const [r] = await runProbes(executor, COMMON_PROBES, {
      cwd: "/w",
      canaries: c,
      signal: ac.signal,
      only: ids("write.etc"),
    });
    expect(r).toMatchObject({ verdict: "error", evidence: "aborted" });
    expect(spawned).toHaveLength(0);
  });

  it("marks weak probes in the result", async () => {
    const c = await canaries();
    const { executor } = fakeExecutor(() => "PROBE:pass\n");
    const rs = await runProbes(executor, COMMON_PROBES, {
      cwd: "/w",
      canaries: c,
      only: ids("network.dns", "write.etc"),
    });
    expect(rs.map((r) => r.weak)).toEqual([false, true]);
    expect(probeNamed("network.dns").weak).toBe(true);
  });
});

describe("createCanaries", () => {
  it("makes the canary files with a marker that is in none of the scripts, and removes them", async () => {
    const parent = mkdtempSync(join(tmpdir(), "probe-test-"));
    try {
      const c = await createCanaries({
        parent,
        random: (() => {
          let n = 0;
          return () => `MARK${++n}`;
        })(),
      });
      expect(c.vars["canary.key"]).toBe("MARK1");
      expect(c.env).toEqual({ PROBE_SECRET: "MARK2" });
      for (const name of [
        "canary.ssh",
        "canary.aws",
        "canary.continuousEnv",
        "canary.parentEnv",
      ] as const) {
        expect(existsSync(c.vars[name]!), name).toBe(true);
      }
      expect(c.hits()).toBeUndefined();
      expect(c.vars["canary.port"]).toBeUndefined();
      expect(readdirSync(parent)).toHaveLength(1);
      await c.remove();
      expect(readdirSync(parent)).toHaveLength(0);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("starts a listener that counts connections", async () => {
    const c = await createCanaries({ listener: true });
    try {
      expect(c.hits()).toBe(0);
      await new Promise<void>((resolve) => {
        const s = connect(Number(c.vars["canary.port"]), "127.0.0.1", () =>
          s.destroy(),
        );
        s.on("close", () => resolve());
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(c.hits()).toBe(1);
    } finally {
      await c.remove();
    }
  });
});

describe("lanAddress", () => {
  it("is the first external IPv4 address", () => {
    expect(
      lanAddress({
        lo: [{ family: "IPv4", internal: true, address: "127.0.0.1" } as never],
        eth0: [
          { family: "IPv6", internal: false, address: "fe80::1" } as never,
          { family: "IPv4", internal: false, address: "192.168.1.5" } as never,
        ],
      }),
    ).toBe("192.168.1.5");
    expect(lanAddress({})).toBeUndefined();
  });
});

// A real run on a POSIX host: the local executor is not a jail, so the probes
// must find it open. This proves the scripts run, report, and clean up.
describe.skipIf(process.platform === "win32" || !bashAvailable)(
  "the probes against this machine's own shell",
  () => {
    it("finds the host open, and leaves nothing behind", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "probe-ws-"));
      const c = await createCanaries();
      try {
        const executor = getCommandExecutor({
          platform: process.platform,
          env: { SHELL: "/bin/bash" },
        });
        const results = await runProbes(executor, COMMON_PROBES, {
          cwd,
          canaries: c,
          timeoutMs: 20_000,
          only: ids(
            "write.host-canary-dir",
            "write.parent-of-workspace",
            "write.hardlink-out",
            "host-files.writable",
            "read.canary-files",
            "env.host-secret",
          ),
        });
        const byId = Object.fromEntries(results.map((r) => [r.id, r]));
        expect(byId["write.host-canary-dir"].verdict).toBe("fail");
        expect(byId["write.parent-of-workspace"].verdict).toBe("fail");
        expect(byId["host-files.writable"].verdict).toBe("fail");
        expect(byId["host-files.writable"].evidence).toContain(".mcp.json");
        expect(byId["read.canary-files"].verdict).toBe("fail");
        expect(byId["env.host-secret"].verdict).toBe("fail");
        // the canary value itself is never printed
        for (const r of results)
          expect(r.evidence).not.toContain(c.vars["canary.key"]);
        expect(readdirSync(cwd)).toEqual([]);
        expect(readdirSync(c.vars["canary.dir"]!)).toEqual([]);
      } finally {
        await c.remove();
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  },
);
