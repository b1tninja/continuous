import { describe, expect, it } from "vitest";
import {
  CONFIG_BASENAMES,
  CONFIG_DIRS,
  CONFIG_DIR_PAIRS,
} from "../tools/permissions/protectedPaths";
import {
  DEFAULT_POLICY_LEVELS,
  POLICY_LEVELS,
  type PolicyLevel,
} from "../tools/permissions/policy";
import type { DecisionSource } from "../tools/permissions/decide";
import {
  compileSandboxConfig,
  describeSandboxPlan,
  sandboxAutoApproval,
  type AreaDecision,
  type SandboxCompileInput,
  type SandboxPlan,
} from "./sandboxPolicy";

const WS = "/home/dev/proj";
const base = (
  over: Partial<SandboxCompileInput> = {},
): SandboxCompileInput => ({
  workspace: WS,
  tempDir: "/tmp/continuous-run-1",
  homeDir: "/home/dev",
  platform: "linux",
  levels: DEFAULT_POLICY_LEVELS,
  ...over,
});

function plan(over: Partial<SandboxCompileInput> = {}): SandboxPlan {
  const r = compileSandboxConfig(base(over));
  if (!r.ok) throw new Error(`expected ok: ${r.reasons.join("; ")}`);
  return r;
}

function failed(over: Partial<SandboxCompileInput> = {}) {
  const r = compileSandboxConfig(base(over));
  if (r.ok) throw new Error("expected a refusal");
  return r;
}

describe("compileSandboxConfig: the default read policy", () => {
  // `open` is the default (ROADMAP piece 14, open decision S9-X3). It is open
  // about everything except what a deputy would go for: the home secrets and our
  // own configuration folders, which hold keys. Changing either is a decision.
  it("defaults to open, and still hides home secrets and our own folders", () => {
    const p = plan();
    expect(p.readPolicy).toBe("open");
    const denied = p.config.filesystem.denyRead;
    for (const d of [
      "/home/dev/.ssh",
      "/home/dev/.aws",
      "/home/dev/.continue",
      "/home/dev/.continuous",
    ]) {
      expect(denied, d).toContain(d);
    }
    // Only the project's plans folders are allowed back (S9-X3)
    expect(p.config.filesystem.allowRead).toEqual([
      `${WS}/.continue/plans`,
      `${WS}/.continuous/plans`,
    ]);
    expect(p.notEnforced.map((n) => n.id)).toContain("open-reads");
  });

  it("workspace-only is what also hides the rest of the home folder", () => {
    const p = plan({ readPolicy: "workspace-only" });
    expect(p.config.filesystem.denyRead).toContain("/home");
  });
});

