import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  isStartupOnlyEnvKey,
  mcpStdioEnv,
  readDotEnvFile,
  shellChildEnv,
} from "./childEnv.js";

describe("isStartupOnlyEnvKey", () => {
  it.each([
    "BASH_ENV",
    "ENV",
    "ZDOTDIR",
    "NODE_OPTIONS",
    "NODE_PATH",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "PATH",
    "PYTHONPATH",
    "PYTHONSTARTUP",
    "PERL5OPT",
    "RUBYOPT",
    "GIT_SSH_COMMAND",
  ])("treats %s as fixed at process start", (key) => {
    expect(isStartupOnlyEnvKey(key)).toBe(true);
  });

  it("leaves ordinary names alone", () => {
    expect(isStartupOnlyEnvKey("HOME")).toBe(false);
    expect(isStartupOnlyEnvKey("ANTHROPIC_API_KEY")).toBe(false);
  });
});

describe("shellChildEnv", () => {
  const baseline = {
    PATH: "/usr/bin",
    HOME: "/home/me",
    BASH_ENV: "/home/me/startup.sh",
    USER: "me",
  };

  it("keeps ordinary variables and the startup value of control variables", () => {
    const env = shellChildEnv(
      {
        ...baseline,
        PATH: "/tmp/other:/usr/bin",
        BASH_ENV: "/tmp/other.sh",
        NODE_OPTIONS: "--require /tmp/hook.js",
        LD_PRELOAD: "/tmp/lib.so",
        DYLD_INSERT_LIBRARIES: "/tmp/lib.dylib",
        ZDOTDIR: "/tmp/zdot",
        ENV: "/tmp/shenv",
        FROM_SESSION: "kept",
      },
      baseline,
    );

    expect(env.PATH).toBe("/usr/bin");
    expect(env.BASH_ENV).toBe("/home/me/startup.sh");
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.DYLD_INSERT_LIBRARIES).toBeUndefined();
    expect(env.ZDOTDIR).toBeUndefined();
    expect(env.ENV).toBeUndefined();
    expect(env.HOME).toBe("/home/me");
    expect(env.FROM_SESSION).toBe("kept");
  });

  it("does not pass a control variable that was absent at startup", () => {
    const env = shellChildEnv(
      { PATH: "/tmp/other", NODE_PATH: "/tmp/modules" },
      { PATH: "/usr/bin" },
    );
    expect(env.PATH).toBe("/usr/bin");
    expect(env.NODE_PATH).toBeUndefined();
  });
});

describe("mcpStdioEnv", () => {
  const baseline = { PATH: "/usr/bin", HOME: "/home/me", USER: "me" };
  const current = {
    ...baseline,
    PATH: "/tmp/other:/usr/bin",
    NODE_OPTIONS: "--require /tmp/hook.js",
    BASH_ENV: "/tmp/setup.sh",
    LD_PRELOAD: "/tmp/lib.so",
    FROM_SESSION: "kept",
  };

  it("drops control variables from the process and keeps the server's own env", () => {
    const env = mcpStdioEnv({ EXPLICIT: "yes" }, current, baseline);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.BASH_ENV).toBeUndefined();
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.HOME).toBe("/home/me");
    expect(env.FROM_SESSION).toBe("kept");
    expect(env.EXPLICIT).toBe("yes");
  });

  it("lets the server configuration set a control variable on purpose", () => {
    const env = mcpStdioEnv(
      { NODE_OPTIONS: "--use-system-ca" },
      current,
      baseline,
    );
    expect(env.NODE_OPTIONS).toBe("--use-system-ca");
  });
});

describe("global env file helpers", () => {
  it("parses a file and treats a missing file as empty", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-dotenv-"));
    try {
      const file = path.join(dir, ".env");
      fs.writeFileSync(file, 'export SOME_SETTING="https://files.example/"\n');
      expect(readDotEnvFile(file).SOME_SETTING).toBe("https://files.example/");
      expect(readDotEnvFile(path.join(dir, "missing.env"))).toEqual({});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("child processes", () => {
  it("does not let a later PATH hide the startup executables", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-path-"));
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "echo"), "#!/bin/sh\necho pwned\n", {
      mode: 0o755,
    });
    try {
      const baseline = { ...process.env, PATH: process.env.PATH };
      const current = {
        ...baseline,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      };
      const result = spawnSync("echo", ["ok"], {
        env: shellChildEnv(current, baseline),
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("ok");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32" || !fs.existsSync("/bin/bash"))(
    "does not source a shell startup file named after process start",
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-bash-"));
      const marker = path.join(dir, "marker");
      const script = path.join(dir, "setup.sh");
      fs.writeFileSync(script, `echo ran > '${marker}'\n`);
      try {
        const baseline = { ...process.env };
        delete baseline.BASH_ENV;
        const current = { ...baseline, BASH_ENV: script };
        const result = spawnSync("/bin/bash", ["-c", "echo ok"], {
          env: shellChildEnv(current, baseline),
          encoding: "utf8",
        });
        expect(result.status).toBe(0);
        expect(result.stdout.trim()).toBe("ok");
        expect(fs.existsSync(marker)).toBe(false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("does not pass a node startup option that appeared after process start", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-node-"));
    const marker = path.join(dir, "marker");
    const hook = path.join(dir, "hook.cjs");
    fs.writeFileSync(
      hook,
      `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
    );
    try {
      const baseline = { ...process.env };
      delete baseline.NODE_OPTIONS;
      const current = { ...baseline, NODE_OPTIONS: `--require ${hook}` };
      const env = mcpStdioEnv(undefined, current, baseline);
      expect(env.NODE_OPTIONS ?? "").not.toContain(hook);
      const result = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
        env,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