describe("S9-X3: the decided read policy", () => {
  // With the sandbox on, reads of the policy folders, ~/.ssh, ~/.aws,
  // ~/.config/gh and the OS credential stores are denied, with a short allow
  // list (~/.gitconfig, ~/.npmrc). The workspace-only flip (B76) waits.
  const MAC = {
    platform: "macos" as const,
    workspace: "/Users/dev/proj",
    homeDir: "/Users/dev",
    tempDir: "/var/folders/ab/T/run1",
  };

  it.each([
    ["linux", {}, "/home/dev", WS],
    ["macos", MAC, "/Users/dev", "/Users/dev/proj"],
  ] as const)(
    "%s denies the credential folders and the policy folders, for reads and writes",
    (_name, over, home, ws) => {
      for (const readPolicy of ["open", "workspace-only"] as const) {
        const f = plan({ ...over, readPolicy }).config.filesystem;
        for (const d of [
          `${home}/.ssh`,
          `${home}/.aws`,
          `${home}/.config/gh`,
          `${home}/.continuous`,
          `${home}/.continue`,
          `${ws}/.continuous`,
          `${ws}/.continue`,
        ]) {
          expect(f.denyRead, `${readPolicy} ${d}`).toContain(d);
          expect(f.denyWrite, `${readPolicy} ${d}`).toContain(d);
        }
      }
    },
  );

  it("denies the OS credential stores: Keychains on macOS, the keyrings on Linux and WSL2", () => {
    const mac = plan(MAC).config.filesystem.denyRead;
    expect(mac).toContain("/Users/dev/Library/Keychains");
    expect(mac).not.toContain("/Users/dev/.local/share/keyrings");
    for (const platform of ["linux", "wsl2"] as const) {
      const f = plan({ platform }).config.filesystem.denyRead;
      for (const d of [
        "/home/dev/.local/share/keyrings",
        "/home/dev/.local/share/kwalletd",
        "/home/dev/.password-store",
      ]) {
        expect(f, `${platform} ${d}`).toContain(d);
      }
      expect(f).not.toContain("/home/dev/Library/Keychains");
    }
    // The Windows stores sit under /mnt/c on WSL2, which is denied whole
    expect(plan({ platform: "wsl2" }).config.filesystem.denyRead).toContain(
      "/mnt",
    );
  });

  it("allows reading ~/.gitconfig and ~/.npmrc, and keeps them write-protected", () => {
    for (const readPolicy of ["open", "workspace-only"] as const) {
      const f = plan({ readPolicy }).config.filesystem;
      for (const d of ["/home/dev/.gitconfig", "/home/dev/.npmrc"]) {
        expect(f.denyRead, `${readPolicy} ${d}`).not.toContain(d);
      }
      expect(f.denyWrite).toContain("/home/dev/.npmrc");
    }
    const only = plan({ readPolicy: "workspace-only" }).config.filesystem;
    expect(only.allowRead).toEqual(
      expect.arrayContaining(["/home/dev/.gitconfig", "/home/dev/.npmrc"]),
    );
    // A project .npmrc is still a secret wherever it sits
    expect(plan().config.filesystem.denyRead).toContain(`${WS}/**/.npmrc`);
    expect(plan().notEnforced.map((n) => n.id)).toContain("allowed-home-reads");
  });

  it("keeps the project's plans readable inside the denied policy folders; writes stay protected", () => {
    for (const readPolicy of ["open", "workspace-only"] as const) {
      const f = plan({ readPolicy }).config.filesystem;
      for (const d of [".continue", ".continuous"]) {
        expect(f.denyRead).toContain(`${WS}/${d}`);
        expect(f.allowRead, `${readPolicy} ${d}`).toContain(`${WS}/${d}/plans`);
        expect(f.denyWrite).toContain(`${WS}/${d}`);
        expect(f.allowWrite).not.toContain(`${WS}/${d}/plans`);
      }
    }
  });

  it("a deny rule of the person's on ~/.npmrc is not allowed back", () => {
    const f = plan({
      readPolicy: "workspace-only",
      toolPermissions: { deny: ["readFile(~/.npmrc)"] },
    }).config.filesystem;
    expect(f.denyRead).toContain("/home/dev/.npmrc");
    expect(f.allowRead).not.toContain("/home/dev/.npmrc");
    expect(f.allowRead).toContain("/home/dev/.gitconfig");
  });
});

describe("compileSandboxConfig: shape", () => {
  it("compiles the defaults and never says contained", () => {
    const p = plan();
    expect(p.label).toMatch(/^Confined as configured; contained only after/);
    expect(p.conflicts).toEqual([]);
    expect(p.config.network.strictAllowlist).toBe(true);
    expect(p.config.network.allowLocalBinding).toBe(false);
    expect(p.config.network.allowUnixSockets).toEqual([]);
    expect(p.weakened).toEqual([]);
  });

  it("is deterministic and sorted", () => {
    const input = base({
      extraWritable: ["/srv/b", "/srv/a"],
      egress: { network: "allowlist", allow: ["b.example", "a.example"] },
    });
    const a = compileSandboxConfig(input);
    const b = compileSandboxConfig(JSON.parse(JSON.stringify(input)));
    expect(a).toEqual(b);
    if (!a.ok) throw new Error("ok");
    for (const list of [
      ...Object.values(a.config.filesystem),
      a.config.network.allowedDomains,
    ]) {
      expect(list).toEqual([...list].sort());
    }
  });
});

describe("rule 1: deny rules and secrets become denyRead and denyWrite", () => {
  it("maps a readFile deny to both lists, resolved against the workspace", () => {
    const fsCfg = plan({
      toolPermissions: {
        deny: ["readFile(secrets/**)", "read_file(**/k.txt)"],
      },
    }).config.filesystem;
    for (const e of [`${WS}/secrets/**`, `${WS}/secrets`, `${WS}/**/k.txt`]) {
      expect(fsCfg.denyRead).toContain(e);
      expect(fsCfg.denyWrite).toContain(e);
    }
  });

  it("maps a writeFile deny to denyWrite only", () => {
    const fsCfg = plan({
      toolPermissions: { deny: ["writeFile(docs/*)"] },
    }).config.filesystem;
    expect(fsCfg.denyWrite).toContain(`${WS}/docs/*`);
    expect(fsCfg.denyRead).not.toContain(`${WS}/docs/*`);
  });

  it("hides protected secrets and tags the source", () => {
    const p = plan();
    for (const e of [
      "/home/dev/.ssh",
      "/home/dev/.aws",
      `${WS}/.npmrc`,
      `${WS}/.env`,
      `${WS}/**/id_rsa`,
      `${WS}/**/*.pem`,
      "/etc/shadow",
      "/home/*/.ssh",
    ]) {
      expect(p.config.filesystem.denyRead).toContain(e);
      expect(p.config.filesystem.denyWrite).toContain(e);
    }
    expect(p.config.filesystem.denyRead).not.toContain(`${WS}/.env.example`);
    expect(p.enforced.some((e) => e.source === "protected-secret")).toBe(true);
    expect(p.notEnforced.map((n) => n.id)).toContain("other-env-files");
  });

  it("hides our own home configuration whatever a built-in says", () => {
    const p = plan({ builtin: { "protect-secrets": false } });
    expect(p.config.filesystem.denyRead).toContain("/home/dev/.continuous");
    expect(p.config.filesystem.denyRead).not.toContain("/home/dev/.ssh");
    expect(p.warnings.join(" ")).toContain("protect-secrets is off");
  });

  it("keeps whole-tool, command and MCP deny rules as policy only", () => {
    const p = plan({
      toolPermissions: {
        deny: ["readFile", "runTerminalCommand(rm -rf*)", "mcp__x__y"],
      },
    });
    expect(p.policyOnly).toHaveLength(3);
    expect(p.config.filesystem.denyRead).not.toContain(WS);
  });
});

describe("rule 2: what runs later becomes denyWrite, reads stay open", () => {
  it("covers every protected config name at the root and nested", () => {
    const w = plan().config.filesystem;
    const rels = [
      ...[...CONFIG_DIRS].filter((d) => d !== ".git" && d !== ".yarn"),
      ...CONFIG_DIR_PAIRS.filter(([a]) => a === ".github").map(
        ([a, b]) => `${a}/${b}`,
      ),
    ];
    for (const r of rels) {
      expect(w.denyWrite).toContain(`${WS}/${r}`);
      expect(w.denyWrite).toContain(`${WS}/**/${r}`);
    }
    const canon: Record<string, string> = { jenkinsfile: "Jenkinsfile" };
    for (const b of CONFIG_BASENAMES) {
      expect(w.denyWrite).toContain(`${WS}/${canon[b] ?? b}`);
    }
    expect(w.denyRead).not.toContain(`${WS}/.envrc`);
    expect(w.denyRead).not.toContain(`${WS}/.vscode`);
  });

  it("narrows .git and .yarn so git commit and yarn install still work", () => {
    const w = plan().config.filesystem.denyWrite;
    expect(w).toContain(`${WS}/.git/hooks`);
    expect(w).toContain(`${WS}/.git/config`);
    expect(w).not.toContain(`${WS}/.git`);
    expect(w).toContain(`${WS}/.yarn/releases`);
    expect(w).not.toContain(`${WS}/.yarn`);
  });

  it("covers the extra writable roots too", () => {
    const w = plan({ extraWritable: ["/srv/cache"] }).config.filesystem;
    expect(w.denyWrite).toContain("/srv/cache/.envrc");
    expect(w.denyWrite).toContain("/srv/cache/**/.husky");
  });

  it("write-protects locked paths, relative or absolute, even with protect-config off", () => {
    const p = plan({
      builtin: { "protect-config": false },
      lockedPaths: ["policy/rules.yaml", "/home/dev/.continuous/settings.json"],
    });
    expect(p.config.filesystem.denyWrite).toContain(`${WS}/policy/rules.yaml`);
    expect(p.config.filesystem.denyWrite).toContain(
      "/home/dev/.continuous/settings.json",
    );
    expect(p.config.filesystem.denyWrite).not.toContain(`${WS}/.husky`);
    expect(p.warnings.join(" ")).toContain("protect-config is off");
  });

  it("lists created-later as not enforced, and pre-creates only harmless placeholders", () => {
    expect(plan().notEnforced.map((n) => n.id)).toContain("created-later");
    expect(plan().precreate).toEqual([]);
    const pre = plan({ precreate: true }).precreate;
    expect(pre).toContain(`${WS}/.envrc`);
    expect(pre).not.toContain(`${WS}/.mcp.json`);
    expect(pre).not.toContain(`${WS}/.pre-commit-config.yaml`);
    expect(pre.every((p) => p.startsWith(`${WS}/`))).toBe(true);
  });
});

describe("rule 3: write scope", () => {
  it("is the workspace, the temp dir and the extra dirs", () => {
    expect(
      plan({ extraWritable: ["/srv/x"] }).config.filesystem.allowWrite,
    ).toEqual([WS, "/srv/x", "/tmp/continuous-run-1"].sort());
  });
});

describe("rule 4: network", () => {
  it("none gives no domains and drops the model host", () => {
    const p = plan({ egress: { network: "none", modelHost: "api.m.example" } });
    expect(p.config.network.allowedDomains).toEqual([]);
  });

  it("defaults to none without an egress policy", () => {
    expect(plan().config.network.allowedDomains).toEqual([]);
  });

  it("allowlist: model host from a URL plus presets, from the egress resolver", () => {
    const d = plan({
      egress: {
        network: "allowlist",
        allow: ["preset:npm", "*.corp.example:8443"],
        modelHost: "https://api.m.example/v1",
      },
    }).config.network.allowedDomains;
    expect(d).toContain("api.m.example");
    expect(d).toContain("registry.npmjs.org");
    expect(d).toContain("*.corp.example:8443");
  });

  it("open is a wildcard, weakened, and flagged", () => {
    const p = plan({ egress: { network: "open" } });
    expect(p.config.network.allowedDomains).toEqual(["*"]);
    expect(p.weakened).toEqual(["network-open"]);
    expect(p.warnings.join(" ")).toContain("network is open");
  });

  it("host: deny rules and the egress deny list become deniedDomains", () => {
    const p = plan({
      egress: {
        network: "allowlist",
        allow: ["a.example"],
        deny: ["bad.example"],
      },
      toolPermissions: {
        deny: [
          "runTerminalCommand(host:*.evil.example)",
          "runTerminalCommand(curl host:x.example)",
        ],
      },
    });
    expect(p.config.network.deniedDomains).toEqual([
      "*.evil.example",
      "bad.example",
      "x.example",
    ]);
    expect(p.warnings.join(" ")).toContain("every program");
  });

  it("a host glob srt cannot express is a conflict, unless there is no network", () => {
    const rule = "runTerminalCommand(host:*aliyuncs.com)";
    const r = failed({
      egress: { network: "allowlist", allow: ["a.example"] },
      toolPermissions: { deny: [rule] },
    });
    expect(r.conflicts[0].rule).toBe(rule);
    expect(plan({ toolPermissions: { deny: [rule] } }).ok).toBe(true);
  });

  it("net:private needs the egress proxy; metadata leans on srt's guard with a warning", () => {
    const on = { network: "allowlist", allow: ["a.example"] };
    const priv = { deny: ["runTerminalCommand(net:private)"] };
    expect(
      failed({ egress: on, toolPermissions: priv }).conflicts,
    ).toHaveLength(1);
    expect(
      plan({
        egress: { ...on, addressChecksByProxy: true },
        toolPermissions: priv,
      }).ok,
    ).toBe(true);
    expect(plan({ toolPermissions: priv }).ok).toBe(true);
    const meta = plan({
      egress: on,
      toolPermissions: { deny: ["runTerminalCommand(net:metadata)"] },
    });
    expect(meta.warnings.join(" ")).toContain("address guard");
    expect(
      failed({
        egress: on,
        toolPermissions: { deny: ["runTerminalCommand(net:nope)"] },
      }).ok,
    ).toBe(false);
  });

  it("an unknown mode or a bad entry fails closed", () => {
    expect(failed({ egress: { network: "mostly" } }).conflicts).toHaveLength(1);
    expect(
      failed({ egress: { network: "allowlist", allow: ["not a host"] } }).ok,
    ).toBe(false);
    expect(
      failed({ egress: { network: "allowlist", modelHost: "a b" } }).ok,
    ).toBe(false);
  });
});

describe("platforms and read policy", () => {
  it("wsl2 denies /mnt under both read policies", () => {
    for (const readPolicy of ["open", "workspace-only"] as const) {
      expect(
        plan({ platform: "wsl2", readPolicy }).config.filesystem.denyRead,
      ).toContain("/mnt");
    }
    expect(plan().config.filesystem.denyRead).not.toContain("/mnt");
    expect(plan({ platform: "wsl2" }).notEnforced.map((n) => n.id)).toEqual(
      expect.arrayContaining(["wsl-mnt-drives", "wsl-interop"]),
    );
  });

  it("wsl2 refuses a workspace on a Windows drive", () => {
    expect(
      failed({ platform: "wsl2", workspace: "/mnt/d/proj" }).conflicts[0].why,
    ).toContain("9p");
  });

  it("workspace-only denies the roots and allows the workspace back", () => {
    const f = plan({
      readPolicy: "workspace-only",
      extraReadable: ["/home/dev/.nvm"],
    }).config.filesystem;
    expect(f.denyRead).toEqual(
      expect.arrayContaining(["/home", "/root", "/run", "/var/run"]),
    );
    expect(f.allowRead).toEqual(
      expect.arrayContaining([WS, "/tmp/continuous-run-1", "/home/dev/.nvm"]),
    );
    expect(plan().notEnforced.map((n) => n.id)).toContain("open-reads");
    expect(
      plan({ readPolicy: "workspace-only" }).notEnforced.map((n) => n.id),
    ).not.toContain("open-reads");
  });

  it("macOS uses its own roots, keychains and the /private aliases", () => {
    const p = plan({
      platform: "macos",
      workspace: "/Users/dev/proj",
      homeDir: "/Users/dev",
      tempDir: "/var/folders/ab/T/run1",
      readPolicy: "workspace-only",
    });
    const f = p.config.filesystem;
    expect(f.denyRead).toEqual(
      expect.arrayContaining([
        "/Users",
        "/Volumes",
        "/Users/dev/Library/Keychains",
        "/Users/*/.ssh",
      ]),
    );
    expect(f.denyRead).not.toContain("/home");
    expect(f.allowWrite).toEqual(
      expect.arrayContaining([
        "/var/folders/ab/T/run1",
        "/private/var/folders/ab/T/run1",
      ]),
    );
    expect(p.notEnforced.map((n) => n.id)).toContain("macos-seatbelt");
  });

  it("refuses unknown platforms, Windows paths and glob characters", () => {
    expect(failed({ platform: "windows" as never }).reasons.join()).toContain(
      "platform",
    );
    expect(failed({ workspace: "C:\\proj" }).reasons.join()).toContain("POSIX");
    expect(failed({ workspace: "/home/dev/pr[o]j" }).reasons.join()).toContain(
      "glob",
    );
    expect(failed({ readPolicy: "x" as never }).ok).toBe(false);
    expect(
      failed({ levels: { ...DEFAULT_POLICY_LEVELS, tools: "wild" as never } })
        .ok,
    ).toBe(false);
    expect(failed({ builtin: { typo: true } as never }).ok).toBe(false);
  });
});

describe("conflicts and fail closed", () => {
  it.each([
    ["system temp root", { tempDir: "/tmp" }],
    ["root", { extraWritable: ["/"] }],
    ["home", { extraWritable: ["/home/dev"] }],
    ["parent of home", { extraWritable: ["/home"] }],
    ["system dir", { extraWritable: ["/etc/foo"] }],
    ["secret dir", { extraWritable: ["/home/dev/.ssh"] }],
    [
      "workspace inside a denied dir",
      { workspace: "/home/dev/.continuous/ws" },
    ],
    [
      "workspace inside a deny rule",
      { toolPermissions: { deny: ["readFile(/home/dev/proj)"] } },
    ],
    ["unreadable deny rule", { toolPermissions: { deny: ["((("] } }],
    ["unsupported glob", { toolPermissions: { deny: ["readFile(src/[ab])"] } }],
    [
      "first-component wildcard",
      { toolPermissions: { deny: ["readFile(/*/x)"] } },
    ],
  ] as const)("%s", (_n, over) => {
    const r = failed(over as Partial<SandboxCompileInput>);
    expect(r.ok).toBe(false);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it("never throws on garbage", () => {
    for (const bad of [null, undefined, 5, {}, { workspace: 1 }]) {
      const r = compileSandboxConfig(bad as never);
      expect(r.ok).toBe(false);
    }
  });
});

describe("describeSandboxPlan", () => {
  it("states what is and is not enforced, without the word contained as a claim", () => {
    const text = describeSandboxPlan(plan()).join("\n");
    expect(text).toContain("Enforced by the OS layer, as configured");
    expect(text).toContain("Not enforced");
    expect(text).toContain("Contained only after our probes say so");
    expect(text).not.toMatch(/\bis contained\b/);
  });

  it("shows a refusal and a weakened network", () => {
    expect(
      describeSandboxPlan(failed({ tempDir: "/tmp" })).join("\n"),
    ).toContain("REFUSED");
    expect(
      describeSandboxPlan(plan({ egress: { network: "open" } })).join("\n"),
    ).toContain("WEAKENED");
  });
});

describe("sandboxAutoApproval", () => {
  const ok = plan();
  const ask: AreaDecision = {
    policy: "allowedWithPermission",
    source: "tool-setting",
  };
  const run = (
    over: Partial<{
      level: PolicyLevel;
      d: AreaDecision;
      p: ReturnType<typeof compileSandboxConfig>;
      verified: boolean;
      touched: string[] | null | undefined;
      minLevel: PolicyLevel;
    }> = {},
  ) =>
    sandboxAutoApproval(
      over.level ?? "automatic",
      over.d ?? ask,
      over.p ?? ok,
      {
        verified: over.verified ?? true,
        touchedPaths:
          "touched" in over ? over.touched : [`${WS}/src/a.ts`, "src/b.ts"],
        minLevel: over.minLevel,
      },
    );

  it("allows a confined, verified, in-scope command that only the tool setting asked about", () => {
    const r = run();
    expect(r.allowWithoutAsk).toBe(true);
    expect(r.reason).toContain("verified by our probes");
  });

  it("is conservative by default", () => {
    expect(run({ verified: false }).allowWithoutAsk).toBe(false);
    expect(
      run({ verified: undefined as never, touched: [] }).allowWithoutAsk,
    ).toBe(true);
    expect(
      sandboxAutoApproval("automatic", ask, ok, {
        verified: 1 as never,
        touchedPaths: [],
      }).allowWithoutAsk,
    ).toBe(false);
    expect(run({ touched: undefined }).allowWithoutAsk).toBe(false);
    expect(run({ touched: null }).allowWithoutAsk).toBe(false);
    expect(run({ level: "cautious" }).allowWithoutAsk).toBe(false);
    expect(run({ level: "manual", minLevel: "manual" }).allowWithoutAsk).toBe(
      false,
    );
    expect(
      run({ level: "cautious", minLevel: "cautious" }).allowWithoutAsk,
    ).toBe(true);
  });

  it("refuses a failed or weakened or conflicted plan", () => {
    expect(run({ p: failed({ tempDir: "/tmp" }) }).allowWithoutAsk).toBe(false);
    expect(
      run({ p: plan({ egress: { network: "open" } }) }).allowWithoutAsk,
    ).toBe(false);
    expect(
      run({ p: { ...ok, conflicts: [{ rule: "x", why: "y" }] } })
        .allowWithoutAsk,
    ).toBe(false);
  });

  it.each([
    ["outside the scope", ["/etc/hosts"]],
    ["outside via ..", [`${WS}/../other/x`]],
    ["a secret", [`${WS}/.env`]],
    ["a secret in a subdirectory", ["sub/dir/id_rsa"]],
    ["a hook", [`${WS}/.git/hooks/pre-commit`]],
    ["a nested config dir", ["a/b/.vscode/tasks.json"]],
    ["a locked/own path", ["~/.continuous/x"]],
    ["a variable", ["$HOME/x"]],
    ["a glob", ["src/*.ts"]],
    ["a Windows path", ["C:\\x"]],
  ])("touching %s is not loosened", (_n, touched) => {
    expect(run({ touched }).allowWithoutAsk).toBe(false);
  });

  it("allows /dev/null and no paths at all", () => {
    expect(run({ touched: ["/dev/null"] }).allowWithoutAsk).toBe(true);
    expect(run({ touched: [] }).allowWithoutAsk).toBe(true);
  });

  it("floors, rules, protections and disabled tools win at every level (property)", () => {
    const sources: DecisionSource[] = [
      "deny-rule",
      "ask-rule",
      "protected-path",
      "floor",
      "safety-floor",
      "manual",
      "allow-rule",
      "permissive",
      "idgaf",
    ];
    for (const level of POLICY_LEVELS) {
      for (const source of sources) {
        if (
          source === "allow-rule" ||
          source === "permissive" ||
          source === "idgaf"
        )
          continue;
        const r = run({
          level,
          d: { policy: "allowedWithPermission", source },
        });
        expect(r.allowWithoutAsk, `${level}/${source}`).toBe(false);
      }
      expect(
        run({
          level,
          d: {
            policy: "allowedWithPermission",
            source: "tool-setting",
            protection: "secret",
          },
        }).allowWithoutAsk,
      ).toBe(false);
      expect(
        run({ level, d: { policy: "allowedWithPermission" } }).allowWithoutAsk,
      ).toBe(false);
      expect(
        run({ level, d: { policy: "disabled", source: "tool-setting" } })
          .allowWithoutAsk,
      ).toBe(false);
    }
  });

  it("does nothing when the policy already allows", () => {
    expect(
      run({ d: { policy: "allowedWithoutPermission" } }).allowWithoutAsk,
    ).toBe(true);
  });
});
